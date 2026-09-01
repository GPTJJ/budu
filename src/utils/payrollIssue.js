/**
 * Gate 27：PayrollIssueModal 稳定发放纯逻辑（PURE HELPER，零 live 计算决策）。
 *
 * 边界：不计算任何工资（金额一律来自 resolver payroll rec）；不做姓名匹配；
 * 收件人判定沿用 Gate 18/22 语义（User.employeeId active 精确匹配，fail closed）；
 * 本模块只做：snapshot 形状映射（含逐日明细）、Employee.id 富集、按选中员工的发放预检。
 */

import { HOLIDAYS_2026, WORKDAYS_2026 } from './payroll.js'
import { businessDateDayOfWeek, isBusinessDate, resolvePayrollPeriod } from './payrollPeriod.js'
import { PAYROLL_ISSUANCE_SNAPSHOT_VERSION } from '../../shared/payrollIssuanceContract.js'

/** 日标记（holiday/makeup/weekend/null）：工资条逐日展示（只读，无身份语义；与 payrollSlip.markOf 同构） */
function markOf(full) {
  const isHolidayDay = HOLIDAYS_2026.has(full)
  const isMakeupDay = WORKDAYS_2026.has(full)
  const dow = businessDateDayOfWeek(full)
  const isWeekendDay = !isHolidayDay && !isMakeupDay && (dow === 0 || dow === 6)
  return isHolidayDay ? 'holiday' : isMakeupDay ? 'makeup' : isWeekendDay ? 'weekend' : null
}

/**
 * 把 resolver 的 Employee.id payroll rec 映射为 PayrollNotice snapshot。
 * summary 和 days 都直接映射同一个 resolver 结果，不调用 selector 或第二套公式。
 * @param {object} rec resolver payroll rec
 * @param {object} [ctx] { month: 'YYYY-MM', name: 显示名, attendanceRows: 该月 DailyStoreStaff 行 }
 */
export function buildIssueSnapshot(rec, ctx) {
  const period = resolvePayrollPeriod(ctx || {})
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
  const days = (rec.dailyExplanations || [])
    .filter((row) => isBusinessDate(row?.date))
    .map((row) => ({
      date: row.date,
      day: row.date,
      mark: markOf(row.date),
      employeeId: rec.employeeId,
      storeKey: row.storeKey || null,
      storeName: row.storeName || null,
      payableHours: row.payableHours ?? row.hours ?? row.explanation?.payableHours ?? 0,
      payableHoursSource: row.payableHoursSource || row.explanation?.payableHoursSource || null,
      participantCount: row.explanation?.participantCount ?? null,
      rawStoreRevenue: row.explanation?.rawStoreRevenue ?? null,
      displayWorkedRevenue: row.explanation?.displayWorkedRevenue ?? null,
      commissionBasis: row.explanation?.commissionBasis ?? null,
      calculationDayPolicy: row.explanation?.calculationDayPolicy ?? null,
      baseRate: row.baseRate ?? row.explanation?.baseRate ?? null,
      basePay: row.basePay || 0,
      commissionRate: row.commissionRate ?? row.explanation?.commissionRate ?? null,
      commission: row.commission || 0,
      transferSubsidyRate: row.explanation?.transferSubsidyRate ?? null,
      transferSubsidy: row.transferSubsidy || 0,
      bigBonus: row.bigBonus || 0,
      adjustment: row.salaryAdjustment || 0,
      automaticPay: row.automaticPay || 0,
      pay: row.finalPay || 0,
      explanation: row.explanation || null,
      hasData: true,
    }))
    .sort((a, b) => `${a.date}|${a.storeKey || ''}`.localeCompare(`${b.date}|${b.storeKey || ''}`))
  return {
    period: period.valid
      ? {
          periodType: period.periodType,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        }
      : null,
    employeeId: rec.employeeId,
    days,
    summary,
  }
}

/**
 * 发放行富集：主体 = resolver payroll subjects（Employee.id 权威）；
 * 展示字段仅按 Employee.id 从目录/结果快照取（目录缺失时用 rec 快照），绝不按 name 匹配金额。
 * @param {Array} payrollEmployees resolver.payroll.employees
 * @param {Array} readinessEmployees resolver.readiness.employees（per-employee issueReady/blockers）
 * @param {Array} users User 列表（含 employeeId/status/username）
 * @param {Map} dirById Employee.id → 目录员工（可选，仅展示）
 * @param {object} [snapCtx] canonical period 上下文
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
      employeeNo: (dir && dir.employeeNo) || '',
      name,
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
 * Bind the issuance list to the server preflight row that the submit guard also
 * recomputes. Local payroll remains useful while loading, but it is never the
 * submitted snapshot authority.
 */
export function bindAuthoritativeIssuePreflight(row, server) {
  const hasCanonicalSnapshot = Boolean(
    server
    && server.employeeId === row.employeeId
    && server.snapshotVersion === PAYROLL_ISSUANCE_SNAPSHOT_VERSION
    && typeof server.snapshotDigest === 'string'
    && server.snapshotDigest.length === 64
    && server.snapshot
    && typeof server.snapshot === 'object',
  )
  const summary = hasCanonicalSnapshot ? server.snapshot.summary || {} : {}
  const canonicalIssue = hasCanonicalSnapshot
    ? {
        employeeId: server.employeeId,
        employeeName: server.employeeName,
        storeKey: server.storeKey,
        totalCents: Number(server.totalCents),
        snapshot: server.snapshot,
        snapshotVersion: server.snapshotVersion,
        snapshotDigest: server.snapshotDigest,
      }
    : null
  return {
    ...row,
    server,
    canonicalIssue,
    name: canonicalIssue?.employeeName || row.name,
    storeKey: canonicalIssue?.storeKey || row.storeKey,
    snapshot: canonicalIssue?.snapshot || row.snapshot,
    rec: canonicalIssue
      ? {
          ...row.rec,
          days: summary.workedDays ?? row.rec.days,
          payableHours: summary.payableHours ?? row.rec.payableHours,
          workedRevenue: summary.revenue ?? row.rec.workedRevenue,
          basePay: summary.basePay ?? row.rec.basePay,
          commission: summary.commission ?? row.rec.commission,
          transferSubsidy: summary.transferSubsidy ?? row.rec.transferSubsidy,
          bigBonus: summary.bigBonus ?? row.rec.bigBonus,
          salaryAdjustment: summary.adjustment ?? row.rec.salaryAdjustment,
          salary: Number(server.totalCents) / 100,
        }
      : row.rec,
    issueReady: Boolean(server?.issueReady && canonicalIssue && Number.isInteger(canonicalIssue.totalCents)),
    overlap: Boolean(server?.overlaps?.length),
  }
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

/** 发放请求行（金额/快照一律来自服务器 canonical preflight）。 */
export function buildIssuePayloadRows(pickedRows) {
  return pickedRows.map((row) => {
    if (!row.canonicalIssue) throw new Error('工资发放快照已过期，请刷新后重试')
    return { ...row.canonicalIssue }
  })
}
