/**
 * MONTH / WEEK / CUSTOM 统一 payroll 日期范围 resolver（纯函数）。
 *
 * 组合三个已验收组件，让未来 live 消费者不自行决定走哪条计算路径：
 *   1. evaluatePayrollReadiness()  → 月就绪度（计算/发放双维度）
 *   2. attendanceMode → confirmed payable attendance 选择计算权威
 *   3. calculateEmployeeIdShadowPayroll() → Employee.id-native / adjustment-only 计算
 *   4. monthlyPayrollFromEntries() → reviewed legacy-compatible 考勤的核对输出
 *
 * 契约：
 * - mode 保持 UI 兼容的 EMPLOYEE_ID / LEGACY；attendanceMode 显式区分
 *   EMPLOYEE_ID / LEGACY_COMPATIBLE / MIXED / UNKNOWN / ADJUSTMENT_ONLY / BONUS_ONLY
 * - LEGACY mode 的 issueReady 恒为 false（未来 cutover 不得经 Employee.id 发放契约发身份模糊工资）
 * - 已发放 PayrollNotice 快照不在本 resolver 范围（不可变，不重算）
 * - 无 API、无 React、无缓存变更、无持久化；调用方负责提供请求月数据
 */

import { evaluatePayrollReadiness } from './payrollReadiness.js'
import { calculateEmployeeIdRangePayroll } from './payrollShadowCalculator.js'
import { monthlyPayrollFromEntries } from './payroll.js'
import { buildEmployeePayrollDayInputs } from './payrollShadowInput.js'
import { PAYROLL_PARTICIPANT_TYPES } from '../../shared/payrollParticipantAuthority.js'
import { isDateInPayrollRange, resolvePayrollPeriod } from './payrollPeriod.js'

const SUBSTITUTE_DENOMINATOR_PREFIX = '__BUDU_NON_EMPLOYEE_SUBSTITUTE__:'

function contributionRowsForRange(rows, period) {
  return rows.filter((row) => (
    isDateInPayrollRange(row?.date, period.periodStart, period.periodEnd) && Boolean(row?.employeeId)
  ))
}

function evaluateAttendanceAuthority(entries, staffRows, adjustments, bonuses, period) {
  const input = buildEmployeePayrollDayInputs(entries, staffRows)
  const inRange = (row) => isDateInPayrollRange(row?.date, period.periodStart, period.periodEnd)
  const stableRows = input.stableRows.filter(inRange)
  const legacyCompatibleRows = input.legacyCompatibleRows.filter(inRange)
  const legacyUnknownRows = input.legacyUnknownRows.filter(inRange)
  const substituteRows = input.substituteRows.filter(inRange)
  const stableAdjustmentRows = contributionRowsForRange(adjustments, period)
  const stableBonusRows = contributionRowsForRange(bonuses, period)

  let mode = 'NONE'
  if (stableRows.length > 0 && legacyCompatibleRows.length > 0) mode = 'MIXED_ATTENDANCE_AUTHORITY'
  else if (legacyUnknownRows.length > 0) mode = 'LEGACY_UNKNOWN'
  else if (stableRows.length > 0) mode = 'EMPLOYEE_ID'
  else if (legacyCompatibleRows.length > 0) mode = 'LEGACY_COMPATIBLE'
  else if (stableAdjustmentRows.length > 0) mode = 'ADJUSTMENT_ONLY'
  else if (stableBonusRows.length > 0) mode = 'BONUS_ONLY'

  return {
    mode,
    stableRows,
    legacyCompatibleRows,
    legacyUnknownRows,
    substituteRows,
    stableAdjustmentRows,
    stableBonusRows,
  }
}

function compatibleLegacyEntries(entries, staffRows, employees, period) {
  const duplicateNames = new Set()
  const nameCounts = new Map()
  for (const employee of employees) {
    const name = String(employee?.name || '').trim()
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1)
  }
  for (const [name, count] of nameCounts) if (count > 1) duplicateNames.add(name)

  const namesByStoreDate = new Map()
  for (const row of staffRows) {
    if (!isDateInPayrollRange(row?.date, period.periodStart, period.periodEnd)) continue
    const participantType = row?.participantType
    const isCompatible = participantType === PAYROLL_PARTICIPANT_TYPES.LEGACY_EMPLOYEE_COMPATIBLE
    const isSubstitute = participantType === PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE
    if (!isCompatible && !isSubstitute) continue
    const displayName = String(row.staffNameSnapshot || '').trim()
    if (isCompatible && (!displayName || duplicateNames.has(displayName))) continue
    if (isSubstitute && !row.participantUserId) continue
    // Legacy formula uses the staff array as both salary subjects and the share
    // denominator. A synthetic non-person token preserves the denominator; the
    // resulting token row is discarded below and can never become a salary subject.
    const name = isSubstitute
      ? `${SUBSTITUTE_DENOMINATOR_PREFIX}${row.participantUserId || row.id || 'unknown'}`
      : displayName
    const store = row.storeId || row.storeKey || ''
    const date = String(row.date || '').slice(0, 10)
    const key = `${store}|${date}`
    const names = namesByStoreDate.get(key) || []
    names.push(name)
    namesByStoreDate.set(key, names)
  }

  const safe = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value?.status !== 'confirmed') continue
    const parts = key.split('|')
    if (parts.length !== 3) continue
    const date = `${parts[0]}-${String(parts[2]).slice(3)}`
    if (!isDateInPayrollRange(date, period.periodStart, period.periodEnd)) continue
    const names = namesByStoreDate.get(`${parts[1]}|${date}`)
    if (names?.length) safe[key] = { ...value, staff: names }
  }
  return safe
}

function stableAttendanceCoverage(authority, shadow) {
  const expected = new Set(authority.stableRows
    .filter((row) => row.entryStatus === 'JOINED')
    .map((row) => `${row.employeeId}|${row.storeKey || row.storeId}|${row.date}`))
  const represented = new Set()
  for (const employee of shadow.employees || []) {
    for (const day of employee.dailyExplanations || []) {
      if (day?.explanation?.state === 'ADJUSTMENT_ONLY') continue
      represented.add(`${employee.employeeId}|${day.storeKey || ''}|${day.date}`)
    }
  }
  const missing = [...expected].filter((key) => !represented.has(key))
  return { expected: expected.size, represented: expected.size - missing.length, missing }
}

function legacyAttendanceCoverage(authority, safeEntries) {
  const representedByStoreDateName = new Map()
  for (const [key, entry] of Object.entries(safeEntries)) {
    const parts = key.split('|')
    if (parts.length !== 3) continue
    const date = `${parts[0]}-${String(parts[2]).slice(3)}`
    for (const name of Array.isArray(entry?.staff) ? entry.staff : []) {
      const coverageKey = `${parts[1]}|${date}|${String(name || '').trim()}`
      representedByStoreDateName.set(coverageKey, (representedByStoreDateName.get(coverageKey) || 0) + 1)
    }
  }

  const missing = []
  for (const row of authority.legacyCompatibleRows) {
    const key = `${row.storeKey || row.storeId}|${row.date}|${String(row.staffNameSnapshot || '').trim()}`
    const remaining = representedByStoreDateName.get(key) || 0
    if (remaining > 0) representedByStoreDateName.set(key, remaining - 1)
    else missing.push(String(row.id || row.staffId || key))
  }
  return {
    expected: authority.legacyCompatibleRows.length,
    represented: authority.legacyCompatibleRows.length - missing.length,
    missing,
  }
}

function mergeBlockers(...groups) {
  const result = []
  const seen = new Set()
  for (const blocker of groups.flat()) {
    if (!blocker) continue
    const key = `${blocker.type || ''}|${blocker.reason || ''}|${blocker.employeeId || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(blocker)
  }
  return result
}

/**
 * 解析规范化 payroll 日期范围。旧 `{ month: 'YYYY-MM' }` 输入保持整月兼容。
 * @param {object} input 同 evaluatePayrollReadiness 输入 + 可选 storeNames
 * @returns {object} { month, mode, attendanceMode, calculationReady, issueReady, readiness, payroll, blockers }
 */
export function resolvePayrollCalculation(input) {
  const period = resolvePayrollPeriod(input)
  const month = period.month || String(input?.month || '')
  const entries = input?.dailyEntries && typeof input.dailyEntries === 'object' ? input.dailyEntries : {}
  const staffRows = Array.isArray(input?.dailyStoreStaffRows) ? input.dailyStoreStaffRows : []
  const adjustments = Array.isArray(input?.dailyPayAdjustments) ? input.dailyPayAdjustments : []
  const bonuses = Array.isArray(input?.bigOrderBonuses) ? input.bigOrderBonuses : []
  const users = Array.isArray(input?.users) ? input.users : []
  const storeNames = input?.storeNames && typeof input.storeNames === 'object' ? input.storeNames : {}
  const employees = Array.isArray(input?.employees) ? input.employees : []

  // ---- 1) 就绪度 ----
  const readiness = evaluatePayrollReadiness(input)
  if (!period.valid) {
    return {
      month,
      periodType: '', periodKey: '', periodStart: '', periodEnd: '',
      mode: 'EMPLOYEE_ID', attendanceMode: 'NONE', calculationReady: false, issueReady: false,
      readiness,
      payroll: { employees: [], unresolvedDays: [], coverage: readiness.coverage },
      blockers: readiness.calculationBlockers,
    }
  }
  const authority = evaluateAttendanceAuthority(entries, staffRows, adjustments, bonuses, period)

  // ---- 2) Employee.id attendance / adjustment-only ----
  // Stable contributions never select the attendance engine. Adjustment-only is
  // the one explicit no-attendance exception; bonus-only remains unsupported.
  if (authority.mode === 'EMPLOYEE_ID' || authority.mode === 'ADJUSTMENT_ONLY') {
    const shadow = calculateEmployeeIdRangePayroll(entries, staffRows, bonuses, adjustments, period, storeNames)
    const attendanceCoverage = stableAttendanceCoverage(authority, shadow)
    const coverageBlockers = attendanceCoverage.missing.length > 0
      ? [{ type: 'CALCULATION_BLOCKER', reason: 'PAYROLL_SUBJECT_COVERAGE_INCOMPLETE', detail: `缺失 ${attendanceCoverage.missing.length} 个稳定考勤身份日`, missing: attendanceCoverage.missing }]
      : []
    const blockers = mergeBlockers(readiness.calculationBlockers, readiness.issueBlockers, coverageBlockers)
    const calculationReady = readiness.calculationReady && coverageBlockers.length === 0
    return {
      month,
      ...period,
      mode: 'EMPLOYEE_ID',
      attendanceMode: authority.mode,
      calculationReady,
      issueReady: calculationReady && readiness.issueReady,
      readiness,
      payroll: { ...shadow, attendanceCoverage },
      blockers,
    }
  }

  // Unknown or mixed attendance has no formally safe complete composition.
  // Fail closed with an empty positive-payroll output and complete diagnostics.
  if (authority.mode === 'LEGACY_UNKNOWN' || authority.mode === 'MIXED_ATTENDANCE_AUTHORITY') {
    const explicit = authority.mode === 'MIXED_ATTENDANCE_AUTHORITY'
      ? { type: 'CALCULATION_BLOCKER', reason: 'MIXED_ATTENDANCE_AUTHORITY', detail: `${period.periodStart}～${period.periodEnd} 同时存在稳定与 legacy-compatible 考勤` }
      : { type: 'CALCULATION_BLOCKER', reason: 'LEGACY_UNKNOWN_PARTICIPANT', detail: `${period.periodStart}～${period.periodEnd} 存在身份未知的考勤参与者` }
    return {
      month,
      ...period,
      mode: authority.stableRows.length > 0 ? 'EMPLOYEE_ID' : 'LEGACY',
      attendanceMode: authority.mode,
      calculationReady: false,
      issueReady: false,
      readiness,
      payroll: {
        employees: [],
        unresolvedDays: readiness.coverage ? readiness.coverage.unresolvedDays : 0,
        coverage: readiness.coverage,
        attendanceCoverage: {
          expectedStable: authority.stableRows.length,
          expectedLegacyCompatible: authority.legacyCompatibleRows.length,
          unknown: authority.legacyUnknownRows.length,
          blocked: true,
        },
      },
      blockers: mergeBlockers(readiness.calculationBlockers, readiness.issueBlockers, [explicit]),
    }
  }

  // ---- 3) legacy 兼容输出（公式零改动；不合成 Employee.id；issueReady 恒 false）----
  const safeLegacyEntries = compatibleLegacyEntries(entries, staffRows, employees, period)
  const legacy = period.periodType === 'month'
    ? monthlyPayrollFromEntries(safeLegacyEntries, month, storeNames)
    : new Map()
  const legacyRows = [...legacy.values()]
    .filter((rec) => !String(rec.name || '').startsWith(SUBSTITUTE_DENOMINATOR_PREFIX))
    .map((rec) => ({
    name: rec.name,
    stores: rec.stores || [],
    workedDays: rec.workedDays || 0,
    workedRevenue: rec.workedRevenue || 0,
    hours: rec.hours || 0,
    basePay: rec.basePay || 0,
    commission: rec.commission || 0,
    transferSubsidy: rec.transferSubsidy || 0,
    bigBonus: rec.big || rec.bigBonus || 0,
    salary: rec.salary || 0,
    }))
  const attendanceCoverage = legacyAttendanceCoverage(authority, safeLegacyEntries)
  const coverageBlockers = attendanceCoverage.missing.length > 0
    ? [{ type: 'CALCULATION_BLOCKER', reason: 'PAYROLL_SUBJECT_COVERAGE_INCOMPLETE', detail: `缺失 ${attendanceCoverage.missing.length} 个 legacy-compatible 考勤身份日`, missing: attendanceCoverage.missing }]
    : []
  const stableContributionBlockers = authority.mode === 'LEGACY_COMPATIBLE'
    && (authority.stableAdjustmentRows.length > 0 || authority.stableBonusRows.length > 0)
    ? [{ type: 'CALCULATION_BLOCKER', reason: 'STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE', detail: `${period.periodStart}～${period.periodEnd} 稳定贡献无法在无身份桥接时安全合并至 legacy-compatible 考勤` }]
    : []

  return {
    month,
    ...period,
    mode: 'LEGACY',
    attendanceMode: authority.mode,
    calculationReady: false,
    issueReady: false,
    readiness,
    payroll: {
      employees: legacyRows,
      unresolvedDays: readiness.coverage ? readiness.coverage.unresolvedDays : 0,
      coverage: readiness.coverage,
      attendanceCoverage,
    },
    blockers: mergeBlockers(readiness.calculationBlockers, coverageBlockers, stableContributionBlockers),
  }
}
