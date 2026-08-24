/**
 * Gate 14：Employee.id shadow 月度工资计算器（SHADOW ONLY，零 live 消费）。
 *
 * 用 Gate 13 的稳定 payroll 日输入（buildEmployeePayrollDayInputs）按 Employee.id
 * 做并行月度聚合，复用现有纯公式（calcDailyPay / bigBonusYuanMonth 稳定路径），
 * 证明既有薪酬公式可在稳定身份上运行，而不切换任何 live payroll。
 *
 * 边界：
 * - 绝不修改 monthlyPayrollFromEntries / PayrollPage / PayrollIssueModal / PayrollNotice
 * - 无 UI、无日志（live 路径）、无网络提交、无持久化
 * - 允许消费者：测试 only
 */

import { calcDailyPay } from './payroll.js'
import { buildEmployeePayrollDayInputs } from './payrollShadowInput.js'

/**
 * 计算某月 Employee.id shadow 月度工资。
 *
 * @param {object} dailyEntries 与 cached.entries 同构
 * @param {Array} dailyStoreStaffRows Gate 12 稳定考勤行
 * @param {Array} bigBonusRows Gate 10 大单奖行（含 employeeId/staffKey/bonusCents/date；可空）
 * @param {Array} payAdjustmentRows Gate 9 日薪调整行（含 employeeId/staffName/date/adjustedPayCents；可空）
 * @returns {{ employees: Array, unresolvedDays: Array, coverage: object }}
 */
export function calculateEmployeeIdShadowPayroll(dailyEntries, dailyStoreStaffRows, bigBonusRows = [], payAdjustmentRows = []) {
  const input = buildEmployeePayrollDayInputs(dailyEntries, dailyStoreStaffRows)
  const stable = input.stableRows
  const unresolvedDays = []

  // ---- 稳定资格判定：仅完整稳定覆盖的日进入 shadow 计算 ----
  // 按 (storeId, date) 分组检查：存在 legacy 行 → MIXED_STABLE_LEGACY
  const byStoreDate = new Map()
  for (const row of stable) {
    const key = `${row.storeId}|${row.date}`
    const g = byStoreDate.get(key) || []
    g.push(row)
    byStoreDate.set(key, g)
  }
  for (const row of input.legacyRows) {
    const key = `${row.storeId}|${row.date}`
    const g = byStoreDate.get(key)
    if (g) {
      // 同店同日混有 legacy 行 → 该日不可稳定计算
      for (const s of g) s._mixedLegacy = true
    }
  }

  // unresolved 日（Gate 13 已分类 + 本 Gate 的 mixed）
  for (const u of input.unresolvedDays) unresolvedDays.push(u)
  const mixedReasons = new Map()
  const eligible = stable.filter((row) => {
    if (row._mixedLegacy) {
      const key = `${row.storeId}|${row.date}`
      mixedReasons.set(key, 'MIXED_STABLE_LEGACY')
      return false
    }
    if (row.entryStatus !== 'JOINED') {
      const key = `${row.storeId}|${row.date}`
      mixedReasons.set(key, 'MISSING_DAILY_ENTRY')
      return false
    }
    return true
  })
  for (const [key, reason] of mixedReasons) {
    const [storeId, date] = key.split('|')
    unresolvedDays.push({ storeId, date, reason })
  }

  // ---- 大单奖稳定读取（employeeId 精确；legacy NULL 不猜测）----
  const bonusByEmpDate = new Map() // `${employeeId}|${date}` → cents
  for (const b of Array.isArray(bigBonusRows) ? bigBonusRows : []) {
    if (!b.employeeId) continue // legacy NULL 不猜测
    const date = String(b.date || '').slice(0, 10)
    bonusByEmpDate.set(`${b.employeeId}|${date}`, (bonusByEmpDate.get(`${b.employeeId}|${date}`) || 0) + (Number(b.bonusCents) || 0))
  }

  // ---- 日薪调整稳定读取（employeeId 精确；legacy NULL 不猜测）----
  const adjByEmpDate = new Map() // `${employeeId}|${date}` → adjustedPayCents
  for (const a of Array.isArray(payAdjustmentRows) ? payAdjustmentRows : []) {
    if (!a.employeeId) continue
    const date = String(a.date || '').slice(0, 10)
    adjByEmpDate.set(`${a.employeeId}|${date}`, Number(a.adjustedPayCents) || 0)
  }

  // ---- 按 Employee.id 聚合 ----
  const empMap = new Map() // employeeId → result
  for (const day of eligible) {
    const empId = day.employeeId
    const rec = empMap.get(empId) || {
      employeeId: empId,
      displayName: day.staffNameSnapshot,
      stores: new Set(),
      days: 0,
      actualHours: 0,
      basePay: 0,
      commission: 0,
      transferSubsidy: 0,
      bigBonusCents: 0,
      salaryAdjustmentCents: 0,
      salary: 0,
      // Gate 24 adapter：展示字段（营业分摊/订单/调整次数），不改任何金额公式
      workedRevenueCents: 0,
      orders: 0,
      adjustmentCount: 0,
    }
    rec.stores.add(day.storeId)
    rec.days += 1
    rec.actualHours += day.actualHours
    // 分摊展示（与 legacy 口径一致：营业额/订单按值班人数均摊）
    const share = day.staffCountForShare > 0 ? day.staffCountForShare : 1
    rec.workedRevenueCents += (day.dailyRevenueCents || 0) / share
    rec.orders += (day.orderCount || 0) / share
    // 复用现有纯日薪公式（同一薪酬政策，仅身份/输入源变化）
    const daily = calcDailyPay({
      storeKey: day.storeId,
      storeName: '',
      revenue: (day.dailyRevenueCents || 0) / 100,
      date: day.date,
      staffCount: day.staffCountForShare,
    })
    const bonusCents = bonusByEmpDate.get(`${empId}|${day.date}`) || 0
    const adjCents = adjByEmpDate.get(`${empId}|${day.date}`)
    rec.basePay += daily.basePay
    rec.commission += daily.commission
    rec.transferSubsidy += daily.transferSubsidy
    rec.bigBonusCents += bonusCents
    // 调整：有稳定调整则覆盖当日最终工资；无则自动工资
    const autoPay = daily.total * 100 + bonusCents // 分
    if (adjCents != null) {
      rec.salaryAdjustmentCents += adjCents - autoPay
      rec.salary += adjCents
      rec.adjustmentCount += 1
    } else {
      rec.salary += autoPay
    }
    empMap.set(empId, rec)
  }

  const employees = [...empMap.values()].map((rec) => ({
    employeeId: rec.employeeId,
    displayName: rec.displayName,
    storesWorked: [...rec.stores],
    days: rec.days,
    actualHours: Math.round(rec.actualHours * 100) / 100,
    workedRevenue: Math.round(rec.workedRevenueCents) / 100,
    orders: Math.round(rec.orders * 100) / 100,
    basePay: Math.round(rec.basePay * 100) / 100,
    adjustmentCount: rec.adjustmentCount,
    commission: Math.round(rec.commission * 100) / 100,
    transferSubsidy: Math.round(rec.transferSubsidy * 100) / 100,
    bigBonus: Math.round(rec.bigBonusCents) / 100,
    salaryAdjustment: Math.round(rec.salaryAdjustmentCents) / 100,
    salary: Math.round(rec.salary) / 100,
  }))

  // ---- 覆盖率 ----
  const totalDailyEntries = Object.keys(dailyEntries || {}).length
  const eligibleKeys = new Set(eligible.map((d) => `${d.storeId}|${d.date}`))
  const reasonCounts = {}
  for (const u of unresolvedDays) {
    reasonCounts[u.reason] = (reasonCounts[u.reason] || 0) + 1
  }

  return {
    employees,
    unresolvedDays,
    coverage: {
      totalDailyEntries,
      stableEligibleDays: eligibleKeys.size,
      unresolvedDaysCount: unresolvedDays.length,
      reasonCounts,
    },
  }
}
