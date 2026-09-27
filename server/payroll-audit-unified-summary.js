import fs from 'node:fs'

import { auditHash, formatCents, payrollAuditSourceMark } from './payroll-audit-report.js'

const WORDMARK_SVG = fs.readFileSync(new URL('../brand/web/budu-wordmark.svg', import.meta.url), 'utf8')
const WORDMARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(WORDMARK_SVG).toString('base64')}`
export const UNIFIED_AGGREGATION_VERSION = 1

const text = (value) => String(value == null ? '' : value)
const cents = (value) => BigInt(text(value || '0'))
const add = (values) => values.reduce((sum, value) => sum + cents(value), 0n).toString()
const iso = (date) => new Date(`${date}T00:00:00.000Z`)
const dateString = (date) => date.toISOString().slice(0, 10)
const sourceKey = (start, end) => `${start}:${end}`
const componentCents = (employee, key) => text((employee.components || []).find((row) => row.key === key)?.amountCents || '0')
const escapeHtml = (value) => text(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

export function expectedPartTimeWeeklyPeriods(periodStart, periodEnd) {
  const start = iso(periodStart)
  const end = iso(periodEnd)
  const monday = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86400000)
  const periods = []
  for (let cursor = monday; cursor <= end; cursor = new Date(cursor.getTime() + 7 * 86400000)) {
    periods.push({
      periodStart: dateString(cursor),
      periodEnd: dateString(new Date(cursor.getTime() + 6 * 86400000)),
    })
  }
  return periods
}

function aggregateFullTime(source) {
  const employees = source?.model?.employeeResults || []
  const issues = employees.flatMap((employee) => (employee.issues || []).map((issue) => ({
    employeeId: employee.employeeId,
    employeeName: employee.employeeName,
    sourceReportId: source.model.runId,
    sourcePeriod: source.model.metadata.requestedPeriod,
    type: issue.type,
  })))
  return {
    employeeCount: employees.length,
    payableHours: employees.reduce((sum, employee) => sum + Number(employee.payableHours || 0), 0),
    basePayCents: add(employees.map((employee) => componentCents(employee, 'basePay'))),
    overtimeCents: add(employees.map((employee) => componentCents(employee, 'overtimePay'))),
    commissionCents: add(employees.map((employee) => componentCents(employee, 'commission'))),
    totalCents: add(employees.map((employee) => employee.authoritativePayrollCents)),
    reviewRequiredCount: employees.filter((employee) => employee.status === 'REVIEW_REQUIRED').length,
    anomalyEmployeeCount: employees.filter((employee) => employee.status !== 'PASS' || employee.issues?.length).length,
    issues,
  }
}

function aggregatePartTime(sources, periodStart, periodEnd) {
  const employeeIds = new Set()
  const reviewIds = new Set()
  const anomalyIds = new Set()
  const issues = []
  let payableHours = 0
  const componentTotals = new Map()
  let total = 0n
  for (const source of sources) {
    for (const employee of source.model.employeeResults || []) {
      employeeIds.add(employee.employeeId)
      if (employee.status === 'REVIEW_REQUIRED') reviewIds.add(employee.employeeId)
      if (employee.status !== 'PASS' || employee.issues?.length) anomalyIds.add(employee.employeeId)
      for (const issue of employee.issues || []) {
        issues.push({ employeeId: employee.employeeId, employeeName: employee.employeeName, sourceReportId: source.model.runId, sourcePeriod: source.model.metadata.requestedPeriod, type: issue.type })
      }
      if (employee.dailyPayrollBreakdownComplete !== true) continue
      for (const day of employee.dailyReconciliation || []) {
        if (day.date < periodStart || day.date > periodEnd) continue
        payableHours += Number(day.payableHours || 0)
        total += cents(day.payroll?.totalCents)
        for (const [key, value] of Object.entries(day.payroll?.components || {})) {
          componentTotals.set(key, (componentTotals.get(key) || 0n) + cents(value))
        }
      }
    }
  }
  return {
    employeeCount: employeeIds.size,
    payableHours,
    basePayCents: text(componentTotals.get('basePay') || 0n),
    overtimeCents: text(componentTotals.get('overtimePay') || 0n),
    commissionCents: text(componentTotals.get('commission') || 0n),
    totalCents: text(total),
    reviewRequiredCount: reviewIds.size,
    anomalyEmployeeCount: anomalyIds.size,
    issues,
  }
}

export function buildUnifiedMonthlyPayrollSummary(input = {}) {
  const { periodStart, periodEnd, actualModel, actualReasoning } = input
  const fullTimeSource = input.fullTimeSource || null
  const weeklySources = Array.isArray(input.partTimeSources) ? input.partTimeSources : []
  const expectedWeeks = expectedPartTimeWeeklyPeriods(periodStart, periodEnd)
  const weeklyByPeriod = new Map(weeklySources.map((source) => [sourceKey(source.model.metadata.requestedPeriod.start, source.model.metadata.requestedPeriod.end), source]))
  const includedWeeklySources = expectedWeeks.map((period) => weeklyByPeriod.get(sourceKey(period.periodStart, period.periodEnd))).filter(Boolean)
  const missingPartTimePeriods = expectedWeeks.filter((period) => !weeklyByPeriod.has(sourceKey(period.periodStart, period.periodEnd)))
  const insufficientPartTimeSourceIds = includedWeeklySources
    .filter((source) => source.model.schemaVersion < 5 || (source.model.employeeResults || []).some((employee) => employee.dailyPayrollBreakdownComplete !== true))
    .map((source) => source.model.runId)
  const fullTimeMissing = !fullTimeSource
    || fullTimeSource.model.metadata.reportType !== 'MONTHLY_FULL_TIME'
    || fullTimeSource.model.metadata.requestedPeriod.start !== periodStart
    || fullTimeSource.model.metadata.requestedPeriod.end !== periodEnd
  const fullTime = aggregateFullTime(fullTimeMissing ? null : fullTimeSource)
  const partTime = aggregatePartTime(includedWeeklySources, periodStart, periodEnd)
  const sourceProblems = [
    ...(fullTimeMissing ? ['SOURCE_REPORT_MISSING:MONTHLY_FULL_TIME'] : []),
    ...missingPartTimePeriods.map((period) => `SOURCE_REPORT_MISSING:WEEKLY_PART_TIME:${period.periodStart}:${period.periodEnd}`),
    ...insufficientPartTimeSourceIds.map((runId) => `MONTH_BOUNDARY_SOURCE_INSUFFICIENT:${runId}`),
  ]
  const sourceResults = [fullTimeSource, ...includedWeeklySources].filter(Boolean).map((source) => source.model.summary.finalResult)
  const result = sourceProblems.length
    ? 'REVIEW_REQUIRED'
    : sourceResults.includes('BLOCKED') ? 'BLOCKED' : sourceResults.includes('REVIEW_REQUIRED') ? 'REVIEW_REQUIRED' : 'PASS'
  const generatedAt = input.generatedAt || new Date().toISOString()
  const sourceReferences = {
    fullTimeSourceReportId: fullTimeMissing ? null : fullTimeSource.model.runId,
    partTimeSourceReportIds: includedWeeklySources.map((source) => source.model.runId),
  }
  const identity = {
    reportType: 'MONTHLY_UNIFIED_SUMMARY', periodStart, periodEnd,
    actualModel, actualReasoning, aggregationVersion: UNIFIED_AGGREGATION_VERSION,
    sourceReferences,
    sourceHashes: [fullTimeSource, ...includedWeeklySources].filter(Boolean).map((source) => source.model.canonicalHash),
  }
  const model = {
    schemaVersion: 1,
    runId: auditHash(identity).slice(0, 24),
    metadata: {
      generatedAt, actualModel, actualReasoning,
      reportType: 'MONTHLY_UNIFIED_SUMMARY',
      requestedPeriod: { start: periodStart, end: periodEnd },
      timeZone: 'Asia/Shanghai',
      aggregationVersion: UNIFIED_AGGREGATION_VERSION,
    },
    sourceReferences,
    sourceProblems,
    expectedPartTimePeriods: expectedWeeks,
    fullTime,
    partTime,
    issues: [...fullTime.issues, ...partTime.issues],
    summary: {
      employeeCount: fullTime.employeeCount + partTime.employeeCount,
      payableHours: fullTime.payableHours + partTime.payableHours,
      fullTimePayrollCents: fullTime.totalCents,
      partTimePayrollCents: partTime.totalCents,
      totalPayrollCents: add([fullTime.totalCents, partTime.totalCents]),
      reviewRequiredCount: fullTime.reviewRequiredCount + partTime.reviewRequiredCount,
      issueCount: fullTime.issues.length + partTime.issues.length + sourceProblems.length,
      finalResult: result,
    },
    executionEvidence: {
      sourceReportsRead: (fullTimeMissing ? 0 : 1) + includedWeeklySources.length,
      payrollCoreReexecuted: false,
      dailyStoreStaffRescanned: false,
      mode: 'RESULT_AGGREGATION',
    },
  }
  model.canonicalHash = auditHash({ ...model, metadata: { ...model.metadata, generatedAt: '' } })
  return model
}

export function renderUnifiedMonthlyMarkdown(model) {
  const p = model.metadata.requestedPeriod
  return [
    '# budu 月度薪酬总览', '', `${p.start} ～ ${p.end}`, '',
    `Result: ${model.summary.finalResult}`,
    `Full-time source: ${model.sourceReferences.fullTimeSourceReportId || 'MISSING'}`,
    `Part-time sources: ${model.sourceReferences.partTimeSourceReportIds.join(', ') || 'MISSING'}`,
    `Aggregation version: ${model.metadata.aggregationVersion}`,
    `Generated at: ${model.metadata.generatedAt}`,
    `Execution model: ${model.metadata.actualModel} / ${model.metadata.actualReasoning}`, '',
    '## 总览', '',
    `- 全职人数：${model.fullTime.employeeCount}`,
    `- 兼职人数：${model.partTime.employeeCount}`,
    `- 总工时：${model.summary.payableHours}h`,
    `- 全职薪酬预览：${formatCents(model.fullTime.totalCents)}`,
    `- 兼职薪酬预览：${formatCents(model.partTime.totalCents)}`,
    `- 总薪酬预览：${formatCents(model.summary.totalPayrollCents)}`,
    `- REVIEW_REQUIRED：${model.summary.reviewRequiredCount}`,
    `- 异常：${model.summary.issueCount}`, '',
    '## 全职摘要', '',
    `- 实际工时：${model.fullTime.payableHours}h`,
    `- 正常工资预览：${formatCents(model.fullTime.basePayCents)}`,
    `- 加班：${formatCents(model.fullTime.overtimeCents)}`,
    `- 提成：${formatCents(model.fullTime.commissionCents)}`,
    `- 总薪酬预览：${formatCents(model.fullTime.totalCents)}`, '',
    '## 兼职摘要', '',
    `- 实际工时：${model.partTime.payableHours}h`,
    `- 正常工资预览：${formatCents(model.partTime.basePayCents)}`,
    `- 加班：${formatCents(model.partTime.overtimeCents)}`,
    `- 提成：${formatCents(model.partTime.commissionCents)}`,
    `- 总薪酬预览：${formatCents(model.partTime.totalCents)}`, '',
    '## 来源状态', '',
    ...(model.sourceProblems.length ? model.sourceProblems.map((problem) => `- ${problem}`) : ['- PASS']), '',
    '## 异常与需要关注', '',
    ...(model.issues.length ? model.issues.map((issue) => `- ${issue.employeeName || issue.employeeId} · ${issue.type} · source=${issue.sourceReportId}`) : ['- NONE']), '',
    '此报告仅聚合已完成审查结果，不构成新的薪酬权威。',
  ].join('\n')
}

export function renderUnifiedMonthlyEmail(model) {
  const p = model.metadata.requestedPeriod
  const recipients = ['yuegu1995@gmail.com', '970701330@qq.com', 'korea_jing@163.com']
  return {
    subject: `budu 月度薪酬总览｜${p.start.slice(0, 7)}｜${model.summary.finalResult}`,
    body: `budu 月度薪酬总览\n${p.start} ～ ${p.end}\n\n全职：${formatCents(model.fullTime.totalCents)}\n兼职：${formatCents(model.partTime.totalCents)}\n合计：${formatCents(model.summary.totalPayrollCents)}\nREVIEW_REQUIRED：${model.summary.reviewRequiredCount}\n异常：${model.summary.issueCount}\n\n本报告仅聚合已有审查结果，完整来源与异常见附件。`,
    recipient: recipients[0], recipients, runId: model.runId, canonicalHash: model.canonicalHash,
  }
}

export function renderUnifiedMonthlyHtml(model) {
  const p = model.metadata.requestedPeriod
  const sourceMark = payrollAuditSourceMark(model)
  const problems = model.sourceProblems.length ? model.sourceProblems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('') : '<li>PASS</li>'
  const references = [
    `<li>FULL_TIME monthly · ${escapeHtml(model.sourceReferences.fullTimeSourceReportId || 'MISSING')}</li>`,
    ...model.sourceReferences.partTimeSourceReportIds.map((runId) => `<li>PART_TIME weekly · ${escapeHtml(runId)}</li>`),
  ].join('')
  const issueItems = model.issues.length
    ? model.issues.map((issue) => `<li>${escapeHtml(issue.employeeName || issue.employeeId)} · ${escapeHtml(issue.type)} · ${escapeHtml(issue.sourceReportId)} · ${escapeHtml(`${issue.sourcePeriod.start}～${issue.sourcePeriod.end}`)}</li>`).join('')
    : '<li>NONE</li>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A4 portrait;margin:14mm 13mm 16mm}*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d2733;font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}main{max-width:184mm;margin:auto}section{background:#fff;min-height:260mm;padding:18mm 12mm}.cover{display:flex;flex-direction:column;justify-content:space-between}.brand{width:42mm}.cover h1{font-size:30px;margin:20px 0 4px}.period{font-size:20px;color:#536273}.source-mark{max-width:150mm;margin-top:12px;color:#7a8695;font-size:9px}.result{font-size:36px;font-weight:700;color:#d84f86}.page{break-before:page}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{padding:14px;border:1px solid #e6e8ec;border-radius:14px}.card span{display:block;color:#697586;font-size:11px}.card b{font-size:20px}h2{font-size:25px}ul{padding-left:18px}.notice{padding:12px;border-left:3px solid #d84f86;background:#fff5f8}
  </style></head><body><main><section class="cover"><div><img class="brand" src="${WORDMARK_DATA_URI}" alt="budu"><h1>月度薪酬总览</h1><p class="period">${escapeHtml(p.start.slice(0, 7))}</p><p class="source-mark" data-payroll-source-mark="true">${escapeHtml(sourceMark)}</p></div><div><p>汇总状态</p><div class="result">${escapeHtml(model.summary.finalResult)}</div></div><p class="notice">仅聚合已完成审查结果，不构成新的薪酬权威。</p></section><section class="page"><h2>管理层总览</h2><div class="grid"><div class="card"><span>全职人数</span><b>${model.fullTime.employeeCount}</b></div><div class="card"><span>兼职人数</span><b>${model.partTime.employeeCount}</b></div><div class="card"><span>总工时</span><b>${model.summary.payableHours}h</b></div><div class="card"><span>全职薪酬预览</span><b>${escapeHtml(formatCents(model.fullTime.totalCents))}</b></div><div class="card"><span>兼职薪酬预览</span><b>${escapeHtml(formatCents(model.partTime.totalCents))}</b></div><div class="card"><span>总薪酬预览</span><b>${escapeHtml(formatCents(model.summary.totalPayrollCents))}</b></div><div class="card"><span>REVIEW_REQUIRED</span><b>${model.summary.reviewRequiredCount}</b></div><div class="card"><span>异常</span><b>${model.summary.issueCount}</b></div></div><h2>来源状态</h2><ul>${problems}</ul></section><section class="page"><h2>全职摘要</h2><div class="grid"><div class="card"><span>实际工时</span><b>${model.fullTime.payableHours}h</b></div><div class="card"><span>正常工资预览</span><b>${escapeHtml(formatCents(model.fullTime.basePayCents))}</b></div><div class="card"><span>加班</span><b>${escapeHtml(formatCents(model.fullTime.overtimeCents))}</b></div><div class="card"><span>提成</span><b>${escapeHtml(formatCents(model.fullTime.commissionCents))}</b></div></div><h2>兼职摘要</h2><div class="grid"><div class="card"><span>实际工时</span><b>${model.partTime.payableHours}h</b></div><div class="card"><span>正常工资预览</span><b>${escapeHtml(formatCents(model.partTime.basePayCents))}</b></div><div class="card"><span>加班</span><b>${escapeHtml(formatCents(model.partTime.overtimeCents))}</b></div><div class="card"><span>提成</span><b>${escapeHtml(formatCents(model.partTime.commissionCents))}</b></div></div><h2>异常与需要关注</h2><ul>${issueItems}</ul><h2>来源说明</h2><ul>${references}</ul><h2>执行证据</h2><ul><li>Mode: RESULT_AGGREGATION</li><li>Source reports read: ${model.executionEvidence.sourceReportsRead}</li><li>Payroll core reexecuted: NO</li><li>DailyStoreStaff rescanned: NO</li></ul></section></main></body></html>`
}
