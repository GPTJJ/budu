import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { buildRecognizedRevenueWhere, httpError } from './pos-core.js'
import { resolveStoreName } from './store-names.js'
import { isSuperUser } from '../shared/accountPermissions.js'
import { isFixedStoreKey } from '../shared/storeDirectory.js'

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
  if (isSuperUser(user)) return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeId)
}

async function ensureStore(key) {
  if (!isFixedStoreKey(key)) throw httpError('门店不存在或已停用', 400)
  const existing = await prisma.store.findUnique({ where: { key } })
  if (existing) return existing
  return prisma.store.create({ data: { key, name: resolveStoreName(key), district: '' } })
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
  const businessDate = dateOnly(dateStr)
  const [orders, refunds] = await Promise.all([
    prisma.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId, businessDate }),
      include: { payments: true },
    }),
    prisma.refund.findMany({
      where: { status: 'completed', order: { is: { storeId, businessDate } } },
      select: { refundAmount: true },
    }),
  ])
  let originalSales = 0n
  let effectiveSales = 0n
  const refundAmount = refunds.reduce((sum, refund) => sum + refund.refundAmount, 0n)
  let discountAmount = 0n
  let orderCount = 0
  const byChannel = { wechat: 0n, alipay: 0n, cash: 0n, other: 0n }
  for (const order of orders) {
    originalSales += order.subtotal
    discountAmount += order.discountAmount
    effectiveSales += order.payableAmount
    orderCount += 1
    for (const pay of order.payments || []) {
      if (pay.status === 'success') {
        const key = ['wechat', 'alipay', 'cash'].includes(pay.channel) ? pay.channel : 'other'
        byChannel[key] += pay.amount
      }
    }
  }
  // 已退款订单已整体排除，不能再次从干净订单营收中扣减。
  const effectiveAfterRefund = effectiveSales
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
    employeeId: row.employeeId || '',
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

/**
 * Gate 12：按月批量读取 DailyStoreStaff（只读数据基础，供未来 payroll 计算）。
 * - month=YYYY-MM 必填（有界窗口，禁止全量下载历史）
 * - store 可选（与现有 canStore 授权一致）
 * - 返回真实存储身份：employeeId 原样返回（legacy 行保持 null，绝不按姓名/快照推断）
 * - storeKey 来自 Store 关系（storeId → Store.key 规范键），非字符串猜测
 */
dailyEntryUpgradeRouter.get('/daily-store-staff', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const month = String(req.query.month || '').trim()
  if (!/^\d{4}-\d{2}$/.test(month)) throw httpError('月份格式应为 YYYY-MM')
  const storeParam = String(req.query.store || '').trim()
  if (storeParam && !canStore(req.user, storeParam)) throw httpError('无权限', 403)
  const [year, monthNum] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, monthNum - 1, 1))
  const end = new Date(Date.UTC(year, monthNum, 1))
  const where = { date: { gte: start, lt: end } }
  if (storeParam) where.storeId = storeParam
  if (!isSuperUser(req.user)) {
    const allowed = new Set(Array.isArray(req.user.storeKeys) ? req.user.storeKeys : [])
    if (allowed.size === 0) return res.json({ ok: true, rows: [] })
    where.storeId = { in: [...allowed] }
  }
  // 单次有界查询 + Store 关系（无 N+1 Employee/Store 查找）
  const rows = await prisma.dailyStoreStaff.findMany({
    where,
    include: { store: { select: { key: true } } },
    orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { staffNameSnapshot: 'asc' }],
    take: 5000,
  })
  res.json({
    ok: true,
    month,
    rows: rows.map((row) => ({
      id: row.id,
      storeId: row.storeId,
      storeKey: row.store ? row.store.key : row.storeId,
      date: isoDate(row.date),
      employeeId: row.employeeId || null,
      staffId: row.staffId,
      staffNameSnapshot: row.staffNameSnapshot,
      scheduledHours: row.scheduledHours,
      actualHours: row.actualHours,
      attendanceStatus: row.attendanceStatus,
    })),
  })
}))

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
  if (!isSuperUser(req.user)) throw httpError('仅最高业务权限账号可修改门店销售数据来源', 403)
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
  if (!isSuperUser(req.user)) throw httpError('仅最高业务权限账号可查看门店销售数据来源', 403)
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
  if (!isSuperUser(req.user)) {
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
  const [orders, entries, refunds] = await Promise.all([
    prisma.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId: { in: storeIds }, businessDate: { not: null } }),
      include: { payments: true },
    }),
    prisma.dailyEntry.findMany({ where: { storeKey: { in: storeIds } } }),
    prisma.refund.findMany({
      where: {
        status: 'completed',
        order: { is: { storeId: { in: storeIds }, businessDate: { not: null } } },
      },
      include: { order: { select: { storeId: true, businessDate: true } } },
    }),
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
    for (const pay of order.payments || []) {
      if (pay.status === 'success') {
        const channel = ['wechat', 'alipay', 'cash'].includes(pay.channel) ? pay.channel : 'other'
        group.byChannel[channel] += pay.amount
      }
    }
    groups.set(key, group)
  }
  for (const refund of refunds) {
    const dateStr = isoDate(refund.order.businessDate)
    const store = storeMap.get(refund.order.storeId)
    if (!store || effectiveSource(store, dateStr) === 'manual') continue
    const key = `${refund.order.storeId}|${dateStr}`
    const group = groups.get(key) || {
      storeId: refund.order.storeId,
      date: dateStr,
      originalSales: 0n,
      effectiveSales: 0n,
      refundAmount: 0n,
      discountAmount: 0n,
      orderCount: 0,
      byChannel: { wechat: 0n, alipay: 0n, cash: 0n, other: 0n },
    }
    group.refundAmount += refund.refundAmount
    groups.set(key, group)
  }
  const toStr = (value) => value.toString()
  const rows = [...groups.values()].map((group) => {
    const adjustment = entryMap.get(`${group.storeId}|${group.date}`)?.hybridAdjustmentCents || 0n
    // 退款订单不进入 effectiveSales；refundAmount 仅作为独立审计指标展示。
    const effective = group.effectiveSales + adjustment
    return {
      storeKey: group.storeId,
      date: group.date,
      incCents: toStr(effective),
      originalSalesCents: toStr(group.originalSales),
      effectiveSalesCents: toStr(group.effectiveSales),
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
    where: { order: { is: buildRecognizedRevenueWhere({ storeId: { in: storeIds }, businessDate: { not: null } }) } },
    include: { order: { select: { storeId: true, businessDate: true, subtotal: true, payableAmount: true } } },
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
    let revenue = item.actualAmount || 0n
    current.quantity += item.quantity
    current.amountCents += revenue
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
  if (existingEntry?.status === 'confirmed' && !isSuperUser(req.user) && req.user.role !== 'manager') {
    throw httpError('日报已确认，普通员工不可修改值班人员', 409)
  }
  await ensureStore(storeKey)

  const parsed = items.map((item) => {
    const employeeId = item.employeeId == null ? null : String(item.employeeId).trim()
    const staffId = String(item.staffId || '').trim()
    const staffName = String(item.staffName || '').trim().slice(0, 50)
    if (!staffId || !staffName) throw httpError('值班人员姓名/ID 不正确')
    if (employeeId && employeeId.length > 100) throw httpError('员工 ID 不正确')
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
      employeeId: employeeId || null,
      staffId, staffName, attendanceStatus, breakMinutes,
      actualStartTime, actualEndTime, scheduledStartTime, scheduledEndTime,
      actualHours, scheduledHours: Math.max(0, Number(item.scheduledHours) || 0),
    }
  })

  // Gate 16：payload 判重身份化——稳定行（employeeId 非空）按 employeeId 判重；
  // legacy 行（employeeId=NULL）按 staffId 判重。同店同名不同 employeeId 允许并存。
  const submittedEmployeeIds = parsed.map((item) => item.employeeId).filter(Boolean)
  if (new Set(submittedEmployeeIds).size !== submittedEmployeeIds.length) {
    throw httpError('同一员工被重复提交', 409)
  }
  const submittedLegacyStaffIds = parsed.filter((item) => !item.employeeId).map((item) => item.staffId)
  if (new Set(submittedLegacyStaffIds).size !== submittedLegacyStaffIds.length) {
    throw httpError('同一值班人员被重复提交', 409)
  }
  if (submittedEmployeeIds.length > 0) {
    const employees = await prisma.employee.findMany({
      where: { id: { in: submittedEmployeeIds } },
      select: { id: true },
    })
    const existingEmployeeIds = new Set(employees.map((employee) => employee.id))
    const missing = submittedEmployeeIds.find((employeeId) => !existingEmployeeIds.has(employeeId))
    if (missing) throw httpError('员工不存在', 400)
  }

  const rows = await prisma.$transaction(async (tx) => {
    const existing = await tx.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: d } })
    const byLegacyStaffId = new Map(existing.filter((row) => !row.employeeId).map((row) => [row.staffId, row]))
    const byEmployeeId = new Map(existing.filter((row) => row.employeeId).map((row) => [row.employeeId, row]))
    const results = []
    const keptRowIds = new Set()
    for (const item of parsed) {
      // Gate 16：稳定行（employeeId 非空）以 (storeId, date, employeeId) 为变更身份，
      // 绝不按 staffId 选中/改写 legacy NULL 行（同店同名时无法判定归属，不做启发式升级）。
      const stableLinked = item.employeeId ? byEmployeeId.get(item.employeeId) : null
      const exactLegacy = item.employeeId ? null : byLegacyStaffId.get(item.staffId)
      const before = stableLinked || exactLegacy
      const data = {
        ...(item.employeeId ? { employeeId: item.employeeId } : {}),
        // 已有行的姓名是历史快照；重新保存不得用员工当前姓名覆盖。
        staffNameSnapshot: before?.staffNameSnapshot || item.staffName,
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
      const saved = before
        ? await tx.dailyStoreStaff.update({ where: { id: before.id }, data })
        : await tx.dailyStoreStaff.create({
          data: {
            id: `dss-${crypto.randomUUID()}`,
            storeId: storeKey,
            date: d,
            employeeId: item.employeeId,
            staffId: item.staffId,
            createdBy: req.user.username,
            ...data,
          },
        })
      keptRowIds.add(saved.id)
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
    // Gate 16：替换语义保护——legacy NULL 行（无法归属当前员工）绝不因稳定名单提交被删除。
    // 只有"由本批次识别并可安全移除"的行才进入删除：稳定行（employeeId 非空）不在新名单 → 删除；
    // legacy NULL 行一律保留（其归属解析属于未来 reconciliation，不做历史清理）。
    const removed = existing.filter((row) => !keptRowIds.has(row.id) && row.employeeId)
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
  if (!isSuperUser(req.user) && req.user?.role !== 'manager') throw httpError('无权限', 403)
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
  if (!isSuperUser(req.user) && req.user?.role !== 'manager') throw httpError('无权限', 403)
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
