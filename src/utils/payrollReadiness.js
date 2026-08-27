/**
 * Gate 22：payroll 月就绪度评估（纯函数，READINESS ONLY，零 live 消费）。
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

const CALC = 'CALCULATION_BLOCKER'
const ISSUE = 'ISSUE_BLOCKER'

/**
 * 评估某月（YYYY-MM）的 payroll 就绪度。
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
  const month = String(input?.month || '')
  const isMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
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

  if (!isMonth) {
    calculationBlockers.push({ type: CALC, reason: 'INVALID_MONTH', detail: `月份格式应为 YYYY-MM，收到 "${month}"` })
    bump('INVALID_MONTH')
    return {
      month, calculationReady: false, issueReady: false,
      calculationBlockers, issueBlockers,
      coverage: { totalBusinessDays: 0, stableEligibleDays: 0, unresolvedDays: 0, reasonCounts },
      employees: [],
    }
  }

  // ---- 1) 考勤 + 业务日覆盖（复用 Gate 13 纯分类，行为不变）----
  const dayInput = buildEmployeePayrollDayInputs(entries, staffRows)
  const inRequestedMonth = (row) => String(row?.date || '').slice(0, 7) === month
  const stable = dayInput.stableRows.filter(inRequestedMonth)
  const legacy = dayInput.legacyUnknownRows.filter(inRequestedMonth)
  const legacyCompatible = dayInput.legacyCompatibleRows.filter(inRequestedMonth)
  const substitutes = dayInput.substituteRows.filter(inRequestedMonth)
  const unresolved = dayInput.unresolvedDays

  const eligibleDays = new Set()
  for (const day of stable) {
    if (day.entryStatus !== 'JOINED') {
      calculationBlockers.push({ type: CALC, reason: 'MISSING_DAILY_ENTRY', detail: `${day.storeId} ${day.date} 无营业记录` })
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
    if (!date.startsWith(month)) continue
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
  // Gate 27 澄清：unresolved 日必须属于请求月——跨月条目（如历史无考勤月）不得污染当月就绪度
  // （模块契约 JSDoc："dailyEntries 仅该月相关行会被使用"；Gate 22 测试 I 月隔离同义）
  const monthUnresolved = unresolved.filter((u) => String(u.date || '').slice(0, 7) === month)
  for (const u of monthUnresolved) {
    calculationBlockers.push({ type: CALC, reason: u.reason, detail: `${u.storeId || ''} ${u.date || ''}` })
    bump(u.reason)
  }

  // ---- 2) 考勤身份统计 ----
  const stableAttendanceRows = stable.filter((d) => ![...legacyByStoreDate.keys()].includes(`${d.storeId}|${d.date}`)).length
  const legacyAttendanceRows = legacy.length + legacyCompatible.length

  // ---- 3) DailyPayAdjustment 覆盖（该月 legacy NULL 行 → 阻断）----
  let stableAdjustmentRows = 0
  let legacyAdjustmentRows = 0
  for (const a of adjustments) {
    const date = String(a.date || '').slice(0, 10)
    if (!date.startsWith(month)) continue
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
    if (!date.startsWith(month)) continue
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
      detail: `${month} 同时存在 EMPLOYEE 与 LEGACY_EMPLOYEE_COMPATIBLE 考勤，禁止静默选择单一引擎`,
    })
    bump('MIXED_ATTENDANCE_AUTHORITY')
  }

  if (hasLegacyCompatibleAttendance && (stableAdjustmentRows > 0 || stableBonusRows > 0)) {
    calculationBlockers.push({
      type: CALC,
      reason: 'STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE',
      detail: `${month} legacy-compatible 考勤无法在无稳定桥接的情况下安全合并 Employee.id 调整或奖金`,
    })
    bump('STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE')
  }

  // legacy-compatible 工资可供兼容核对，但不能被误报为 Employee.id-native
  // 计算/发放就绪。其工资由 resolver 的 legacy compatibility 路径提供。
  if (hasLegacyCompatibleAttendance && !hasStableAttendance && stableAdjustmentRows === 0 && stableBonusRows === 0) {
    calculationBlockers.push({
      type: CALC,
      reason: 'LEGACY_COMPATIBLE_ATTENDANCE',
      detail: `${month} 考勤仍为已复核 legacy-compatible 身份，仅允许兼容计算，不可发放`,
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
    if (!date.startsWith(month)) continue
    adjustmentOnlyEmployeeIds.add(a.employeeId)
  }
  for (const empId of adjustmentOnlyEmployeeIds) {
    if (!empMap.has(empId)) empMap.set(empId, { employeeId: empId, days: 0 })
  }
  const payrollEmployees = [...empMap.values()]

  const calculationReady = calculationBlockers.length === 0 && payrollEmployees.length > 0
  if (payrollEmployees.length === 0 && calculationBlockers.length === 0) {
    calculationBlockers.push({ type: CALC, reason: 'NO_PAYROLL_SUBJECTS', detail: `${month} 无任何稳定考勤员工` })
    bump('NO_PAYROLL_SUBJECTS')
  }

  const employees = payrollEmployees
    .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)))
    .map((rec) => {
      const blockers = []
      if (!calculationReady) blockers.push({ type: CALC, reason: 'MONTH_CALCULATION_NOT_READY' })
      // 收件人：Gate 18 语义——User.employeeId 精确匹配；status 规则沿用 Gate 18（active 才 eligible）
      const matches = users.filter((u) => u.employeeId === rec.employeeId && u.status === 'active')
      let issueReady = calculationReady
      if (calculationReady) {
        if (matches.length === 0) {
          issueReady = false
          blockers.push({ type: ISSUE, reason: 'UNBOUND_PAYROLL_RECIPIENT', detail: `${rec.employeeId} 无绑定账号` })
        } else if (matches.length > 1) {
          issueReady = false
          blockers.push({ type: ISSUE, reason: 'DUPLICATE_PAYROLL_RECIPIENT', detail: `${rec.employeeId} 存在 ${matches.length} 个绑定账号` })
        }
      }
      return { employeeId: rec.employeeId, days: rec.days, calculationReady, issueReady, blockers }
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
    return parts.length === 3 && parts[0] === month && parts[1] !== 'all'
  }).length

  return {
    month,
    calculationReady,
    issueReady,
    calculationBlockers,
    issueBlockers,
    coverage: {
      totalBusinessDays,
      stableEligibleDays: eligibleDays.size,
      unresolvedDays: monthUnresolved.length + [...legacyByStoreDate.keys()].filter((k) => eligibleDays.size === 0 || ![...eligibleDays].includes(k)).length,
      stableAttendanceRows,
      legacyAttendanceRows,
      substituteAttendanceRows: substitutes.length,
      legacyCompatibleAttendanceRows: legacyCompatible.length,
      legacyUnknownAttendanceRows: legacy.length,
      excludedDraftDays: dayInput.excludedDraftDays.length,
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
