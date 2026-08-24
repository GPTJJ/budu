/**
 * Gate 23：统一 payroll 计算 resolver（纯函数，PURE RESOLVER ONLY，零 live 消费）。
 *
 * 组合三个已验收组件，让未来 live 消费者不自行决定走哪条计算路径：
 *   1. evaluatePayrollReadiness()  → 月就绪度（计算/发放双维度）
 *   2. calculateEmployeeIdShadowPayroll() → Employee.id-native 计算（readiness.calculationReady 时）
 *   3. monthlyPayrollFromEntries() → legacy 计算（readiness.calculationReady=false 时兼容输出）
 *
 * 契约：
 * - mode 显式 EMPLOYEE_ID / LEGACY，绝不静默降级
 * - LEGACY mode 的 issueReady 恒为 false（未来 cutover 不得经 Employee.id 发放契约发身份模糊工资）
 * - 已发放 PayrollNotice 快照不在本 resolver 范围（不可变，不重算）
 * - 无 API、无 React、无缓存变更、无持久化；调用方负责提供请求月数据
 */

import { evaluatePayrollReadiness } from './payrollReadiness.js'
import { calculateEmployeeIdShadowPayroll } from './payrollShadowCalculator.js'
import { monthlyPayrollFromEntries } from './payroll.js'

/**
 * 解析某月（YYYY-MM）payroll 计算。
 * @param {object} input 同 evaluatePayrollReadiness 输入 + 可选 storeNames
 * @returns {object} { month, mode, calculationReady, issueReady, readiness, payroll, blockers }
 */
export function resolvePayrollCalculation(input) {
  const month = String(input?.month || '')
  const isMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  const entries = input?.dailyEntries && typeof input.dailyEntries === 'object' ? input.dailyEntries : {}
  const staffRows = Array.isArray(input?.dailyStoreStaffRows) ? input.dailyStoreStaffRows : []
  const adjustments = Array.isArray(input?.dailyPayAdjustments) ? input.dailyPayAdjustments : []
  const bonuses = Array.isArray(input?.bigOrderBonuses) ? input.bigOrderBonuses : []
  const users = Array.isArray(input?.users) ? input.users : []
  const storeNames = input?.storeNames && typeof input.storeNames === 'object' ? input.storeNames : {}

  // ---- 1) 就绪度 ----
  const readiness = evaluatePayrollReadiness(input)
  const calculationReady = isMonth && readiness.calculationReady

  // ---- 2) 引擎选择 ----
  if (calculationReady) {
    const shadow = calculateEmployeeIdShadowPayroll(entries, staffRows, bonuses, adjustments)
    return {
      month,
      mode: 'EMPLOYEE_ID',
      calculationReady: true,
      issueReady: readiness.issueReady,
      readiness,
      payroll: shadow,
      blockers: readiness.issueBlockers,
    }
  }

  // ---- 3) legacy 兼容输出（公式零改动；不合成 Employee.id；issueReady 恒 false）----
  const legacy = isMonth
    ? monthlyPayrollFromEntries(entries, month, storeNames)
    : new Map()
  const legacyRows = [...legacy.values()].map((rec) => ({
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

  return {
    month,
    mode: 'LEGACY',
    calculationReady: false,
    issueReady: false,
    readiness,
    payroll: { employees: legacyRows, unresolvedDays: readiness.coverage ? readiness.coverage.unresolvedDays : 0, coverage: readiness.coverage },
    blockers: readiness.calculationBlockers,
  }
}
