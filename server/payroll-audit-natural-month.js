import { payrollAuditRevision } from './payroll-audit-revision.js'
import { auditHash, formatCents, renderPayrollAuditHtml, renderPayrollAuditMarkdown, renderPayrollAuditEmail } from './payroll-audit-report.js'

const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const sum = (rows, key) => rows.reduce((n, row) => n + BigInt(row[key] || '0'), 0n).toString()

// Aggregate audited natural-month results; never invoke a payroll calculation here.
export function buildNaturalMonthSummary(input) {
  const revision = payrollAuditRevision(input.revision, 'MONTHLY_NATURAL_SUMMARY')
  const sources = [input.fullTimeSource, input.partTimeMonthlySource]
  for (const [index, source] of sources.entries()) {
    const m = source?.model
    if (!m || m.schemaVersion < 6 || m.metadata.reportType !== (index ? 'MONTHLY_PART_TIME' : 'MONTHLY_FULL_TIME_REVIEWED')
      || m.metadata.requestedPeriod.start !== input.periodStart || m.metadata.requestedPeriod.end !== input.periodEnd)
      fail('NATURAL_MONTH_SOURCE_MISSING_OR_INVALID')
    if (payrollAuditRevision(m.metadata.revision, m.metadata.reportType) !== revision) fail('NATURAL_MONTH_REVISION_MISMATCH')
    if (m.metadata.actualModel !== input.actualModel || m.metadata.actualReasoning !== input.actualReasoning) fail('MODEL_CONFIGURATION_MISMATCH')
  }
  const [full, part] = sources.map(s => s.model)
  if (full.metadata.authorityDigest !== part.metadata.authorityDigest || full.metadata.productionSha !== part.metadata.productionSha) fail('NATURAL_MONTH_SNAPSHOT_MISMATCH')
  const employees = [...full.employeeResults, ...part.employeeResults]
  if (new Set(employees.map(e => e.employeeId)).size !== employees.length) fail('NATURAL_MONTH_EMPLOYEE_DUPLICATE')
  for (const [index, source] of sources.entries()) for (const e of source.model.employeeResults) {
    if (e.employmentType !== (index ? 'parttime' : 'fulltime')) fail('NATURAL_MONTH_EMPLOYMENT_TYPE_MISMATCH')
    if (e.dailyReconciliation.some(d => d.date < input.periodStart || d.date > input.periodEnd)) fail('NATURAL_MONTH_DATE_OUTSIDE_RANGE')
    if (new Set(e.dailyReconciliation.map(d => d.date)).size !== e.dailyReconciliation.length) fail('NATURAL_MONTH_DATE_DUPLICATE')
    if (e.status === 'PASS' && e.authoritativePayrollCents != null && (!e.dailyPayrollBreakdownComplete || e.components.reduce((n,c)=>n+BigInt(c.amountCents),0n).toString() !== e.authoritativePayrollCents)) fail('NATURAL_MONTH_BREAKDOWN_INCOMPLETE')
  }
  const totals = sources.map(s => s.model.summary)
  const summary = { ...full.summary }
  for (const key of ['employeeCount','passCount','reviewRequiredCount','blockedCount','issueCount','anomalyCount','auditHintCount','noPayrollRequiredCount']) summary[key] = totals.reduce((n,s)=>n+Number(s[key]||0),0)
  for (const key of ['authoritativePayrollCents','employeeCardCents','differenceCents']) summary[key] = sum(totals,key)
  summary.finalResult = totals.some(s=>s.finalResult==='BLOCKED') ? 'BLOCKED' : totals.some(s=>s.finalResult!=='PASS') ? 'REVIEW_REQUIRED' : 'PASS'
  summary.settlementRecommendation = summary.finalResult === 'PASS' ? '可以进入独立结算复核' : '核实真实阻断与待复核问题后再结算'
  const model = {
    ...full,
    metadata: { ...full.metadata, reportType:'MONTHLY_NATURAL_SUMMARY', employeeType:'fulltime+parttime', scope:'ALL', generatedAt:input.generatedAt || full.metadata.generatedAt },
    employeeResults:employees, summary, finalRecommendation:summary.settlementRecommendation,
    naturalMonth:{ fullTimePayrollCents:full.summary.authoritativePayrollCents, partTimePayrollCents:part.summary.authoritativePayrollCents, fullTimeEmployeeCount:full.summary.employeeCount, partTimeEmployeeCount:part.summary.employeeCount },
    sourceReferences:sources.map(s=>({reportId:s.model.runId,canonicalHash:s.model.canonicalHash,reportType:s.model.metadata.reportType,period:s.model.metadata.requestedPeriod})),
    executionEvidence:{ mode:'NATURAL_MONTH_RESULT_AGGREGATION',sourceReportsRead:2,payrollCoreReexecuted:false,dailyStoreStaffRescanned:false },
  }
  const identity = { ...model,runId:'',canonicalHash:'',metadata:{...model.metadata,generatedAt:''} }
  model.runId=auditHash(identity).slice(0,24)
  model.canonicalHash=auditHash({...identity,runId:model.runId})
  return model
}

const monthNotice = '按自然月工资归属日期统计，不按转账日期；本报告审查已记录的权威事实，业务最终闭月及资料最终录齐需另行确认。当前用工类型不等同于完整历史类型。'
export function renderNaturalMonthHtml(model) {
  const n=model.naturalMonth,s=model.summary
  return renderPayrollAuditHtml(model).replace('薪酬审查报告','全职＋兼职自然月工资汇总').replace(/(<p class="safety">)([\s\S]*?)(<\/p>)/,`$1$2 ${monthNotice}$3`).replace('<div class="footer-note">',`<p class="safety">${monthNotice}</p><div class="footer-note">`)
    .replace(`<div><span>审查员工</span><b>${s.employeeCount} 人</b></div><div><span>薪酬权威</span><b>${formatCents(s.authoritativePayrollCents)}</b></div><div><span>员工薪酬卡片</span><b>${formatCents(s.employeeCardCents)}</b></div><div><span>总差额</span><b>${formatCents(s.differenceCents)}</b></div>`,
      `<div><span>全职应发小计 · ${n.fullTimeEmployeeCount}人</span><b>${formatCents(n.fullTimePayrollCents)}</b></div><div><span>兼职应发小计 · ${n.partTimeEmployeeCount}人</span><b>${formatCents(n.partTimePayrollCents)}</b></div><div><span>本月应发工资合计</span><b>${formatCents(s.authoritativePayrollCents)}</b></div><div><span>员工卡片总差额</span><b>${formatCents(s.differenceCents)}</b></div>`)
}
export function renderNaturalMonthMarkdown(model) {
  return renderPayrollAuditMarkdown(model).replace('全职员工月度薪酬审查报告','全职＋兼职自然月工资汇总') + `\n全职应发小计：${formatCents(model.naturalMonth.fullTimePayrollCents)}\n兼职应发小计：${formatCents(model.naturalMonth.partTimePayrollCents)}\n本月合计：${formatCents(model.summary.authoritativePayrollCents)}\n按工资归属日期统计，不按转账日期。\n`
}
export function renderNaturalMonthEmail(model) {
  const payload=renderPayrollAuditEmail(model)
  return {...payload,subject:payload.subject.replace('全职员工薪酬审查报告','全职＋兼职自然月工资汇总'),body:payload.body.replace('全职员工薪酬审查报告','全职＋兼职自然月工资汇总')+`\n全职应发：${formatCents(model.naturalMonth.fullTimePayrollCents)}；兼职应发：${formatCents(model.naturalMonth.partTimePayrollCents)}；合计：${formatCents(model.summary.authoritativePayrollCents)}。`}
}
