import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'

export const dailyEntryUpgradeRouter = Router()

export { dateOnly, isoDate, effectiveSource, hoursFromTimes }

const ATTENDANCE_STATUSES = ['normal', 'late', 'early_leave', 'leave', 'absence', 'substitute']

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[daily-entry-upgrade]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function canStore(user, storeId) {
  if (!user || user.role === 'public') return false
  if (user.role === 'developer') return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeId)
}

async function ensureStore(key) {
  const existing = await prisma.store.findUnique({ where: { key } })
  if (existing) return existing
  return prisma.store.create({ data: { key, name: key, district: '' } })
}

function dateOnly(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError('日期格式应为 YYYY-MM-DD')
  return new Date(`${text}T00:00:00.000Z`)
}

function isoDate(value) {
  if (!value) return ''
  return new Date(value).toISOString().slice(0, 10)
}

function effectiveSource(store, dateStr) {
  if (store.salesDataSource === 'manual') return 'manual'
  const eff = store.salesDataSourceEffectiveDate ? isoDate(store.salesDataSourceEffectiveDate) : ''
  if (eff && dateStr < eff) return 'manual'
  return store.salesDataSource
}

function hoursFromTimes(start, end, breakMinutes) {
  if (!/^\d{1,2}:\d{2}$/.test(String(start || '')) || !/^\d{1,2}:\d{2}$/.test(String(end || ''))) return 0
  const toMin = (value) => {
    const [h, m] = String(value).split(':').map(Number)
    return h * 60 + m
  }
  let minutes = toMin(end) - toMin(start)
  if (minutes < 0) minutes += 24 * 60
  const breaks = Math.max(0, Number(breakMinutes) || 0)
  const hours = Math.max(0, (minutes - breaks) / 60)
  return Math.round(hours * 100) / 100
}

async function writeAudit(tx, input) {
  await tx.dailyEntryAuditLog.create({
    data: {
      id: `audit-${crypto.randomUUID()}`,
      storeId: input.storeId,
      date: dateOnly(input.date),
      module: input.module || '',
      fieldName: input.fieldName || '',
      beforeValue: input.beforeValue === undefined ? null : input.beforeValue,
      afterValue: input.afterValue === undefined ? null : input.afterValue,
      reason: input.reason || '',
      operatorId: input.operatorId || '',
      operatorName: input.operatorName || '',
    },
  })
}

async function aggregatePosDay(storeId, dateStr) {
  const orders = await prisma.order.findMany({
    where: { storeId, businessDate: dateOnly(dateStr), status: { not: 'cancelled' } },
    include: { payments: true, refunds: true },
  })
  let originalSales = 0n
  let effectiveSales = 0n
  let refundAmount = 0n
  let discountAmount = 0n
  let orderCount = 0
  const byChannel = { wechat: 0n, alipay: 0n, cash: 0n, other: 0n }
  for (const order of orders) {
    originalSales += order.subtotal
    discountAmount += order.discountAmount
    effectiveSales += order.payableAmount
    orderCount += 1
    for (const refund of order.refunds || []) {
      if (refund.status === 'completed') refundAmount += refund.refundAmount
    }
    for (const pay of order.payments || []) {
      if (['success', 'partially_refunded', 'refunded'].includes(pay.status)) {
        const key = ['wechat', 'alipay', 'cash'].includes(pay.channel) ? pay.channel : 'other'
        byChannel[key] += pay.amount
      }
    }
  }
  const effectiveAfterRefund = effectiveSales - refundAmount
  const toStr = (value) => value.toString()
  return {
    status: 'synced',
    syncedAt: new Date().toISOString(),
    originalSales: toStr(originalSales),
    effectiveSales: toStr(effectiveSales),
    effectiveAfterRefund: toStr(effectiveAfterRefund),
    refundAmount: toStr(refundAmount),
    discountAmount: toStr(discountAmount),
    orderCount,
    avgOrderCents: toStr(orderCount > 0 ? effectiveAfterRefund / BigInt(orderCount) : 0n),
    byChannel: Object.fromEntries(Object.entries(byChannel).map(([key, value]) => [key, toStr(value)])),
  }
}

function serializeEntry(entry) {
  if (!entry) return null
  return {
    id: entry.id,
    storeKey: entry.storeKey,
    date: isoDate(entry.date),
    incCents: entry.incCents.toString(),
    ord: entry.ord,
    staffNames: entry.staffNames || [],
    status: entry.status,
    salesDataStatus: entry.salesDataStatus,
    posSyncAt: entry.posSyncAt,
    hybridAdjustmentCents: entry.hybridAdjustmentCents.toString(),
    hybridAdjustmentNote: entry.hybridAdjustmentNote,
    confirmedAt: entry.confirmedAt,
    confirmedBy: entry.confirmedBy,
    version: entry.version,
    updatedBy: entry.updatedBy,
    updatedAt: entry.updatedAt,
  }
}

function serializeStaff(row) {
  return {
    id: row.id,
    staffId: row.staffId,
    staffName: row.staffNameSnapshot,
    shiftId: row.shiftId,
    scheduledStartTime: row.scheduledStartTime,
    scheduledEndTime: row.scheduledEndTime,
    actualStartTime: row.actualStartTime,
    actualEndTime: row.actualEndTime,
    breakMinutes: row.breakMinutes,
    scheduledHours: row.scheduledHours,
    actualHours: row.actualHours,
    attendanceStatus: row.attendanceStatus,
    source: row.source,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  }
}

dailyEntryUpgradeRouter.get('/daily-entry/overview', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.query.store || '').trim()
  const dateStr = String(req.query.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  const store = await ensureStore(storeKey)
  const source = effectiveSource(store, dateStr)
  const d = dateOnly(dateStr)
  const [entry, staff] = await Promise.all([
    prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } }),
    prisma.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: d }, orderBy: [{ staffNameSnapshot: 'asc' }] }),
  ])
  let pos = null
  let salesDataStatus = 'waiting_input'
  if (source === 'manual') {
    salesDataStatus = entry ? 'synced' : 'waiting_input'
  } else {
    try {
      pos = await aggregatePosDay(storeKey, dateStr)
      salesDataStatus = 'synced'
    } catch (error) {
      console.error('[daily-entry-pos-aggregate]', error.message)
      salesDataStatus = 'sync_failed'
    }
  }
  res.json({
    storeKey,
    date: dateStr,
    salesDataSource: source,
    storeConfig: {
      salesDataSource: store.salesDataSource,
      salesDataSourceEffectiveDate: isoDate(store.salesDataSourceEffectiveDate),
    },
    salesDataStatus,
    pos,
    entry: serializeEntry(entry),
    staff: staff.map(serializeStaff),
  })
}))

dailyEntryUpgradeRouter.put('/store-sales-source', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user?.role !== 'developer') throw httpError('仅管理员可修改门店销售数据来源', 403)
  const storeKey = String(req.body?.storeKey || '').trim()
  const salesDataSource = String(req.body?.salesDataSource || '').trim()
  const effectiveDate = String(req.body?.effectiveDate || '').trim()
  if (!storeKey || !['manual', 'pos', 'hybrid'].includes(salesDataSource)) throw httpError('门店或销售数据来源不正确')
  if (effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw httpError('生效日期格式应为 YYYY-MM-DD')
  const store = await ensureStore(storeKey)
  const before = {
    salesDataSource: store.salesDataSource,
    effectiveDate: isoDate(store.salesDataSourceEffectiveDate),
  }
  const after = {
    salesDataSource,
    effectiveDate: effectiveDate || '',
  }
  await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { key: storeKey },
      data: {
        salesDataSource,
        ...(effectiveDate
          ? { salesDataSourceEffectiveDate: dateOnly(effectiveDate) }
          : { salesDataSourceEffectiveDate: null }),
      },
    })
    await writeAudit(tx, {
      storeId: storeKey,
      date: effectiveDate || new Date().toISOString().slice(0, 10),
      module: 'store_config',
      fieldName: 'sales_data_source',
      beforeValue: before,
      afterValue: after,
      reason: String(req.body?.reason || '').slice(0, 300),
      operatorId: req.user.id,
      operatorName: req.user.username,
    })
  })
  res.json({ ok: true, storeKey, salesDataSource, effectiveDate: effectiveDate || '' })
}))

dailyEntryUpgradeRouter.get('/store-sales-sources', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user?.role !== 'developer') throw httpError('仅管理员可查看门店销售数据来源', 403)
  const rows = await prisma.store.findMany({ orderBy: { name: 'asc' } })
  res.json({
    rows: rows.map((row) => ({
      storeKey: row.key,
      storeName: row.name,
      salesDataSource: row.salesDataSource,
      salesDataSourceEffectiveDate: isoDate(row.salesDataSourceEffectiveDate),
    })),
  })
}))

async function posScopeStores(req, storeParam) {
  if (storeParam && !canStore(req.user, storeParam)) throw httpError('无权限', 403)
  const stores = await prisma.store.findMany({ where: storeParam ? { key: storeParam } : {} })
  if (req.user.role !== 'developer') {
    const allowed = new Set(req.user.storeKeys || [])
    return stores.filter((store) => allowed.has(store.key))
  }
  return stores
}

dailyEntryUpgradeRouter.get('/pos/daily-summary', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const stores = await posScopeStores(req, String(req.query.store || '').trim())
  if (stores.length === 0) return res.json({ rows: [] })
  const storeIds = stores.map((store) => store.key)
  const [orders, entries] = await Promise.all([
    prisma.order.findMany({
      where: { storeId: { in: storeIds }, businessDate: { not: null }, status: { not: 'cancelled' } },
      include: { payments: true, refunds: true },
    }),
    prisma.dailyEntry.findMany({ where: { storeKey: { in: storeIds } } }),
  ])
  const storeMap = new Map(stores.map((store) => [store.key, store]))
  const entryMap = new Map(entries.map((entry) => [`${entry.storeKey}|${isoDate(entry.date)}`, entry]))
  const groups = new Map()
  for (const order of orders) {
    const dateStr = isoDate(order.businessDate)
    const store = storeMap.get(order.storeId)
    if (!store || effectiveSource(store, dateStr) === 'manual') continue
    const key = `${order.storeId}|${dateStr}`
    const group = groups.get(key) || {
      storeId: order.storeId,
      date: dateStr,
      originalSales: 0n,
      effectiveSales: 0n,
      refundAmount: 0n,
      discountAmount: 0n,
      orderCount: 0,
      byChannel: { wechat: 0n, alipay: 0n, cash: 0n, other: 0n },
    }
    group.originalSales += order.subtotal
    group.effectiveSales += order.payableAmount
    group.discountAmount += order.discountAmount
    group.orderCount += 1
    for (const refund of order.refunds || []) {
      if (refund.status === 'completed') group.refundAmount += refund.refundAmount
    }
    for (const pay of order.payments || []) {
      if (['success', 'partially_refunded', 'refunded'].includes(pay.status)) {
        const channel = ['wechat', 'alipay', 'cash'].includes(pay.channel) ? pay.channel : 'other'
        group.byChannel[channel] += pay.amount
      }
    }
    groups.set(key, group)
  }
  const toStr = (value) => value.toString()
  const rows = [...groups.values()].map((group) => {
    const adjustment = entryMap.get(`${group.storeId}|${group.date}`)?.hybridAdjustmentCents || 0n
    const effective = group.effectiveSales - group.refundAmount + adjustment
    return {
      storeKey: group.storeId,
      date: group.date,
      incCents: toStr(effective),
      ord: group.orderCount,
      refundCents: toStr(group.refundAmount),
      discountCents: toStr(group.discountAmount),
      avgCents: toStr(group.orderCount > 0 ? effective / BigInt(group.orderCount) : 0n),
      byChannel: Object.fromEntries(Object.entries(group.byChannel).map(([key, value]) => [key, toStr(value)])),
    }
  })
  res.json({ rows })
}))

dailyEntryUpgradeRouter.get('/pos/product-sales', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const stores = await posScopeStores(req, String(req.query.store || '').trim())
  if (stores.length === 0) return res.json({ rows: [] })
  const storeIds = stores.map((store) => store.key)
  const storeMap = new Map(stores.map((store) => [store.key, store]))
  const items = await prisma.orderItem.findMany({
    where: { order: { storeId: { in: storeIds }, businessDate: { not: null }, status: { not: 'cancelled' } } },
    include: { order: { select: { storeId: true, businessDate: true } } },
  })
  const map = new Map()
  for (const item of items) {
    const dateStr = isoDate(item.order.businessDate)
    const store = storeMap.get(item.order.storeId)
    if (!store || effectiveSource(store, dateStr) === 'manual') continue
    const key = `${item.order.storeId}|${item.productId}`
    const current = map.get(key) || {
      storeKey: item.order.storeId,
      date: dateStr,
      productId: item.productId,
      name: item.productNameSnapshot,
      sku: item.skuSnapshot,
      quantity: 0,
      amountCents: 0n,
    }
    current.quantity += item.quantity
    current.amountCents += item.actualAmount || 0n
    map.set(key, current)
  }
  res.json({
    rows: [...map.values()].map((row) => ({
      storeKey: row.storeKey,
      date: row.date,
      productId: row.productId,
      name: row.name,
      sku: row.sku,
      quantity: row.quantity,
      amountCents: row.amountCents.toString(),
    })),
  })
}))

dailyEntryUpgradeRouter.put('/daily-staff', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  if (items.length > 100) throw httpError('值班人员不能超过 100 人')
  const d = dateOnly(dateStr)
  const existingEntry = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
  if (existingEntry?.status === 'confirmed' && !['developer', 'manager'].includes(req.user.role)) {
    throw httpError('日报已确认，普通员工不可修改值班人员', 409)
  }
  await ensureStore(storeKey)

  const parsed = items.map((item) => {
    const staffId = String(item.staffId || '').trim()
    const staffName = String(item.staffName || '').trim().slice(0, 50)
    if (!staffId || !staffName) throw httpError('值班人员姓名/ID 不正确')
    const attendanceStatus = String(item.attendanceStatus || 'normal')
    if (!ATTENDANCE_STATUSES.includes(attendanceStatus)) throw httpError('出勤状态不正确')
    const breakMinutes = Number(item.breakMinutes)
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 600) throw httpError('休息分钟数不正确')
    const actualStartTime = String(item.actualStartTime || '').slice(0, 5)
    const actualEndTime = String(item.actualEndTime || '').slice(0, 5)
    const scheduledStartTime = String(item.scheduledStartTime || '').slice(0, 5)
    const scheduledEndTime = String(item.scheduledEndTime || '').slice(0, 5)
    const providedHours = item.actualHours != null && item.actualHours !== '' && Number.isFinite(Number(item.actualHours))
    const actualHours = providedHours
      ? Math.max(0, Math.min(24, Math.round(Number(item.actualHours) * 100) / 100))
      : hoursFromTimes(actualStartTime, actualEndTime, breakMinutes)
    return {
      staffId, staffName, attendanceStatus, breakMinutes,
      actualStartTime, actualEndTime, scheduledStartTime, scheduledEndTime,
      actualHours, scheduledHours: Math.max(0, Number(item.scheduledHours) || 0),
    }
  })

  const submitted = new Set(parsed.map((item) => item.staffId))
  const rows = await prisma.$transaction(async (tx) => {
    const existing = await tx.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: d } })
    const byId = new Map(existing.map((row) => [row.staffId, row]))
    const results = []
    for (const item of parsed) {
      const before = byId.get(item.staffId)
      const data = {
        staffNameSnapshot: item.staffName,
        shiftId: String(before?.shiftId || ''),
        scheduledStartTime: item.scheduledStartTime || before?.scheduledStartTime || '',
        scheduledEndTime: item.scheduledEndTime || before?.scheduledEndTime || '',
        actualStartTime: item.actualStartTime,
        actualEndTime: item.actualEndTime,
        breakMinutes: item.breakMinutes,
        scheduledHours: item.scheduledHours,
        actualHours: item.actualHours,
        attendanceStatus: item.attendanceStatus,
        source: before?.source || 'manual',
        updatedBy: req.user.username,
        updatedAt: new Date(),
      }
      const saved = await tx.dailyStoreStaff.upsert({
        where: { storeId_date_staffId: { storeId: storeKey, date: d, staffId: item.staffId } },
        update: data,
        create: {
          id: `dss-${crypto.randomUUID()}`,
          storeId: storeKey,
          date: d,
          staffId: item.staffId,
          createdBy: req.user.username,
          ...data,
        },
      })
      if (!before || JSON.stringify(before) !== JSON.stringify(saved)) {
        await writeAudit(tx, {
          storeId: storeKey,
          date: dateStr,
          module: 'daily_staff',
          fieldName: 'staff_record',
          beforeValue: before ? serializeStaff(before) : null,
          afterValue: serializeStaff(saved),
          reason: String(req.body?.reason || '值班人员确认').slice(0, 300),
          operatorId: req.user.id,
          operatorName: req.user.username,
        })
      }
      results.push(saved)
    }
    const removed = existing.filter((row) => !submitted.has(row.staffId))
    for (const row of removed) {
      await writeAudit(tx, {
        storeId: storeKey,
        date: dateStr,
        module: 'daily_staff',
        fieldName: 'staff_record',
        beforeValue: serializeStaff(row),
        afterValue: null,
        reason: '删除值班人员',
        operatorId: req.user.id,
        operatorName: req.user.username,
      })
      await tx.dailyStoreStaff.delete({ where: { id: row.id } })
    }
    // 兼容旧字段：同步 staffNames 镜像（不覆盖 confirmed 状态）
    if (results.length > 0 || removed.length > 0) {
      const staffNames = results.map((row) => row.staffNameSnapshot)
      const entry = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
      if (entry) {
        await tx.dailyEntry.update({
          where: { id: entry.id },
          data: { staffNames: staffNames, updatedBy: req.user.username, version: { increment: 1 } },
        })
      } else {
        await tx.dailyEntry.create({
          data: {
            id: `de-${crypto.randomUUID()}`,
            storeKey,
            date: d,
            staffNames: staffNames,
            updatedBy: req.user.username,
            status: 'draft',
            salesDataStatus: 'not_applicable',
          },
        })
      }
    }
    return results
  })
  res.json({ ok: true, rows: rows.map(serializeStaff) })
}))

dailyEntryUpgradeRouter.post('/daily-entry/confirm', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  const store = await ensureStore(storeKey)
  const d = dateOnly(dateStr)
  const source = effectiveSource(store, dateStr)
  const entry = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
  const staffCount = await prisma.dailyStoreStaff.count({ where: { storeId: storeKey, date: d } })
  if (staffCount === 0) throw httpError('请先填写并保存实际值班人员', 400)
  if (source === 'manual' && (!entry || (entry.incCents <= 0n && entry.ord <= 0))) {
    throw httpError('请先录入当日营业数据', 400)
  }
  const salesDataStatus = source === 'manual' ? (entry ? 'synced' : 'waiting_input') : 'synced'
  const saved = await prisma.$transaction(async (tx) => {
    const before = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
    const row = await tx.dailyEntry.upsert({
      where: { storeKey_date: { storeKey, date: d } },
      update: {
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedBy: req.user.username,
        salesDataStatus,
        posSyncAt: source === 'manual' ? undefined : new Date(),
        version: { increment: 1 },
        updatedBy: req.user.username,
      },
      create: {
        id: `de-${crypto.randomUUID()}`,
        storeKey,
        date: d,
        staffNames: [],
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedBy: req.user.username,
        salesDataStatus,
        posSyncAt: source === 'manual' ? null : new Date(),
        updatedBy: req.user.username,
      },
    })
    await writeAudit(tx, {
      storeId: storeKey,
      date: dateStr,
      module: 'daily_status',
      fieldName: 'status',
      beforeValue: before ? serializeEntry(before) : null,
      afterValue: serializeEntry(row),
      reason: String(req.body?.reason || '确认今日营业数据').slice(0, 300),
      operatorId: req.user.id,
      operatorName: req.user.username,
    })
    return row
  })
  res.json({ ok: true, entry: serializeEntry(saved) })
}))

dailyEntryUpgradeRouter.post('/daily-entry/unconfirm', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!['developer', 'manager'].includes(req.user?.role)) throw httpError('无权限', 403)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  const d = dateOnly(dateStr)
  const saved = await prisma.$transaction(async (tx) => {
    const before = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
    const row = await tx.dailyEntry.upsert({
      where: { storeKey_date: { storeKey, date: d } },
      update: {
        status: 'draft',
        confirmedAt: null,
        confirmedBy: '',
        version: { increment: 1 },
        updatedBy: req.user.username,
      },
      create: {
        id: `de-${crypto.randomUUID()}`,
        storeKey,
        date: d,
        staffNames: [],
        status: 'draft',
        updatedBy: req.user.username,
      },
    })
    await writeAudit(tx, {
      storeId: storeKey,
      date: dateStr,
      module: 'daily_status',
      fieldName: 'status',
      beforeValue: before ? serializeEntry(before) : null,
      afterValue: serializeEntry(row),
      reason: String(req.body?.reason || '取消确认').slice(0, 300),
      operatorId: req.user.id,
      operatorName: req.user.username,
    })
    return row
  })
  res.json({ ok: true, entry: serializeEntry(saved) })
}))

dailyEntryUpgradeRouter.post('/daily-entry/adjust', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!['developer', 'manager'].includes(req.user?.role)) throw httpError('无权限', 403)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  const store = await ensureStore(storeKey)
  if (effectiveSource(store, dateStr) !== 'hybrid') throw httpError('仅混合模式门店可调整营业数据', 409)
  const adjustmentCents = Number(req.body?.adjustmentCents)
  if (!Number.isInteger(adjustmentCents) || adjustmentCents < -999999999999 || adjustmentCents > 999999999999) {
    throw httpError('调整金额不正确（单位：分）')
  }
  const d = dateOnly(dateStr)
  const saved = await prisma.$transaction(async (tx) => {
    const before = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
    const row = await tx.dailyEntry.upsert({
      where: { storeKey_date: { storeKey, date: d } },
      update: {
        hybridAdjustmentCents: BigInt(adjustmentCents),
        hybridAdjustmentNote: String(req.body?.note || '').slice(0, 300),
        version: { increment: 1 },
        updatedBy: req.user.username,
      },
      create: {
        id: `de-${crypto.randomUUID()}`,
        storeKey,
        date: d,
        staffNames: [],
        hybridAdjustmentCents: BigInt(adjustmentCents),
        hybridAdjustmentNote: String(req.body?.note || '').slice(0, 300),
        updatedBy: req.user.username,
      },
    })
    await writeAudit(tx, {
      storeId: storeKey,
      date: dateStr,
      module: 'sales_hybrid_adjustment',
      fieldName: 'hybrid_adjustment_cents',
      beforeValue: before ? serializeEntry(before) : null,
      afterValue: serializeEntry(row),
      reason: String(req.body?.reason || '营业数据调整').slice(0, 300),
      operatorId: req.user.id,
      operatorName: req.user.username,
    })
    return row
  })
  res.json({ ok: true, entry: serializeEntry(saved) })
}))
