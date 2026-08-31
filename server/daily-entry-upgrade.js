import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { buildRecognizedRevenueWhere, httpError } from './pos-core.js'
import { resolveStoreName } from './store-names.js'
import {
  DAILY_ENTRY_CAPABILITIES,
  hasDailyEntryCapability,
  isSuperUser,
} from '../shared/accountPermissions.js'
import { isFixedStoreKey } from '../shared/storeDirectory.js'
import {
  HISTORICAL_ATTENDANCE_STATUS,
  PAYABLE_HOURS_SOURCES,
  normalizePayableHours,
} from '../shared/payableHoursAuthority.js'
import {
  classifyDailyStaffTargets,
  OPERATIONAL_IDENTITY_TYPES,
  PAYROLL_PARTICIPANT_TYPES,
} from './payroll-participant-authority.js'
import { resolveDailyEntryCompleteness } from './daily-entry-completeness.js'

export const dailyEntryUpgradeRouter = Router()

export { dateOnly, isoDate, effectiveSource, hoursFromTimes }

const ATTENDANCE_STATUSES = ['normal', 'late', 'early_leave', 'leave', 'absence', 'substitute']

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[daily-entry-upgrade]', error)
    res.status(status).json({ error: status >= 500 ? '每日录入处理失败，请稍后重试' : (error.message || '请求处理失败') })
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

async function aggregatePosDay(storeId, dateStr, prismaClient = prisma) {
  const businessDate = dateOnly(dateStr)
  const [orders, refunds] = await Promise.all([
    prismaClient.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId, businessDate }),
      include: { payments: true },
    }),
    prismaClient.refund.findMany({
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

async function aggregatePosPeriod(storeId, start, end, prismaClient = prisma) {
  const [orders, refunds] = await Promise.all([
    prismaClient.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId, businessDate: { gte: start, lt: end } }),
      select: { businessDate: true, subtotal: true, payableAmount: true, discountAmount: true },
    }),
    prismaClient.refund.findMany({
      where: { status: 'completed', order: { is: { storeId, businessDate: { gte: start, lt: end } } } },
      select: { refundAmount: true, order: { select: { businessDate: true } } },
    }),
  ])
  const groups = new Map()
  const ensure = (dateStr) => {
    const current = groups.get(dateStr) || { originalSales: 0n, effectiveSales: 0n, discountAmount: 0n, refundAmount: 0n, orderCount: 0 }
    groups.set(dateStr, current)
    return current
  }
  for (const order of orders) {
    const group = ensure(isoDate(order.businessDate))
    group.originalSales += order.subtotal
    group.effectiveSales += order.payableAmount
    group.discountAmount += order.discountAmount
    group.orderCount += 1
  }
  for (const refund of refunds) ensure(isoDate(refund.order.businessDate)).refundAmount += refund.refundAmount
  return groups
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
    participantType: row.participantType,
    participantUserId: row.participantUserId || '',
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
    historicalPayrollHours: row.historicalPayrollHours,
    payableHoursSource: row.payableHoursSource,
    attendanceStatus: row.attendanceStatus,
    source: row.source,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  }
}

function dailyStaffFactSnapshot(row) {
  return {
    employeeId: row?.employeeId || '',
    participantUserId: row?.participantUserId || '',
    participantType: row?.participantType || '',
    actualStartTime: row?.actualStartTime || '',
    actualEndTime: row?.actualEndTime || '',
    breakMinutes: Number(row?.breakMinutes || 0),
    actualHours: row?.actualHours === null || row?.actualHours === undefined ? null : Number(row.actualHours),
    historicalPayrollHours: row?.historicalPayrollHours === null || row?.historicalPayrollHours === undefined ? null : Number(row.historicalPayrollHours),
    payableHoursSource: row?.payableHoursSource || PAYABLE_HOURS_SOURCES.ACTUAL_HOURS,
    attendanceStatus: row?.attendanceStatus || 'normal',
  }
}

function dailyStaffFactsEqual(left, right) {
  return JSON.stringify(dailyStaffFactSnapshot(left)) === JSON.stringify(dailyStaffFactSnapshot(right))
}

/**
 * Schedule is only a draft prefill authority. Stable Employee.id is required;
 * staff snapshots are never used to resolve or guess an employee.
 */
export function buildDailySchedulePrefill(shifts, employees) {
  const activeById = new Map((Array.isArray(employees) ? employees : []).map((employee) => [employee.id, employee]))
  const scheduledEmployeeIds = []
  const seen = new Set()
  const unresolved = []
  for (const shift of Array.isArray(shifts) ? shifts : []) {
    const employeeId = String(shift?.employeeId || '').trim()
    if (!employeeId) {
      unresolved.push({
        reason: 'MISSING_EMPLOYEE_ID',
        staffSnapshot: String(shift?.staff || '').trim().slice(0, 30),
        timeSnapshot: String(shift?.time || '').trim().slice(0, 20),
      })
      continue
    }
    if (!activeById.has(employeeId)) {
      unresolved.push({
        reason: 'EMPLOYEE_UNAVAILABLE',
        employeeId,
        staffSnapshot: String(shift?.staff || '').trim().slice(0, 30),
        timeSnapshot: String(shift?.time || '').trim().slice(0, 20),
      })
      continue
    }
    if (seen.has(employeeId)) continue
    seen.add(employeeId)
    scheduledEmployeeIds.push(employeeId)
  }
  return { scheduledEmployeeIds, unresolved }
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
      participantType: row.participantType,
      participantUserId: row.participantUserId || null,
      staffId: row.staffId,
      staffNameSnapshot: row.staffNameSnapshot,
      scheduledHours: row.scheduledHours,
      actualHours: row.actualHours,
      historicalPayrollHours: row.historicalPayrollHours,
      payableHoursSource: row.payableHoursSource,
      attendanceStatus: row.attendanceStatus,
    })),
  })
}))

/** Canonical directories for the DailyStoreStaff write contract. */
dailyEntryUpgradeRouter.get('/daily-participants', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.query.store || '').trim()
  const dateStr = String(req.query.date || '').trim()
  if (!storeKey) throw httpError('门店不能为空')
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('日期格式应为 YYYY-MM-DD')
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.VIEW)) throw httpError('无权限', 403)
  await ensureStore(storeKey)
  const [employees, users, schedule] = await Promise.all([
    prisma.employee.findMany({
      // 跨店值班是正常业务事实。候选权威是当前可参与工作的 canonical Employee.id，
      // currentStoreKey 只用于排序提示，不能作为另一门店值班的排除条件。
      where: { status: { in: ['ACTIVE', 'PROBATION'] } },
      select: { id: true, employeeNo: true, name: true, status: true, currentStoreKey: true },
      orderBy: [{ name: 'asc' }, { employeeNo: 'asc' }],
    }),
    prisma.user.findMany({
      where: { operationalIdentityType: OPERATIONAL_IDENTITY_TYPES.NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE, status: 'active' },
      select: { id: true, username: true, displayName: true, storeKeys: true },
      orderBy: { username: 'asc' },
    }),
    dateStr ? prisma.schedule.findFirst({
      where: { storeKey, date: dateStr },
      orderBy: { updatedAt: 'desc' },
      select: { shifts: true, updatedAt: true },
    }) : null,
  ])
  const schedulePrefill = buildDailySchedulePrefill(schedule?.shifts, employees)
  const scheduledEmployeeIds = new Set(schedulePrefill.scheduledEmployeeIds)
  const employeeDirectory = employees
    .map((employee) => ({
      employeeId: employee.id,
      employeeNo: employee.employeeNo,
      label: employee.name,
      status: employee.status,
      currentStoreKey: employee.currentStoreKey,
      scheduled: scheduledEmployeeIds.has(employee.id),
      priorityGroup: scheduledEmployeeIds.has(employee.id) ? 1 : employee.currentStoreKey === storeKey ? 2 : 3,
      participantType: PAYROLL_PARTICIPANT_TYPES.EMPLOYEE,
    }))
    .sort((a, b) => a.priorityGroup - b.priorityGroup
      || a.label.localeCompare(b.label, 'zh-CN')
      || a.employeeNo.localeCompare(b.employeeNo, 'zh-CN'))
  const substitutes = users
    .filter((user) => Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey))
    .map((user) => ({
      participantUserId: user.id,
      label: user.displayName || user.username,
      username: user.username,
      priorityGroup: 4,
      participantType: PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE,
    }))
  res.json({
    ok: true,
    employees: employeeDirectory,
    substitutes,
    schedule: {
      scheduledEmployeeIds: schedulePrefill.scheduledEmployeeIds,
      unresolved: schedulePrefill.unresolved,
      updatedAt: schedule?.updatedAt || null,
    },
  })
}))

dailyEntryUpgradeRouter.get('/daily-entry/overview', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.query.store || '').trim()
  const dateStr = String(req.query.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.VIEW)) throw httpError('无权限', 403)
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

dailyEntryUpgradeRouter.get('/daily-entry/completeness', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.query.store || '').trim()
  const dateStr = String(req.query.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.VIEW)) throw httpError('无权限', 403)
  const d = dateOnly(dateStr)
  const [entry, staffRows] = await Promise.all([
    prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } }),
    prisma.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: d } }),
  ])
  const employeeIds = [...new Set(staffRows.map((row) => row.employeeId).filter(Boolean))]
  const employees = employeeIds.length > 0
    ? await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true } })
    : []
  res.json({
    ok: true,
    storeKey,
    date: dateStr,
    completeness: resolveDailyEntryCompleteness({
      entry,
      staffRows,
      knownEmployeeIds: new Set(employees.map((employee) => employee.id)),
    }),
  })
}))

function isConfirmedRevisionAudit(entry, audit) {
  if (!entry?.confirmedAt || !audit?.createdAt || new Date(audit.createdAt) <= new Date(entry.confirmedAt)) return false
  if (audit.module === 'daily_confirmation') return false
  if (!String(audit.reason || '').trim() || audit.beforeValue === undefined || audit.afterValue === undefined) return false
  return ['daily_revision', 'daily_staff', 'sales_manual', 'sales_hybrid_adjustment'].includes(audit.module)
}

dailyEntryUpgradeRouter.get('/daily-entry/ledger', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const month = String(req.query.month || '').trim()
  const storeKey = String(req.query.store || '').trim()
  const statusFilter = String(req.query.status || 'all').trim()
  if (!/^\d{4}-\d{2}$/.test(month)) throw httpError('月份格式应为 YYYY-MM')
  if (!storeKey || !canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.VIEW)) throw httpError('无权限', 403)
  if (!['all', 'draft', 'confirmed', 'anomaly'].includes(statusFilter)) throw httpError('状态筛选不正确')
  const store = await ensureStore(storeKey)
  const [year, monthNo] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, monthNo - 1, 1))
  const end = new Date(Date.UTC(year, monthNo, 1))
  const [entries, staffRows, audits, employees, posGroups] = await Promise.all([
    prisma.dailyEntry.findMany({ where: { storeKey, date: { gte: start, lt: end } }, orderBy: { date: 'desc' } }),
    prisma.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: { gte: start, lt: end } }, orderBy: [{ date: 'desc' }, { staffNameSnapshot: 'asc' }] }),
    prisma.dailyEntryAuditLog.findMany({ where: { storeId: storeKey, date: { gte: start, lt: end } }, orderBy: { createdAt: 'desc' } }),
    prisma.employee.findMany({ select: { id: true } }),
    aggregatePosPeriod(storeKey, start, end),
  ])
  const staffByDate = new Map()
  for (const row of staffRows) {
    const dateStr = isoDate(row.date)
    const list = staffByDate.get(dateStr) || []
    list.push(row)
    staffByDate.set(dateStr, list)
  }
  const auditByDate = new Map()
  for (const audit of audits) {
    const dateStr = isoDate(audit.date)
    const list = auditByDate.get(dateStr) || []
    list.push(audit)
    auditByDate.set(dateStr, list)
  }
  const knownEmployeeIds = new Set(employees.map((employee) => employee.id))
  let rows = entries.map((entry) => {
    const dateStr = isoDate(entry.date)
    const staff = staffByDate.get(dateStr) || []
    const entryAudits = auditByDate.get(dateStr) || []
    const revisionAudits = entryAudits.filter((audit) => isConfirmedRevisionAudit(entry, audit))
    const source = effectiveSource(store, dateStr)
    const pos = posGroups.get(dateStr)
    const incCents = source === 'manual'
      ? entry.incCents
      : (pos?.effectiveSales || 0n) + entry.hybridAdjustmentCents
    const ord = source === 'manual' ? entry.ord : (pos?.orderCount || 0)
    const completeness = resolveDailyEntryCompleteness({ entry, staffRows: staff, knownEmployeeIds })
    const derivedStatus = entry.status === 'confirmed' && revisionAudits.length > 0 ? 'revised' : entry.status
    return {
      id: entry.id,
      storeKey,
      storeName: store.name,
      date: dateStr,
      status: derivedStatus,
      baseStatus: entry.status,
      incCents: incCents.toString(),
      ord,
      avgCents: (ord > 0 ? incCents / BigInt(ord) : 0n).toString(),
      salesDataSource: source,
      salesSourceLabel: source === 'manual' ? '美团收银 · 人工录入' : 'BUDU POS',
      confirmedBy: entry.confirmedBy,
      confirmedAt: entry.confirmedAt,
      version: entry.version,
      completeness,
      staff: staff.map(serializeStaff),
      revisionCount: revisionAudits.length,
      audits: entryAudits.map((audit) => ({
        id: audit.id,
        module: audit.module,
        fieldName: audit.fieldName,
        beforeValue: audit.beforeValue,
        afterValue: audit.afterValue,
        reason: audit.reason,
        operatorName: audit.operatorName,
        createdAt: audit.createdAt,
        revision: revisionAudits.some((candidate) => candidate.id === audit.id),
      })),
    }
  })
  if (statusFilter === 'draft') rows = rows.filter((row) => row.baseStatus === 'draft')
  if (statusFilter === 'confirmed') rows = rows.filter((row) => row.baseStatus === 'confirmed')
  if (statusFilter === 'anomaly') rows = rows.filter((row) => row.completeness.status !== 'COMPLETE')
  res.json({ ok: true, month, storeKey, rows })
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

function normalizeDailyStaffSubmission(items) {
  if (!Array.isArray(items) || items.length > 100) throw httpError('值班人员数量不正确')
  return items.map((item) => {
    if (
      Object.prototype.hasOwnProperty.call(item || {}, 'historicalPayrollHours')
      || Object.prototype.hasOwnProperty.call(item || {}, 'payableHoursSource')
      || item?.attendanceStatus === HISTORICAL_ATTENDANCE_STATUS
    ) throw httpError('历史计薪工时只能通过受控修复流程写入')
    const employeeId = item?.employeeId == null ? '' : String(item.employeeId).trim()
    const participantUserId = item?.participantUserId == null ? '' : String(item.participantUserId).trim()
    if (employeeId.length > 100 || participantUserId.length > 100) throw httpError('参与者 ID 不正确')
    const attendanceStatus = String(item?.attendanceStatus || 'normal')
    if (!ATTENDANCE_STATUSES.includes(attendanceStatus)) throw httpError('出勤状态不正确')
    const breakMinutes = Number(item?.breakMinutes ?? 0)
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 600) throw httpError('休息分钟数不正确')
    const actualHours = item?.actualHours === '' || item?.actualHours == null ? null : Number(item.actualHours)
    if (!Number.isFinite(actualHours) || actualHours < 0 || actualHours > 24) {
      throw httpError('请为每位实际值班人员填写 0 到 24 小时的实际工时')
    }
    return {
      ...(Object.prototype.hasOwnProperty.call(item || {}, 'participantType') ? { participantType: item.participantType } : {}),
      employeeId: employeeId || null,
      participantUserId: participantUserId || null,
      actualStartTime: String(item?.actualStartTime || '').slice(0, 5),
      actualEndTime: String(item?.actualEndTime || '').slice(0, 5),
      breakMinutes,
      actualHours: Math.round(actualHours * 100) / 100,
      attendanceStatus,
    }
  })
}

async function resolveDailyStaffSubmission(prismaClient, normalizedInput, storeKey) {
  const employeeIds = [...new Set(normalizedInput.map((item) => item.employeeId).filter(Boolean))]
  const userIds = [...new Set(normalizedInput.map((item) => item.participantUserId).filter(Boolean))]
  const [employees, participantUsers] = await Promise.all([
    employeeIds.length ? prismaClient.employee.findMany({
      where: { id: { in: employeeIds }, status: { in: ['ACTIVE', 'PROBATION'] } },
      select: { id: true, name: true, status: true },
    }) : [],
    userIds.length ? prismaClient.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, displayName: true, status: true, operationalIdentityType: true, storeKeys: true },
    }) : [],
  ])
  try {
    const parsed = classifyDailyStaffTargets(normalizedInput, employees, participantUsers, { storeKey })
    for (const item of parsed) {
      normalizePayableHours({
        actualHours: item.actualHours,
        historicalPayrollHours: null,
        payableHoursSource: PAYABLE_HOURS_SOURCES.ACTUAL_HOURS,
        attendanceStatus: item.attendanceStatus,
      })
    }
    return parsed
  } catch (error) {
    throw httpError(error.message || '值班参与者或实际工时无效', /重复提交/.test(error.message || '') ? 409 : 400)
  }
}

async function replaceDailyStaff(tx, {
  storeKey,
  dateStr,
  parsed,
  actor,
  reason,
  auditWriter = writeAudit,
  strictAuthority = true,
}) {
  const d = dateOnly(dateStr)
  const existing = await tx.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: d } })
  if (existing.some((row) => row.payableHoursSource === PAYABLE_HOURS_SOURCES.LEGACY_PAYROLL_HOURS)) {
    throw httpError('历史计薪工时为只读权威记录，不能由日常录入覆盖或删除', 409)
  }
  const unresolvedAuthorityRows = existing.filter((row) => ![
    PAYROLL_PARTICIPANT_TYPES.EMPLOYEE,
    PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE,
  ].includes(row.participantType))
  if (strictAuthority && unresolvedAuthorityRows.length > 0) {
    throw httpError('该日存在未完成身份复核的历史值班记录，请先完成精确修复', 409)
  }
  if (!strictAuthority) {
    const authorityConflict = parsed.find((item) => unresolvedAuthorityRows.some((row) => (
      (item.employeeId && row.employeeId === item.employeeId)
      || (item.participantUserId && row.participantUserId === item.participantUserId)
      || row.staffId === item.staffId
    )))
    if (authorityConflict) {
      throw httpError('该日存在未完成身份复核的历史值班记录，请先完成精确修复', 409)
    }
  }
  const byEmployeeId = new Map(existing.filter((row) => (
    row.participantType === PAYROLL_PARTICIPANT_TYPES.EMPLOYEE && row.employeeId
  )).map((row) => [row.employeeId, row]))
  const byUserId = new Map(existing.filter((row) => (
    row.participantType === PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE && row.participantUserId
  )).map((row) => [row.participantUserId, row]))
  const kept = new Set()
  const results = []
  for (const item of parsed) {
    const before = item.employeeId ? byEmployeeId.get(item.employeeId) : byUserId.get(item.participantUserId)
    const data = {
      employeeId: item.employeeId,
      participantUserId: item.participantUserId,
      participantType: item.participantType,
      staffNameSnapshot: before?.staffNameSnapshot || item.staffName,
      shiftId: before?.shiftId || '',
      scheduledStartTime: before?.scheduledStartTime || '',
      scheduledEndTime: before?.scheduledEndTime || '',
      scheduledHours: before?.scheduledHours || 0,
      actualStartTime: item.actualStartTime,
      actualEndTime: item.actualEndTime,
      breakMinutes: item.breakMinutes,
      actualHours: item.actualHours,
      historicalPayrollHours: null,
      payableHoursSource: PAYABLE_HOURS_SOURCES.ACTUAL_HOURS,
      attendanceStatus: item.attendanceStatus,
      source: before?.source || 'manual',
      updatedBy: actor.username,
      updatedAt: new Date(),
    }
    const intended = { ...data, staffNameSnapshot: data.staffNameSnapshot }
    const saved = before
      ? (dailyStaffFactsEqual(before, intended)
          ? before
          : await tx.dailyStoreStaff.update({ where: { id: before.id }, data }))
      : await tx.dailyStoreStaff.create({ data: {
        id: `dss-${crypto.randomUUID()}`,
        storeId: storeKey,
        date: d,
        staffId: item.staffId,
        createdBy: actor.username,
        ...data,
      } })
    kept.add(saved.id)
    results.push(saved)
    if (!before || !dailyStaffFactsEqual(before, saved)) {
      await auditWriter(tx, {
        storeId: storeKey, date: dateStr, module: 'daily_staff', fieldName: 'staff_record',
        beforeValue: before ? serializeStaff(before) : null,
        afterValue: serializeStaff(saved), reason,
        operatorId: actor.id, operatorName: actor.username,
      })
    }
  }
  const removed = existing.filter((candidate) => !kept.has(candidate.id) && [
    PAYROLL_PARTICIPANT_TYPES.EMPLOYEE,
    PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE,
  ].includes(candidate.participantType))
  for (const row of removed) {
    await auditWriter(tx, {
      storeId: storeKey, date: dateStr, module: 'daily_staff', fieldName: 'staff_record',
      beforeValue: serializeStaff(row), afterValue: null, reason,
      operatorId: actor.id, operatorName: actor.username,
    })
    await tx.dailyStoreStaff.delete({ where: { id: row.id } })
  }
  return results
}

dailyEntryUpgradeRouter.put('/daily-staff', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.EDIT)) throw httpError('无权限', 403)
  await ensureStore(storeKey)
  const d = dateOnly(dateStr)
  const existingEntry = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
  if (existingEntry?.status === 'confirmed') throw httpError('日报已确认，请通过受控历史修正流程处理', 409)
  const normalized = normalizeDailyStaffSubmission(req.body?.items)
  const parsed = await resolveDailyStaffSubmission(prisma, normalized, storeKey)
  const rows = await prisma.$transaction(async (tx) => {
    const saved = await replaceDailyStaff(tx, {
      storeKey, dateStr, parsed,
      actor: req.user,
      reason: String(req.body?.reason || '值班人员确认').slice(0, 300),
      strictAuthority: false,
    })
    const staffNames = saved.map((row) => row.staffNameSnapshot)
    await tx.dailyEntry.upsert({
      where: { storeKey_date: { storeKey, date: d } },
      update: { staffNames, updatedBy: req.user.username, version: { increment: 1 } },
      create: { id: `de-${crypto.randomUUID()}`, storeKey, date: d, staffNames, updatedBy: req.user.username },
    })
    return saved
  })
  res.json({ ok: true, rows: rows.map(serializeStaff) })
}))

function parseManualSales(manualSales) {
  if (!manualSales || typeof manualSales !== 'object' || Array.isArray(manualSales)) throw httpError('请填写当日营业数据')
  const cents = Number(manualSales.incCents)
  const ord = Number(manualSales.ord)
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 999999999999) throw httpError('营业收入不正确（单位：分）')
  if (!Number.isInteger(ord) || ord < 0 || ord > 999999) throw httpError('订单数不正确')
  if (cents <= 0 && ord <= 0) throw httpError('请完整核对当日营业数据')
  return { incCents: BigInt(cents), ord }
}

export async function confirmDailyEntryAtomic(prismaClient, input, options = {}) {
  const storeKey = String(input?.storeKey || '').trim()
  const dateStr = String(input?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  const expectedVersion = Number(input?.version)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw httpError('数据版本缺失，请刷新后重新核对', 409)
  const normalized = normalizeDailyStaffSubmission(input?.items)
  if (normalized.length === 0) throw httpError('请至少选择一位实际值班人员')
  const actor = input.actor || { id: '', username: '' }
  const auditWriter = options.auditWriter || writeAudit

  return prismaClient.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS lock_row',
      `daily-entry:${storeKey}:${dateStr}`,
    )
    const store = await tx.store.findUnique({ where: { key: storeKey } })
    if (!store) throw httpError('门店不存在或已停用', 400)
    const d = dateOnly(dateStr)
    const before = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
    const currentVersion = before?.version || 0
    if (currentVersion !== expectedVersion) throw httpError('数据已被其他用户更新，请刷新后重新核对', 409)
    if (before?.status === 'confirmed') throw httpError('该日录入已确认，请通过受控历史修正流程处理', 409)

    const source = effectiveSource(store, dateStr)
    let manualSales = null
    let posSnapshot = null
    if (source === 'manual') {
      manualSales = parseManualSales(input.manualSales)
    } else {
      if (Object.prototype.hasOwnProperty.call(input || {}, 'manualSales')) {
        throw httpError('POS 门店营业数据由订单权威生成，客户端不可提交金额', 403)
      }
      posSnapshot = await aggregatePosDay(storeKey, dateStr, tx)
    }

    const parsed = await resolveDailyStaffSubmission(tx, normalized, storeKey)
    const staff = await replaceDailyStaff(tx, {
      storeKey,
      dateStr,
      parsed,
      actor,
      reason: String(input.reason || '确认今日录入').slice(0, 300),
      auditWriter,
    })
    const staffNames = staff.map((row) => row.staffNameSnapshot)
    const now = new Date()
    const entryData = {
      ...(manualSales ? manualSales : {}),
      staffNames,
      status: 'confirmed',
      confirmedAt: now,
      confirmedBy: actor.username,
      salesDataStatus: 'synced',
      posSyncAt: source === 'manual' ? null : now,
      updatedBy: actor.username,
    }
    const row = before
      ? await tx.dailyEntry.update({ where: { id: before.id }, data: { ...entryData, version: { increment: 1 } } })
      : await tx.dailyEntry.create({ data: {
        id: `de-${crypto.randomUUID()}`,
        storeKey,
        date: d,
        ...entryData,
        version: 1,
      } })
    await auditWriter(tx, {
      storeId: storeKey,
      date: dateStr,
      module: 'daily_confirmation',
      fieldName: 'atomic_confirm',
      beforeValue: before ? serializeEntry(before) : null,
      afterValue: {
        entry: serializeEntry(row),
        participants: staff.map(serializeStaff),
        salesAuthority: source,
      },
      reason: String(input.reason || '确认今日录入').slice(0, 300),
      operatorId: actor.id,
      operatorName: actor.username,
    })
    return { entry: row, staff, source, posSnapshot }
  })
}

dailyEntryUpgradeRouter.post('/daily-entry/confirm', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.body?.storeKey || '').trim()
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.CONFIRM)) throw httpError('无权限', 403)
  const result = await confirmDailyEntryAtomic(prisma, { ...req.body, actor: req.user })
  res.json({
    ok: true,
    salesDataSource: result.source,
    entry: serializeEntry(result.entry),
    staff: result.staff.map(serializeStaff),
    pos: result.posSnapshot,
  })
}))

function parseRevisionReason(value) {
  const reason = String(value || '').trim()
  if (reason.length < 2) throw httpError('历史修正原因必填，且至少 2 个字符')
  return reason.slice(0, 300)
}

function comparableStaffList(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(dailyStaffFactSnapshot)
    .sort((left, right) => `${left.employeeId}|${left.participantUserId}`.localeCompare(`${right.employeeId}|${right.participantUserId}`))
}

export async function reviseConfirmedDailyEntryAtomic(prismaClient, input, options = {}) {
  const storeKey = String(input?.storeKey || '').trim()
  const dateStr = String(input?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  const expectedVersion = Number(input?.version)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw httpError('数据版本缺失，请刷新后重新核对', 409)
  const reason = parseRevisionReason(input?.reason)
  const normalized = normalizeDailyStaffSubmission(input?.items)
  if (normalized.length === 0) throw httpError('请至少保留一位实际值班人员')
  const actor = input.actor || { id: '', username: '' }
  const auditWriter = options.auditWriter || writeAudit

  return prismaClient.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS lock_row',
      `daily-entry:${storeKey}:${dateStr}`,
    )
    const store = await tx.store.findUnique({ where: { key: storeKey } })
    if (!store) throw httpError('门店不存在或已停用', 400)
    const d = dateOnly(dateStr)
    const before = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
    if (!before || before.status !== 'confirmed') throw httpError('只有已确认每日记录可以进入受控修正', 409)
    if (before.version !== expectedVersion) throw httpError('数据已被其他用户更新，请刷新后重新核对', 409)

    const source = effectiveSource(store, dateStr)
    let manualSales = null
    let posSnapshot = null
    if (source === 'manual') {
      manualSales = parseManualSales(input.manualSales)
    } else {
      if (Object.prototype.hasOwnProperty.call(input || {}, 'manualSales')) {
        throw httpError('POS 门店营业数据由订单权威生成，客户端不可提交金额', 403)
      }
      posSnapshot = await aggregatePosDay(storeKey, dateStr, tx)
    }

    const parsed = await resolveDailyStaffSubmission(tx, normalized, storeKey)
    const beforeStaff = await tx.dailyStoreStaff.findMany({ where: { storeId: storeKey, date: d } })
    const desiredStaff = parsed.map((item) => ({
      ...item,
      staffNameSnapshot: item.staffName,
      historicalPayrollHours: null,
      payableHoursSource: PAYABLE_HOURS_SOURCES.ACTUAL_HOURS,
    }))
    const salesChanged = Boolean(manualSales && (before.incCents !== manualSales.incCents || before.ord !== manualSales.ord))
    const staffChanged = JSON.stringify(comparableStaffList(beforeStaff)) !== JSON.stringify(comparableStaffList(desiredStaff))
    if (!salesChanged && !staffChanged) throw httpError('修正内容与当前确认事实一致，无需提交', 409)

    const staff = await replaceDailyStaff(tx, {
      storeKey,
      dateStr,
      parsed,
      actor,
      reason,
      auditWriter,
    })
    const row = await tx.dailyEntry.update({
      where: { id: before.id },
      data: {
        ...(manualSales || {}),
        staffNames: staff.map((staffRow) => staffRow.staffNameSnapshot),
        version: { increment: 1 },
        updatedBy: actor.username,
        updatedAt: new Date(),
      },
    })
    await auditWriter(tx, {
      storeId: storeKey,
      date: dateStr,
      module: 'daily_revision',
      fieldName: 'confirmed_facts',
      beforeValue: { entry: serializeEntry(before), participants: beforeStaff.map(serializeStaff) },
      afterValue: { entry: serializeEntry(row), participants: staff.map(serializeStaff) },
      reason,
      operatorId: actor.id,
      operatorName: actor.username,
    })
    return { entry: row, staff, source, posSnapshot }
  })
}

dailyEntryUpgradeRouter.post('/daily-entry/revise', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const storeKey = String(req.body?.storeKey || '').trim()
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.REVISE)) throw httpError('无权限', 403)
  const result = await reviseConfirmedDailyEntryAtomic(prisma, { ...req.body, actor: req.user })
  res.json({
    ok: true,
    salesDataSource: result.source,
    entry: serializeEntry(result.entry),
    staff: result.staff.map(serializeStaff),
    pos: result.posSnapshot,
  })
}))

dailyEntryUpgradeRouter.post('/daily-entry/unconfirm', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.REVISE)) throw httpError('无权限', 403)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  throw httpError('已确认每日记录不能退回普通草稿，请使用受控历史修正', 409)
}))

dailyEntryUpgradeRouter.post('/daily-entry/adjust', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.REVISE)) throw httpError('无权限', 403)
  const storeKey = String(req.body?.storeKey || '').trim()
  const dateStr = String(req.body?.date || '').trim()
  if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw httpError('参数不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  const store = await ensureStore(storeKey)
  if (effectiveSource(store, dateStr) !== 'hybrid') throw httpError('仅混合模式门店可调整营业数据', 409)
  const expectedVersion = Number(req.body?.version)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw httpError('数据版本缺失，请刷新后重新核对', 409)
  const reason = parseRevisionReason(req.body?.reason)
  const adjustmentCents = Number(req.body?.adjustmentCents)
  if (!Number.isInteger(adjustmentCents) || adjustmentCents < -999999999999 || adjustmentCents > 999999999999) {
    throw httpError('调整金额不正确（单位：分）')
  }
  const d = dateOnly(dateStr)
  const saved = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS lock_row',
      `daily-entry:${storeKey}:${dateStr}`,
    )
    const before = await tx.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
    if (!before) throw httpError('每日记录不存在，请先完成当日确认', 409)
    if (before.version !== expectedVersion) throw httpError('数据已被其他用户更新，请刷新后重新核对', 409)
    const note = String(req.body?.note || '').slice(0, 300)
    if (before.hybridAdjustmentCents === BigInt(adjustmentCents) && before.hybridAdjustmentNote === note) {
      throw httpError('修正内容与当前事实一致，无需提交', 409)
    }
    const row = await tx.dailyEntry.update({
      where: { id: before.id },
      data: {
        hybridAdjustmentCents: BigInt(adjustmentCents),
        hybridAdjustmentNote: note,
        version: { increment: 1 },
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
      reason,
      operatorId: req.user.id,
      operatorName: req.user.username,
    })
    return row
  })
  res.json({ ok: true, entry: serializeEntry(saved) })
}))
