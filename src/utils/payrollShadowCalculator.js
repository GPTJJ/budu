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

import { calcDailyPay, PAYABLE_HOURS_SOURCE } from './payroll.js'
import { buildEmployeePayrollDayInputs } from './payrollShadowInput.js'

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100

function bonusExplanation(rows) {
  return rows.map((row) => ({
    orderAmount: round2((Number(row.amountCents) || 0) / 100),
    bonusAmount: round2((Number(row.bonusCents) || 0) / 100),
    receiptPresent: Boolean(String(row.receipt || '').trim()),
  }))
}

function adjustmentExplanation(adjustment, automaticPay, finalPay) {
  if (!adjustment) return null
  return {
    automaticPay: round2(automaticPay),
    autoPaySnapshot: round2((Number(adjustment.autoPayCentsSnapshot) || 0) / 100),
    salaryAdjustment: round2(finalPay - automaticPay),
    finalPay: round2(finalPay),
    reason: adjustment.reason == null ? '' : String(adjustment.reason),
  }
}

/**
 * 计算某月 Employee.id shadow 月度工资。
 *
 * @param {object} dailyEntries 与 cached.entries 同构
 * @param {Array} dailyStoreStaffRows Gate 12 稳定考勤行
 * @param {Array} bigBonusRows Gate 10 大单奖行（含 employeeId/staffKey/bonusCents/date；可空）
 * @param {Array} payAdjustmentRows Gate 9 日薪调整行（含 employeeId/staffName/date/adjustedPayCents；可空）
 * @param {string} [month] YYYY-MM（Gate 26：稳定调整仅日贡献的月边界；不传则不过滤——Gate 14 兼容）
 * @param {object} [storeNames] storeKey → 展示名；仅用于解释元数据，不参与计算
 * @returns {{ employees: Array, unresolvedDays: Array, coverage: object }}
 */
export function calculateEmployeeIdShadowPayroll(dailyEntries, dailyStoreStaffRows, bigBonusRows = [], payAdjustmentRows = [], month = '', storeNames = {}) {
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
  for (const row of input.legacyUnknownRows) {
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
  const bonusRowsByEmpDate = new Map() // 同 employeeId+date 允许多笔，解释不可折成假单
  for (const b of Array.isArray(bigBonusRows) ? bigBonusRows : []) {
    if (!b.employeeId) continue // legacy NULL 不猜测
    const date = String(b.date || '').slice(0, 10)
    const key = `${b.employeeId}|${date}`
    bonusByEmpDate.set(key, (bonusByEmpDate.get(key) || 0) + (Number(b.bonusCents) || 0))
    const rows = bonusRowsByEmpDate.get(key) || []
    rows.push(b)
    bonusRowsByEmpDate.set(key, rows)
  }

  // ---- 日薪调整稳定读取（employeeId 精确；legacy NULL 不猜测）----
  const adjByEmpDate = new Map() // `${employeeId}|${date}` → adjustedPayCents
  const adjustmentRowByEmpDate = new Map()
  for (const a of Array.isArray(payAdjustmentRows) ? payAdjustmentRows : []) {
    if (!a.employeeId) continue
    const date = String(a.date || '').slice(0, 10)
    const key = `${a.employeeId}|${date}`
    adjByEmpDate.set(key, Number(a.adjustedPayCents) || 0)
    adjustmentRowByEmpDate.set(key, a)
  }

  // ---- 按 Employee.id 聚合 ----
  const empMap = new Map() // employeeId → result
  const newRec = (employeeId, displayName) => ({
    employeeId,
    displayName,
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
    dailyExplanations: [],
  })
  for (const day of eligible) {
    const empId = day.employeeId
    const rec = empMap.get(empId) || newRec(empId, day.staffNameSnapshot)
    empMap.set(empId, rec)
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
      payableHours: day.actualHours,
      payableHoursSource: PAYABLE_HOURS_SOURCE.ACTUAL_HOURS,
    })
    const employeeDayKey = `${empId}|${day.date}`
    const bonusCents = bonusByEmpDate.get(employeeDayKey) || 0
    const adjCents = adjByEmpDate.get(employeeDayKey)
    const adjustmentRow = adjustmentRowByEmpDate.get(employeeDayKey)
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
    const automaticPay = round2(autoPay / 100)
    const finalPay = round2((adjCents != null ? adjCents : autoPay) / 100)
    const displayWorkedRevenue = round2((day.dailyRevenueCents || 0) / 100 / share)
    rec.dailyExplanations.push({
      employeeId: empId,
      date: day.date,
      storeKey: day.storeKey || day.storeId,
      storeName: String(storeNames?.[day.storeKey || day.storeId] || ''),
      hours: daily.hours,
      baseRate: daily.baseRate,
      basePay: daily.basePay,
      commissionRate: daily.commissionRate,
      commission: daily.commission,
      transferSubsidyRate: daily.transferSubsidyRate,
      transferSubsidy: daily.transferSubsidy,
      bigBonus: round2(bonusCents / 100),
      automaticPay,
      salaryAdjustment: round2(finalPay - automaticPay),
      finalPay,
      explanation: {
        ...daily.explanation,
        state: daily.hours === 0 ? 'REAL_ZERO' : 'NORMAL',
        displayWorkedRevenue,
        bigOrderBonuses: bonusExplanation(bonusRowsByEmpDate.get(employeeDayKey) || []),
        adjustment: adjustmentExplanation(adjustmentRow, automaticPay, finalPay),
      },
    })
    empMap.set(empId, rec)
  }

  // ---- Gate 26：稳定调整仅日贡献（员工当日无考勤，仍可进入 Employee.id 月度 payroll）----
  // 概念上 payroll 贡献键 = 考勤日 ∪ 稳定调整 (employeeId,date)，按 employeeId+date 去重：
  // - 考勤日：既有正常计算（调整已覆盖，恰好一次）
  // - 仅调整日：automaticPay=0，salaryAdjustment = 调整额（Gate 9 契约：adjustedPayCents = 最终工资，
  //   非差额），月度贡献 = 调整额；负值/显式零原样保留
  // - 不虚构考勤/业绩；月边界严格（date 属于请求月才计入）；legacy NULL 调整不猜测身份
  const attendedKeys = new Set(eligible.map((d) => `${d.employeeId}|${d.date}`))
  const adjustmentOnlyKeys = new Set()
  for (const a of Array.isArray(payAdjustmentRows) ? payAdjustmentRows : []) {
    if (!a.employeeId) continue // legacy NULL 不猜测（Gate 13/26 冻结）
    const date = String(a.date || '').slice(0, 10)
    if (month && !date.startsWith(month)) continue // 月边界：7 月调整绝不进入 8 月 payroll
    const key = `${a.employeeId}|${date}`
    if (attendedKeys.has(key)) continue // 考勤日已应用（恰好一次，不重复）
    if (adjustmentOnlyKeys.has(key)) continue // 同 key 多行只计一次（与考勤日 Map 语义一致）
    adjustmentOnlyKeys.add(key)
    const adjCents = adjByEmpDate.get(key)
    if (adjCents == null) continue
    let rec = empMap.get(a.employeeId)
    if (!rec) {
      // 无考勤月也有真实金钱指令 → 可表示的 Employee.id 主体；显示名取调整快照（身份仍 employeeId）
      rec = newRec(a.employeeId, String(a.staffName || a.staffNameSnapshot || ''))
      empMap.set(a.employeeId, rec)
    }
    rec.salaryAdjustmentCents += adjCents // automaticPay=0 → 差额 = 最终调整额
    rec.salary += adjCents
    rec.adjustmentCount += 1
    const finalPay = round2(adjCents / 100)
    rec.dailyExplanations.push({
      employeeId: a.employeeId,
      date,
      storeKey: null,
      storeName: null,
      hours: 0,
      baseRate: null,
      basePay: 0,
      commissionRate: null,
      commission: 0,
      transferSubsidyRate: null,
      transferSubsidy: 0,
      bigBonus: 0,
      automaticPay: 0,
      salaryAdjustment: finalPay,
      finalPay,
      explanation: {
        state: 'ADJUSTMENT_ONLY',
        payableHours: 0,
        payableHoursSource: PAYABLE_HOURS_SOURCE.ADJUSTMENT_ONLY,
        participantCount: null,
        rawStoreRevenue: null,
        displayWorkedRevenue: null,
        commissionBasis: null,
        calculationDayPolicy: null,
        baseRate: null,
        basePay: 0,
        commissionTarget: null,
        commissionRate: null,
        commission: 0,
        transferSubsidyRate: null,
        transferSubsidy: 0,
        total: 0,
        bigOrderBonuses: [],
        adjustment: adjustmentExplanation(a, 0, finalPay),
      },
    })
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
    dailyExplanations: rec.dailyExplanations
      .slice()
      .sort((a, b) => `${a.date}|${a.storeKey || ''}`.localeCompare(`${b.date}|${b.storeKey || ''}`)),
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
