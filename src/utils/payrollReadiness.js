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
  const stable = dayInput.stableRows
  const legacy = dayInput.legacyRows
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
  // mixed stable/legacy 日：Gate 13 已把 legacy 行分入 legacyRows；凡同日同店存在 legacy 行即不可稳定计算
  const legacyByStoreDate = new Map()
  for (const row of legacy) {
    const key = `${row.storeId}|${row.date}`
    const g = legacyByStoreDate.get(key) || []
    g.push(row)
    legacyByStoreDate.set(key, g)
  }
  for (const key of [...eligibleDays]) {
    if (legacyByStoreDate.has(key)) {
      const [storeId, date] = key.split('|')
      calculationBlockers.push({ type: CALC, reason: 'MIXED_STABLE_LEGACY', detail: `${storeId} ${date} 混有 legacy 考勤行` })
      bump('MIXED_STABLE_LEGACY')
      eligibleDays.delete(key)
    }
  }
  for (const u of unresolved) {
    calculationBlockers.push({ type: CALC, reason: u.reason, detail: `${u.storeId || ''} ${u.date || ''}` })
    bump(u.reason)
  }

  // ---- 2) 考勤身份统计 ----
  const stableAttendanceRows = stable.filter((d) => ![...legacyByStoreDate.keys()].includes(`${d.storeId}|${d.date}`)).length
  const legacyAttendanceRows = legacy.length

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

  const calculationReady = calculationBlockers.length === 0

  // ---- 5) 按员工就绪度 ----
  const empMap = new Map()
  for (const day of stable) {
    if (!eligibleDays.has(`${day.storeId}|${day.date}`)) continue
    const rec = empMap.get(day.employeeId) || { employeeId: day.employeeId, days: 0 }
    rec.days += 1
    empMap.set(day.employeeId, rec)
  }
  const employees = [...empMap.values()]
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
      unresolvedDays: unresolved.length + [...legacyByStoreDate.keys()].filter((k) => eligibleDays.size === 0 || ![...eligibleDays].includes(k)).length,
      stableAttendanceRows,
      legacyAttendanceRows,
      stableAdjustmentRows,
      legacyAdjustmentRows,
      stableBonusRows,
      legacyBonusRows,
      payrollEmployeeCount: employees.length,
      issueReadyEmployeeCount,
      issueBlockedEmployeeCount,
      reasonCounts,
    },
    employees,
  }
}
