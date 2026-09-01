import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'
import { buildIssueSnapshot } from '../src/utils/payrollIssue.js'
import { payrollRangesOverlap, resolvePayrollPeriod } from '../src/utils/payrollPeriod.js'
import { PAYROLL_ISSUANCE_SNAPSHOT_VERSION } from '../shared/payrollIssuanceContract.js'
import crypto from 'node:crypto'

const isoDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '')
const dbDate = (value) => new Date(`${value}T00:00:00.000Z`)

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]))
  }
  return value
}

export function stablePayrollJson(value) {
  return JSON.stringify(stableJsonValue(value))
}

export function payrollIssuanceSnapshotDigest(snapshot) {
  return crypto.createHash('sha256').update(stablePayrollJson(snapshot)).digest('hex')
}

function firstPayrollDifference(actual, expected, path = '') {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return path || 'snapshot'
    const length = Math.max(actual.length, expected.length)
    for (let index = 0; index < length; index += 1) {
      const difference = firstPayrollDifference(actual[index], expected[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return ''
  }
  if ((actual && typeof actual === 'object') || (expected && typeof expected === 'object')) {
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return path || 'snapshot'
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()
    for (const key of keys) {
      const difference = firstPayrollDifference(actual[key], expected[key], path ? `${path}.${key}` : key)
      if (difference) return difference
    }
    return ''
  }
  return Object.is(actual, expected) ? '' : (path || 'snapshot')
}

export function normalizeAuthoritativePeriod(input) {
  const period = resolvePayrollPeriod(input)
  if (!period.valid) {
    const error = new Error(period.detail || '工资周期不正确')
    error.status = 400
    error.code = period.reason
    throw error
  }
  return period
}

/** Load only the exact inclusive range required by the shared resolver. */
export async function loadAuthoritativePayrollRange(client, periodInput) {
  const period = normalizeAuthoritativePeriod(periodInput)
  const dateWhere = { gte: dbDate(period.periodStart), lte: dbDate(period.periodEnd) }
  const [entries, staff, adjustments, bonuses, employees, users, stores] = await Promise.all([
    client.dailyEntry.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }] }),
    client.dailyStoreStaff.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { id: 'asc' }] }),
    client.dailyPayAdjustment.findMany({ where: { date: dateWhere, active: true }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    client.bigOrderBonus.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    client.employee.findMany({
      select: { id: true, employeeNo: true, name: true, status: true, employmentType: true, currentStoreKey: true },
      orderBy: { id: 'asc' },
    }),
    client.user.findMany({
      where: { employeeId: { not: '' } },
      select: { id: true, username: true, employeeId: true, status: true },
      orderBy: { username: 'asc' },
    }),
    client.store.findMany({ select: { key: true, name: true }, orderBy: { key: 'asc' } }),
  ])

  const dailyEntries = {}
  for (const row of entries) {
    const date = isoDate(row.date)
    dailyEntries[`${date.slice(0, 7)}|${row.storeKey}|${date.slice(5)}`] = {
      inc: Number(row.incCents) / 100,
      ord: row.ord,
      staff: Array.isArray(row.staffNames) ? row.staffNames : [],
      status: row.status,
      v2version: row.version,
    }
  }
  const dailyStoreStaffRows = staff.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    storeKey: row.storeId,
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
  }))
  const dailyPayAdjustments = adjustments.map((row) => ({
    id: row.id,
    employeeId: row.employeeId || '',
    staffName: row.staffName,
    date: isoDate(row.date),
    autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot),
    adjustedPayCents: Number(row.adjustedPayCents),
    reason: row.reason,
  }))
  const bigOrderBonuses = bonuses.map((row) => ({
    id: row.id,
    employeeId: row.employeeId || '',
    staffKey: row.staffKey,
    staffName: row.staffName,
    storeKey: row.storeKey,
    date: isoDate(row.date),
    amountCents: Number(row.amountCents),
    bonusCents: Number(row.bonusCents),
    receipt: row.receipt,
  }))
  const employeeDirectory = employees.map((row) => ({
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    status: row.status,
    type: row.employmentType,
    storeKey: row.currentStoreKey,
  }))
  const storeNames = Object.fromEntries(stores.map((store) => [store.key, store.name]))
  const result = resolvePayrollCalculation({
    ...period,
    dailyEntries,
    dailyStoreStaffRows,
    dailyPayAdjustments,
    bigOrderBonuses,
    employees: employeeDirectory,
    users,
    storeNames,
  })
  return {
    period,
    result,
    employees: employeeDirectory,
    users,
    storeNames,
  }
}

export function buildAuthoritativeIssueRows(authority, employeeIds) {
  const requested = [...new Set((employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean))].sort()
  const recById = new Map((authority.result.payroll?.employees || []).map((rec) => [rec.employeeId, rec]))
  const readyById = new Map((authority.result.readiness?.employees || []).map((row) => [row.employeeId, row]))
  const employeeById = new Map(authority.employees.map((row) => [row.id, row]))
  const activeUsersById = new Map()
  for (const user of authority.users.filter((row) => row.status === 'active' && row.employeeId)) {
    const rows = activeUsersById.get(user.employeeId) || []
    rows.push(user)
    activeUsersById.set(user.employeeId, rows)
  }
  return requested.map((employeeId) => {
    const rec = recById.get(employeeId)
    const readiness = readyById.get(employeeId)
    const employee = employeeById.get(employeeId)
    const recipients = activeUsersById.get(employeeId) || []
    if (!rec || !employee) {
      const error = new Error(`员工 ${employeeId} 不属于所选工资周期`)
      error.status = 409
      error.code = 'PAYROLL_SUBJECT_OUTSIDE_RANGE'
      throw error
    }
    if (!authority.result.calculationReady || !readiness?.issueReady || recipients.length !== 1) {
      const error = new Error(`「${employee.name}」工资权威数据或收件人未就绪`)
      error.status = 409
      error.code = 'PAYROLL_SUBJECT_NOT_ISSUE_READY'
      throw error
    }
    if (Number(rec.salary) < 0) {
      const error = new Error(`「${employee.name}」工资金额为负，无法发放`)
      error.status = 409
      error.code = 'NEGATIVE_PAYROLL_TOTAL'
      throw error
    }
    const snapshot = buildIssueSnapshot(rec, authority.period)
    return {
      employeeId,
      employeeName: employee.name,
      storeKey: employee.storeKey || rec.storesWorked?.[0] || 'payroll',
      targetUsername: recipients[0].username,
      totalCents: Math.round(Number(rec.salary || 0) * 100),
      snapshot,
      snapshotVersion: PAYROLL_ISSUANCE_SNAPSHOT_VERSION,
      snapshotDigest: payrollIssuanceSnapshotDigest(snapshot),
      readiness,
    }
  })
}

export function validateClientIssueRows(authoritativeRows, clientRows) {
  const clientById = new Map((clientRows || []).map((row) => [String(row?.employeeId || '').trim(), row]))
  if (clientById.size !== authoritativeRows.length || clientRows.length !== authoritativeRows.length) {
    const error = new Error('发放员工列表与服务器权威结果不一致')
    error.status = 409
    error.code = 'PAYROLL_SUBJECT_SET_MISMATCH'
    throw error
  }
  for (const expected of authoritativeRows) {
    const supplied = clientById.get(expected.employeeId)
    const totalCents = Number(supplied?.totalCents)
    let mismatchField = ''
    if (!supplied) mismatchField = 'employeeId'
    else if (supplied.employeeName !== expected.employeeName) mismatchField = 'employeeName'
    else if (supplied.storeKey !== expected.storeKey) mismatchField = 'storeKey'
    else if (totalCents !== expected.totalCents) mismatchField = 'totalCents'
    else if (supplied.snapshotVersion !== expected.snapshotVersion) mismatchField = 'snapshotVersion'
    else if (supplied.snapshotDigest !== expected.snapshotDigest) {
      mismatchField = firstPayrollDifference(supplied.snapshot, expected.snapshot, 'snapshot') || 'snapshotDigest'
    } else if (stablePayrollJson(supplied.snapshot) !== stablePayrollJson(expected.snapshot)) {
      mismatchField = firstPayrollDifference(supplied.snapshot, expected.snapshot, 'snapshot') || 'snapshot'
    }
    if (mismatchField) {
      const error = new Error(`「${expected.employeeName}」提交金额或快照与服务器工资权威不一致`)
      error.status = 409
      error.code = 'PAYROLL_AUTHORITY_MISMATCH'
      error.mismatchField = mismatchField
      throw error
    }
  }
}

export async function findPayrollRangeOverlaps(client, period, employeeIds) {
  if (employeeIds.length === 0) return []
  const rows = await client.payrollNotice.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: { notIn: ['recalled', 'deleted'] },
      periodStart: { lte: dbDate(period.periodEnd) },
      periodEnd: { gte: dbDate(period.periodStart) },
    },
    select: {
      id: true,
      employeeId: true,
      employeeName: true,
      periodType: true,
      periodKey: true,
      periodStart: true,
      periodEnd: true,
      status: true,
    },
    orderBy: [{ periodStart: 'asc' }, { createdAt: 'asc' }],
  })
  return rows
    .map((row) => ({ ...row, periodStart: isoDate(row.periodStart), periodEnd: isoDate(row.periodEnd) }))
    .filter((row) => payrollRangesOverlap(period, row))
}
