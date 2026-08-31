/**
 * Payroll 日期范围就绪度评估（纯函数，READINESS ONLY，零 live 消费）。
 *
 * 分离两个独立维度：
 * - CALCULATION READINESS：Employee.id-native 计算所需的金钱/考勤输入能否无身份猜测地表示。
 *   不要求 User 绑定（员工无账号也可以有工资）。
 * - ISSUE READINESS：计算就绪 + 每个待发放员工的收件人（User.employeeId 精确唯一匹配）。
 *
 * 边界：不落库、不发 notice、不切换 live payroll、不做"就绪则 legacy 回退"决策——
 * 只报告就绪状态，策略由未来 resolver/UI 决定。
 */

import { buildEmployeePayrollDayInputs } from './payrollShadowInput.js'
import { isDateInPayrollRange, resolvePayrollPeriod } from './payrollPeriod.js'

const CALC = 'CALCULATION_BLOCKER'
const ISSUE = 'ISSUE_BLOCKER'

/**
 * 评估规范化闭区间的 payroll 就绪度。旧 month 输入仍严格映射为整月，
 * 作为 MONTH 回归兼容接口。
 *
 * @param {object} input
 * @param {string} input.month YYYY-MM（显式；不做"当前缓存月"回退）
 * @param {object} input.dailyEntries 与 cached.entries 同构（仅该月相关行会被使用）
 * @param {Array}  input.dailyStoreStaffRows 该月 DailyStoreStaff 行
 * @param {Array}  [input.dailyPayAdjustments] 该月 DailyPayAdjustment 行
 * @param {Array}  [input.bigOrderBonuses] 该月 BigOrderBonus 行
 * @param {Array}  [input.employees] Employee 目录（含 id/status）
 * @param {Array}  [input.users] User 列表（含 employeeId/status/username）
 * @returns {object} { month, calculationReady, issueReady, calculationBlockers, issueBlockers, coverage, employees }
 */
export function evaluatePayrollReadiness(input) {
  const period = resolvePayrollPeriod(input)
  const month = period.month || String(input?.month || '')
  const entries = input?.dailyEntries && typeof input.dailyEntries === 'object' ? input.dailyEntries : {}
  const staffRows = Array.isArray(input?.dailyStoreStaffRows) ? input.dailyStoreStaffRows : []
  const adjustments = Array.isArray(input?.dailyPayAdjustments) ? input.dailyPayAdjustments : []
  const bonuses = Array.isArray(input?.bigOrderBonuses) ? input.bigOrderBonuses : []
  const users = Array.isArray(input?.users) ? input.users : []
  const employeeDirectory = Array.isArray(input?.employees) ? input.employees : []

  const calculationBlockers = []
  const issueBlockers = []
  const reasonCounts = {}

  const bump = (reason) => {
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1
  }

  if (!period.valid) {
    calculationBlockers.push({ type: CALC, reason: period.reason, detail: period.detail })
    bump(period.reason)
    return {
      month, periodType: '', periodKey: '', periodStart: '', periodEnd: '',
      calculationReady: false, issueReady: false,
      calculationBlockers, issueBlockers,
      coverage: { totalBusinessDays: 0, stableEligibleDays: 0, unresolvedDays: 0, reasonCounts },
      employees: [],
    }
  }

  // ---- 1) 考勤 + 业务日覆盖（复用 Gate 13 纯分类，行为不变）----
  const dayInput = buildEmployeePayrollDayInputs(entries, staffRows)
  const inRequestedRange = (row) => isDateInPayrollRange(row?.date, period.periodStart, period.periodEnd)
  const stable = dayInput.stableRows.filter(inRequestedRange)
  const legacy = dayInput.legacyUnknownRows.filter(inRequestedRange)
  const legacyCompatible = dayInput.legacyCompatibleRows.filter(inRequestedRange)
  const substitutes = dayInput.substituteRows.filter(inRequestedRange)
  const unresolved = dayInput.unresolvedDays

  const eligibleDays = new Set()
  for (const day of stable) {
    if (day.entryStatus !== 'JOINED') {
      calculationBlockers.push({
        type: CALC,
        reason: 'MISSING_DAILY_ENTRY',
        detail: `${day.storeId} ${day.date} 无营业记录`,
        employeeId: day.employeeId,
        storeId: day.storeId,
        date: day.date,
      })
      bump('MISSING_DAILY_ENTRY')
      continue
    }
    eligibleDays.add(`${day.storeId}|${day.date}`)
  }
  // LEGACY_UNKNOWN is fail-closed. Explicit substitutes and reviewed compatible
  // participants never force stable Employee.id payroll into name mode.
  const legacyByStoreDate = new Map()
  for (const row of legacy) {
    const key = `${row.storeId}|${row.date}`
    const g = legacyByStoreDate.get(key) || []
    g.push(row)
    legacyByStoreDate.set(key, g)
  }
  for (const [key] of legacyByStoreDate) {
    const [storeId, date] = key.split('|')
    calculationBlockers.push({ type: CALC, reason: 'LEGACY_UNKNOWN_PARTICIPANT', detail: `${storeId} ${date} 存在未解析运营参与者` })
    bump('LEGACY_UNKNOWN_PARTICIPANT')
  }
  for (const key of [...eligibleDays]) {
    if (legacyByStoreDate.has(key)) {
      const [storeId, date] = key.split('|')
      calculationBlockers.push({ type: CALC, reason: 'MIXED_STABLE_LEGACY', detail: `${storeId} ${date} 混有未解析 legacy 行` })
      bump('MIXED_STABLE_LEGACY')
      eligibleDays.delete(key)
    }
  }
  const directoryNameCounts = new Map()
  for (const employee of employeeDirectory) {
    const name = String(employee?.name || '').trim()
    if (name) directoryNameCounts.set(name, (directoryNameCounts.get(name) || 0) + 1)
  }
  for (const row of legacyCompatible) {
    const name = String(row.staffNameSnapshot || '').trim()
    if ((directoryNameCounts.get(name) || 0) > 1) {
      calculationBlockers.push({ type: CALC, reason: 'LEGACY_DUPLICATE_IDENTITY', detail: `${row.storeId} ${row.date} ${name} 对应多个员工` })
      bump('LEGACY_DUPLICATE_IDENTITY')
    }
  }
  // 请求范围之外的 unresolved 日不得污染当前周期就绪度。
  const rangeUnresolved = unresolved.filter(inRequestedRange)
  for (const u of rangeUnresolved) {
    calculationBlockers.push({
      type: CALC,
      reason: u.reason,
      detail: `${u.storeId || ''} ${u.date || ''}`,
      ...(Array.isArray(u.employeeIds) && u.employeeIds.length > 0 ? { employeeIds: u.employeeIds } : {}),
      ...(u.storeId ? { storeId: u.storeId } : {}),
      ...(u.date ? { date: u.date } : {}),
    })
    bump(u.reason)
  }
  // Draft facts are deliberately excluded from payroll math, but they remain
  // explicit readiness blockers so UI can distinguish today's normal pending
  // close from a historical incompleteness. No scheduled/assumed hours enter.
  const rangeDrafts = dayInput.excludedDraftDays.filter(inRequestedRange)
  for (const draft of rangeDrafts) {
    calculationBlockers.push({
      type: CALC,
      reason: draft.reason,
      detail: `${draft.storeId || ''} ${draft.date || ''}`,
      ...(Array.isArray(draft.employeeIds) && draft.employeeIds.length > 0 ? { employeeIds: draft.employeeIds } : {}),
      ...(draft.storeId ? { storeId: draft.storeId } : {}),
      ...(draft.date ? { date: draft.date } : {}),
    })
    bump(draft.reason)
  }

  // ---- 2) 考勤身份统计 ----
  const stableAttendanceRows = stable.filter((d) => ![...legacyByStoreDate.keys()].includes(`${d.storeId}|${d.date}`)).length
  const legacyAttendanceRows = legacy.length + legacyCompatible.length

  // ---- 3) DailyPayAdjustment 覆盖（范围内 legacy NULL 行 → 阻断）----
  let stableAdjustmentRows = 0
  let legacyAdjustmentRows = 0
  for (const a of adjustments) {
    const date = String(a.date || '').slice(0, 10)
    if (!isDateInPayrollRange(date, period.periodStart, period.periodEnd)) continue
    if (a.employeeId) stableAdjustmentRows += 1
    else {
      legacyAdjustmentRows += 1
      calculationBlockers.push({ type: CALC, reason: 'LEGACY_PAY_ADJUSTMENT_IDENTITY', detail: `${a.staffName || ''} ${date} 调整无稳定员工身份` })
      bump('LEGACY_PAY_ADJUSTMENT_IDENTITY')
    }
  }

  // ---- 4) BigOrderBonus 覆盖 ----
  let stableBonusRows = 0
  let legacyBonusRows = 0
  for (const b of bonuses) {
    const date = String(b.date || '').slice(0, 10)
    if (!isDateInPayrollRange(date, period.periodStart, period.periodEnd)) continue
    if (b.employeeId) stableBonusRows += 1
    else {
      legacyBonusRows += 1
      calculationBlockers.push({ type: CALC, reason: 'LEGACY_BIG_BONUS_IDENTITY', detail: `${b.staffName || ''} ${date} 奖金无稳定员工身份` })
      bump('LEGACY_BIG_BONUS_IDENTITY')
    }
  }

  // ---- 4A) 考勤权威与工资贡献权威分离（Gate 29Q）----
  // 调整/奖金拥有 Employee.id 只说明该笔贡献身份稳定，绝不能据此把整月
  // legacy-compatible 考勤切换为 Employee.id 考勤。
  const hasStableAttendance = stable.length > 0
  const hasLegacyCompatibleAttendance = legacyCompatible.length > 0
  const hasLegacyUnknownAttendance = legacy.length > 0
  let attendanceMode = 'NONE'
  if (hasStableAttendance && hasLegacyCompatibleAttendance) attendanceMode = 'MIXED_ATTENDANCE_AUTHORITY'
  else if (hasLegacyUnknownAttendance) attendanceMode = 'LEGACY_UNKNOWN'
  else if (hasStableAttendance) attendanceMode = 'EMPLOYEE_ID'
  else if (hasLegacyCompatibleAttendance) attendanceMode = 'LEGACY_COMPATIBLE'
  else if (stableAdjustmentRows > 0) attendanceMode = 'ADJUSTMENT_ONLY'
  else if (stableBonusRows > 0) attendanceMode = 'BONUS_ONLY'

  if (hasStableAttendance && hasLegacyCompatibleAttendance) {
    calculationBlockers.push({
      type: CALC,
      reason: 'MIXED_ATTENDANCE_AUTHORITY',
      detail: `${period.periodStart}～${period.periodEnd} 同时存在 EMPLOYEE 与 LEGACY_EMPLOYEE_COMPATIBLE 考勤，禁止静默选择单一引擎`,
    })
    bump('MIXED_ATTENDANCE_AUTHORITY')
  }

  if (hasLegacyCompatibleAttendance && (stableAdjustmentRows > 0 || stableBonusRows > 0)) {
    calculationBlockers.push({
      type: CALC,
      reason: 'STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE',
      detail: `${period.periodStart}～${period.periodEnd} legacy-compatible 考勤无法在无稳定桥接的情况下安全合并 Employee.id 调整或奖金`,
    })
    bump('STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE')
  }

  // legacy-compatible 工资可供兼容核对，但不能被误报为 Employee.id-native
  // 计算/发放就绪。其工资由 resolver 的 legacy compatibility 路径提供。
  if (hasLegacyCompatibleAttendance && !hasStableAttendance && stableAdjustmentRows === 0 && stableBonusRows === 0) {
    calculationBlockers.push({
      type: CALC,
      reason: 'LEGACY_COMPATIBLE_ATTENDANCE',
      detail: `${period.periodStart}～${period.periodEnd} 考勤仍为已复核 legacy-compatible 身份，仅允许兼容计算，不可发放`,
    })
    bump('LEGACY_COMPATIBLE_ATTENDANCE')
  }

  // 员工就绪度在计算就绪判定前构建：无任何稳定 payroll 主体（空月）→ 计算不就绪（确定性）
  // ---- 5) 按员工就绪度 ----
  const empMap = new Map()
  for (const day of stable) {
    if (!eligibleDays.has(`${day.storeId}|${day.date}`)) continue
    const rec = empMap.get(day.employeeId) || { employeeId: day.employeeId, days: 0 }
    rec.days += 1
    empMap.set(day.employeeId, rec)
  }
  // Gate 26：稳定调整仅日员工也是 payroll 主体——有显式 Employee.id 的调整即真实金钱指令，
  // 无考勤不构成 NO_PAYROLL_SUBJECTS；身份仅 employeeId，绝不按 name 推断。
  const adjustmentOnlyEmployeeIds = new Set()
  for (const a of adjustments) {
    if (!a.employeeId) continue // legacy NULL：LEGACY_PAY_ADJUSTMENT_IDENTITY 已在 §3 阻断
    const date = String(a.date || '').slice(0, 10)
    if (!isDateInPayrollRange(date, period.periodStart, period.periodEnd)) continue
    adjustmentOnlyEmployeeIds.add(a.employeeId)
  }
  for (const empId of adjustmentOnlyEmployeeIds) {
    if (!empMap.has(empId)) empMap.set(empId, { employeeId: empId, days: 0 })
  }
  const payrollEmployees = [...empMap.values()]

  const calculationReady = calculationBlockers.length === 0 && payrollEmployees.length > 0
  if (payrollEmployees.length === 0 && calculationBlockers.length === 0) {
    calculationBlockers.push({ type: CALC, reason: 'NO_PAYROLL_SUBJECTS', detail: `${period.periodStart}～${period.periodEnd} 无任何稳定工资主体` })
    bump('NO_PAYROLL_SUBJECTS')
  }

  const employees = payrollEmployees
    .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)))
    .map((rec) => {
      const blockers = calculationBlockers.filter((blocker) => {
        if (blocker.employeeId) return blocker.employeeId === rec.employeeId
        if (Array.isArray(blocker.employeeIds) && blocker.employeeIds.length > 0) return blocker.employeeIds.includes(rec.employeeId)
        return true
      })
      const employeeCalculationReady = blockers.length === 0
      // 收件人：Gate 18 语义——User.employeeId 精确匹配；status 规则沿用 Gate 18（active 才 eligible）
      const matches = users.filter((u) => u.employeeId === rec.employeeId && u.status === 'active')
      let issueReady = calculationReady && employeeCalculationReady
      if (issueReady) {
        if (matches.length === 0) {
          issueReady = false
          blockers.push({ type: ISSUE, reason: 'UNBOUND_PAYROLL_RECIPIENT', detail: `${rec.employeeId} 无绑定账号` })
        } else if (matches.length > 1) {
          issueReady = false
          blockers.push({ type: ISSUE, reason: 'DUPLICATE_PAYROLL_RECIPIENT', detail: `${rec.employeeId} 存在 ${matches.length} 个绑定账号` })
        }
      }
      return { employeeId: rec.employeeId, days: rec.days, calculationReady: employeeCalculationReady, issueReady, blockers }
    })

  const issueReadyEmployeeCount = employees.filter((e) => e.issueReady).length
  const issueBlockedEmployeeCount = employees.length - issueReadyEmployeeCount
  for (const e of employees) {
    for (const b of e.blockers) {
      if (b.type === ISSUE) {
        issueBlockers.push({ ...b, employeeId: e.employeeId })
        bump(b.reason)
      }
    }
  }

  const issueReady = calculationReady && issueBlockers.length === 0 && employees.length > 0

  // ---- 6) 覆盖率 ----
  const totalBusinessDays = Object.keys(entries).filter((k) => {
    const parts = k.split('|')
    if (parts.length !== 3 || parts[1] === 'all') return false
    const date = `${parts[0]}-${String(parts[2]).slice(3)}`
    return isDateInPayrollRange(date, period.periodStart, period.periodEnd)
  }).length

  return {
    month,
    periodType: period.periodType,
    periodKey: period.periodKey,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    calculationReady,
    issueReady,
    calculationBlockers,
    issueBlockers,
    coverage: {
      totalBusinessDays,
      stableEligibleDays: eligibleDays.size,
      unresolvedDays: rangeUnresolved.length + [...legacyByStoreDate.keys()].filter((k) => eligibleDays.size === 0 || ![...eligibleDays].includes(k)).length,
      stableAttendanceRows,
      legacyAttendanceRows,
      substituteAttendanceRows: substitutes.length,
      legacyCompatibleAttendanceRows: legacyCompatible.length,
      legacyUnknownAttendanceRows: legacy.length,
      excludedDraftDays: rangeDrafts.length,
      stableAdjustmentRows,
      legacyAdjustmentRows,
      stableBonusRows,
      legacyBonusRows,
      payrollEmployeeCount: employees.length,
      issueReadyEmployeeCount,
      issueBlockedEmployeeCount,
      reasonCounts,
      attendanceMode,
    },
    attendanceMode,
    employees,
  }
}
