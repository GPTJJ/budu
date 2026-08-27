/**
 * Gate 27：PayrollIssueModal 稳定发放纯逻辑（PURE HELPER，零 live 计算决策）。
 *
 * 边界：不计算任何工资（金额一律来自 resolver payroll rec）；不做姓名匹配；
 * 收件人判定沿用 Gate 18/22 语义（User.employeeId active 精确匹配，fail closed）；
 * 本模块只做：snapshot 形状映射（含逐日明细）、Employee.id 富集、按选中员工的发放预检。
 */

import { employeeDailyPayDetail } from './selectors.js'
import { HOLIDAYS_2026, WORKDAYS_2026 } from './payroll.js'

/** 日标记（holiday/makeup/weekend/null）：工资条逐日展示（只读，无身份语义；与 payrollSlip.markOf 同构） */
function markOf(monthKey, dd) {
  const full = String(dd).includes('-') ? `${monthKey}-${String(dd).slice(3)}` : `${monthKey}-${String(dd)}`
  const isHolidayDay = HOLIDAYS_2026.has(full)
  const isMakeupDay = WORKDAYS_2026.has(full)
  const dow = new Date(`${full}T00:00:00`).getDay()
  const isWeekendDay = !isHolidayDay && !isMakeupDay && (dow === 0 || dow === 6)
  return isHolidayDay ? 'holiday' : isMakeupDay ? 'makeup' : isWeekendDay ? 'weekend' : null
}

/**
 * 把 resolver 的 Employee.id payroll rec 映射为 PayrollNotice snapshot。
 * Gate 27 澄清：summary 来自 resolver rec（权威月度聚合）；
 * days 复用已验收的 Employee.id 安全逐日明细 helper（employeeDailyPayDetail，Gate 25/26）：
 * - 考勤行/工时按 DailyStoreStaff.employeeId+date+store 精确（严格模式）
 * - 调整/大单奖按 employeeId；仅调整日输出调整独占日（工时 0、不虚构考勤）
 * - 无 name 归属金额；与导出明细口径一致
 * @param {object} rec resolver payroll rec
 * @param {object} [ctx] { month: 'YYYY-MM', name: 显示名, attendanceRows: 该月 DailyStoreStaff 行 }
 */
export function buildIssueSnapshot(rec, ctx) {
  const summary = {
    workedDays: rec.days || 0,
    payableHours: rec.payableHours ?? rec.actualHours ?? 0,
    revenue: rec.workedRevenue || 0,
    basePay: rec.basePay || 0,
    commission: rec.commission || 0,
    transferSubsidy: rec.transferSubsidy || 0,
    bigBonus: rec.bigBonus || 0,
    adjustment: rec.salaryAdjustment || 0,
    total: rec.salary || 0,
  }
  if (!ctx || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ctx.month || ''))) {
    return { days: [], summary }
  }
  const [y, m] = String(ctx.month).split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const days = []
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const detail = employeeDailyPayDetail(String(ctx.month), dd, ctx.name || '', rec.employeeId, ctx.attendanceRows)
    const t = detail ? detail.totals : null
    days.push({
      day: dd,
      mark: markOf(String(ctx.month), dd),
      revenue: t ? t.inc : 0,
      payableHours: t ? t.payableHours : 0,
      payableHoursSource: t ? t.payableHoursSource : null,
      basePay: t ? t.basePay : 0,
      commission: t ? t.commission : 0,
      transferSubsidy: t ? t.transferSubsidy : 0,
      bigBonus: t ? t.bigBonus : 0,
      adjustment: t ? t.salaryAdjustment || 0 : 0,
      pay: t ? t.pay : 0,
      hasData: Boolean(detail),
    })
  }
  return { days, summary }
}

/**
 * 发放行富集：主体 = resolver payroll subjects（Employee.id 权威）；
 * 展示字段仅按 Employee.id 从目录/结果快照取（目录缺失时用 rec 快照），绝不按 name 匹配金额。
 * @param {Array} payrollEmployees resolver.payroll.employees
 * @param {Array} readinessEmployees resolver.readiness.employees（per-employee issueReady/blockers）
 * @param {Array} users User 列表（含 employeeId/status/username）
 * @param {Map} dirById Employee.id → 目录员工（可选，仅展示）
 * @param {object} [snapCtx] buildIssueSnapshot 的 { month, attendanceRows } 上下文
 */
export function buildIssueRows(payrollEmployees, readinessEmployees, users = [], dirById = new Map(), snapCtx = null) {
  const readinessById = new Map((readinessEmployees || []).map((r) => [r.employeeId, r]))
  const activeUsers = (users || []).filter((u) => u.employeeId && u.status === 'active')
  return (payrollEmployees || []).map((rec) => {
    const dir = dirById.get(rec.employeeId)
    const matches = activeUsers.filter((u) => u.employeeId === rec.employeeId)
    const readiness = readinessById.get(rec.employeeId)
    const name = (dir && dir.name) || rec.displayName || ''
    return {
      employeeId: rec.employeeId,
      name,
      employeeNo: (dir && dir.employeeNo) || '',
      storeKey: (dir && dir.storeKey) || (Array.isArray(rec.storesWorked) && rec.storesWorked[0]) || '',
      type: (dir && dir.type) || '',
      rec,
      snapshot: buildIssueSnapshot(rec, snapCtx ? { ...snapCtx, name } : null),
      targetUsername: matches.length === 1 ? matches[0].username : '',
      matches,
      readiness,
      issueReady: Boolean(readiness && readiness.issueReady),
    }
  })
}

/**
 * 发放预检（发送第一个 POST 前校验全部选中员工）：
 * 1) 每名选中员工的 Gate 22 per-employee issueReady 必须为 true；
 * 2) Gate 27 澄清：选中员工 resolver salary < 0 → NEGATIVE_PAYROLL_TOTAL 阻断
 *    （服务端 totalCents<0 拒绝；仅 ISSUE 级阻断，不影响 calculationReady/展示/导出；
 *    显式零 salary 不阻断——沿用服务端既有行为）。
 * @returns {{ ok: boolean, blocked: Array<{employeeId, name, reason}> }}
 */
export function preflightIssueSelection(rows, selectedIds) {
  const selected = (rows || []).filter((r) => selectedIds.has(r.employeeId))
  const blocked = []
  for (const r of selected) {
    if (!r.issueReady) {
      blocked.push({ employeeId: r.employeeId, name: r.name || r.employeeId, reason: 'NOT_ISSUE_READY' })
    } else if (Number(r.rec.salary) < 0) {
      blocked.push({ employeeId: r.employeeId, name: r.name || r.employeeId, reason: 'NEGATIVE_PAYROLL_TOTAL' })
    }
  }
  return { ok: blocked.length === 0, blocked }
}

/** 发放请求行（金额/快照一律来自同一 Employee.id 的 resolver rec）。 */
export function buildIssuePayloadRows(pickedRows) {
  return pickedRows.map((r) => ({
    employeeId: r.employeeId,
    employeeName: r.name,
    storeKey: r.storeKey,
    snapshot: r.snapshot,
    totalCents: Math.round((r.rec.salary || 0) * 100),
  }))
}
