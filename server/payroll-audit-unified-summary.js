import fs from 'node:fs'

import { auditHash, formatCents, payrollAuditSourceMark, payrollAuditIssueCategory, payrollAuditDisplayLabel } from './payroll-audit-report.js'

const WORDMARK_SVG = fs.readFileSync(new URL('../brand/web/budu-wordmark.svg', import.meta.url), 'utf8')
const WORDMARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(WORDMARK_SVG).toString('base64')}`
export const UNIFIED_AGGREGATION_VERSION = 2

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

const isAnomaly = (issue, employee) => payrollAuditIssueCategory(issue, employee) === 'ANOMALY'
const normalNoPayroll = (employee) => employee.status === 'PASS'
  && (employee.issues || []).some((issue) => payrollAuditIssueCategory(issue, employee) === 'NORMAL_STATUS')
const sourceIssue = (issue, employee, source) => ({
  ...issue, employeeId: employee.employeeId, employeeName: employee.employeeName,
  sourceReportId: source.model.runId, sourcePeriod: source.model.metadata.requestedPeriod,
  category: payrollAuditIssueCategory(issue, employee),
})

function aggregateFullTime(source) {
  const employees = source?.model?.employeeResults || []
  const issues = employees.flatMap((employee) => (employee.issues || []).map((issue) => sourceIssue(issue, employee, source)))
  return {
    employeeCount: employees.length,
    payableHours: employees.reduce((sum, employee) => sum + Number(employee.payableHours || 0), 0),
    basePayCents: add(employees.map((employee) => componentCents(employee, 'basePay'))),
    overtimeCents: add(employees.map((employee) => componentCents(employee, 'overtimePay'))),
    commissionCents: add(employees.map((employee) => componentCents(employee, 'commission'))),
    totalCents: add(employees.map((employee) => employee.authoritativePayrollCents)),
    reviewRequiredCount: employees.filter((employee) => employee.status === 'REVIEW_REQUIRED').length,
    anomalyEmployeeCount: employees.filter((employee) => employee.status !== 'PASS' || (employee.issues || []).some((issue) => isAnomaly(issue, employee))).length,
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
      if (employee.status !== 'PASS' || (employee.issues || []).some((issue) => isAnomaly(issue, employee))) anomalyIds.add(employee.employeeId)
      for (const issue of employee.issues || []) {
        issues.push(sourceIssue(issue, employee, source))
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
    componentTotalsCents: Object.fromEntries([...componentTotals].map(([key, value]) => [key, text(value)])),
    componentsMatchIncludedSubtotal: add([...componentTotals.values()]) === text(total),
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
    .filter((source) => source.model.schemaVersion < 5 || (source.model.employeeResults || []).some((employee) => employee.dailyPayrollBreakdownComplete !== true && !normalNoPayroll(employee)))
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
  const sourceResults = [fullTimeMissing ? null : fullTimeSource, ...includedWeeklySources].filter(Boolean).map((source) => source.model.summary.finalResult)
  const sourceAnomalyCount = [...fullTime.issues, ...partTime.issues].filter((issue) => issue.category === 'ANOMALY').length
  const result = sourceResults.includes('BLOCKED') ? 'BLOCKED'
    : sourceProblems.length || sourceAnomalyCount || sourceResults.includes('REVIEW_REQUIRED') ? 'REVIEW_REQUIRED' : 'PASS'
  const generatedAt = input.generatedAt || new Date().toISOString()
  const sourceReferences = {
    fullTimeSourceReportId: fullTimeMissing ? null : fullTimeSource.model.runId,
    partTimeSourceReportIds: includedWeeklySources.map((source) => source.model.runId),
  }
  const identity = {
    reportType: 'MONTHLY_UNIFIED_SUMMARY', periodStart, periodEnd,
    actualModel, actualReasoning, aggregationVersion: UNIFIED_AGGREGATION_VERSION,
    preview: input.preview === true, dataAsOf: input.dataAsOf || '',
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
      preview: input.preview === true, dataAsOf: input.dataAsOf || generatedAt,
    },
    sourceReferences,
    sourceStatuses: [fullTimeMissing ? null : fullTimeSource, ...includedWeeklySources].filter(Boolean).map((source) => ({ runId: source.model.runId, period: source.model.metadata.requestedPeriod, result: source.model.summary.finalResult })),
    sourceProblems,
    insufficientSourceDetails: includedWeeklySources.filter((source) => insufficientPartTimeSourceIds.includes(source.model.runId)).map((source) => ({
      runId: source.model.runId, period: source.model.metadata.requestedPeriod, schemaVersion: source.model.schemaVersion,
      employees: (source.model.employeeResults || []).filter((employee) => employee.dailyPayrollBreakdownComplete !== true && !normalNoPayroll(employee)).map((employee) => ({ employeeName: employee.employeeName, payrollMissing: employee.authoritativePayrollCents == null, reason: employee.dailyPayrollBreakdownReason || 'DAILY_BREAKDOWN_NOT_VERIFIED' })),
    })),
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
      issueCount: [...fullTime.issues, ...partTime.issues].filter((issue) => issue.category === 'ANOMALY').length + sourceProblems.length,
      anomalyCount: [...fullTime.issues, ...partTime.issues].filter((issue) => issue.category === 'ANOMALY').length + sourceProblems.length,
      sourceReviewIssueCount: sourceAnomalyCount,
      sourceProblemCount: sourceProblems.length,
      auditHintCount: [...fullTime.issues, ...partTime.issues].filter((issue) => issue.category === 'AUDIT_HINT').length,
      normalStatusCount: [...fullTime.issues, ...partTime.issues].filter((issue) => issue.category === 'NORMAL_STATUS').length,
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


const COMPONENT_LABELS = { basePay: '基础 / 工时工资', overtimePay: '加班工资', commission: '营业提成', transferSubsidy: '跨店补贴', bigBonus: '大单奖励', salaryAdjustment: '工资调整' }
const categoryLabels = { ANOMALY: '旧来源待复核', AUDIT_HINT: '历史资料提示（非阻断）', NORMAL_STATUS: '正常无需结算记录' }
const fullTimeValue = (model, value) => model.sourceReferences.fullTimeSourceReportId ? value : '来源未到位 / 未知'
const fullTimeAmount = (model, value) => fullTimeValue(model, formatCents(value))
function overallNotice(model) {
  const month = Number(model.metadata.requestedPeriod.start.slice(5, 7))
  if (model.sourceProblems.length) return `当前资料不全，不能形成${month}月完整应发总额；这不是已证实工资算错。`
  return model.summary.finalResult === 'PASS' ? '已到位来源汇总审查通过；正式发放仍需独立复核。' : '原来源仍待复核，保留其原始状态；不能据此断言工资算错。'
}
function resultLabel(model) {
  if (model.sourceProblems.length) return '汇总资料待补齐'
  return model.summary.finalResult === 'PASS' ? '汇总通过' : '旧来源待复核'
}
function previewNotice(model) {
  if (!model.metadata.preview) return ''
  const cutoff = new Date(model.metadata.dataAsOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  return `本地验收预览 · 来源读取截至北京时间 ${cutoff}；不是正式闭月报告。本地试算报告不自动替代正式持久化来源。`
}
function sourceProblemDescriptions(model) {
  return model.sourceProblems.map((code) => {
    if (code === 'SOURCE_REPORT_MISSING:MONTHLY_FULL_TIME') return { code, title: '缺少全职正式月报', detail: '本月全职正式持久化月报未到位；全职人数、工时和金额未知，不按零计算。' }
    if (code.startsWith('SOURCE_REPORT_MISSING:WEEKLY_PART_TIME:')) {
      const [, , start, end] = code.split(':')
      return { code, title: `缺少兼职周报：${start}～${end}`, detail: '覆盖该段日期的正式持久化周报未到位，未生成补报或推断缺失金额。' }
    }
    const runId = code.split(':')[1]
    const source = (model.insufficientSourceDetails || []).find((row) => row.runId === runId)
    const employees = source?.employees || []
    const names = employees.map((row) => row.employeeName).join('、')
    return { code, title: `逐日工资明细完整性不足：${source ? `${source.period.start}～${source.period.end}` : runId}`, detail: employees.length ? `${names}（${employees.length}人）的持久化来源未通过逐日工资分解完整标记${employees.every((row) => row.payrollMissing) ? '，本周期权威工资结果为空' : ''}。不能确认这些记录可按零工资参与汇总；此项是日级明细不足，不是日期跨月缺口。` : '旧来源版本或逐日工资分解不足，无法验证按月取数所需的日级金额与组成。' }
  })
}
function classificationSummary(model) {
  return [`旧来源待复核：${model.summary.sourceReviewIssueCount} 项（不是已证实工资错误）`, `来源完整性问题：${model.summary.sourceProblemCount} 项（缺失报告与日级明细不足）`, `历史资料提示：${model.summary.auditHintCount} 条（非阻断）`, `正常无需结算记录：${model.summary.normalStatusCount} 条（按来源周期）`]
}
function reviewBasis(model) {
  return `待复核员工：${model.summary.reviewRequiredCount} 人（仅已到位来源的“需人工复核”标签，兼职按员工去重；已到位来源共 ${model.summary.employeeCount} 人）。此人数不含仅有“审查阻断”标签的员工，不是全月人数。`
}
function components(model) {
  const totals = model.partTime.componentTotalsCents || {}
  return [...new Set([...Object.keys(COMPONENT_LABELS), ...Object.keys(totals)])].map((key) => ({ label: COMPONENT_LABELS[key] || `其他已记录组成：${key}`, amount: Object.hasOwn(totals, key) ? formatCents(totals[key]) : model.partTime.componentsMatchIncludedSubtotal ? formatCents('0') : '未知' }))
}
function issueDescription(issue) {
  const period = `${issue.sourcePeriod.start}～${issue.sourcePeriod.end}`
  const detail = issue.category === 'AUDIT_HINT' ? '仅有当前用工类型，缺少有效期历史' : issue.category === 'NORMAL_STATUS' ? '来源已确认本期无需结算' : issue.type === 'PAYROLL_SUBJECT_OUTSIDE_RANGE' ? '旧报告未取得本周期权威工资结果；尚不能认定工资算错或无需结算' : '原来源记录待复核，保留原证据和状态'
  return `${issue.employeeName || issue.employeeId} · ${period} · ${detail}`
}

export function renderUnifiedMonthlyMarkdown(model) {
  const p = model.metadata.requestedPeriod
  const lines = ['# budu 月度薪酬来源汇总', '', `${p.start} ～ ${p.end}`, previewNotice(model), `汇总结论：${resultLabel(model)}`, overallNotice(model), '',
    '## 仅已到位来源总览', '', `全职来源人数：${fullTimeValue(model, `${model.fullTime.employeeCount} 人`)}`, `兼职来源人数：${model.partTime.employeeCount} 人`, `已到位来源人数：${model.summary.employeeCount} 人（不是全月人数）`, `已到位来源总工时：${model.summary.payableHours} 小时（不是全月工时）`, `全职来源金额：${fullTimeAmount(model, model.fullTime.totalCents)}`, `已到位兼职来源金额：${formatCents(model.partTime.totalCents)}`, `已到位来源金额小计：${formatCents(model.summary.totalPayrollCents)}`, reviewBasis(model), ...classificationSummary(model), '',
    '## 来源完整性问题', '', ...sourceProblemDescriptions(model).map((row) => `- ${row.title}：${row.detail}`), '',
    '## 已到位兼职来源小计的金额组成', '', ...components(model).map((row) => `- ${row.label}：${row.amount}`), `- 已到位兼职小计：${formatCents(model.partTime.totalCents)}`, model.partTime.componentsMatchIncludedSubtotal ? '以上已记录组成与已纳入的小计完全相符；缺失资料部分不推断为零。' : '这是已知的部分组成，来源未支持完整可加总拆分，未知部分不反算。', '',
  ]
  for (const category of Object.keys(categoryLabels)) {
    const rows = model.issues.filter((issue) => issue.category === category)
    lines.push(`## ${categoryLabels[category]}：${rows.length} 条`, '', ...(rows.length ? rows.map((issue) => `- ${issueDescription(issue)}`) : ['已到位来源未确认此类记录。']), '')
  }
  lines.push('## 最终结论', '', overallNotice(model), '只聚合已保存来源，未重新计算工资或扫描考勤，未补报、未修改来源状态。', '', '## 附注 · 技术追溯', '', `原汇总状态：${model.summary.finalResult}`, ...model.sourceStatuses.map((source) => `${source.period.start}～${source.period.end} · 原状态：${payrollAuditDisplayLabel(source.result)} (${source.result}) · ${source.runId}`), ...model.sourceProblems, `汇总版本：${model.metadata.aggregationVersion}；读取正式来源 ${model.executionEvidence.sourceReportsRead} 份。`)
  return lines.join('\n')
}

export function renderUnifiedMonthlyEmail(model) {
  const p = model.metadata.requestedPeriod
  const recipients = ['yuegu1995@gmail.com', '970701330@qq.com', 'korea_jing@163.com']
  return { subject: `budu 月度薪酬来源汇总｜${p.start.slice(0, 7)}｜${resultLabel(model)}`, body: [`budu 月度薪酬来源汇总`, `${p.start}～${p.end}`, previewNotice(model), overallNotice(model), `全职来源金额：${fullTimeAmount(model, model.fullTime.totalCents)}`, `已到位兼职来源小计：${formatCents(model.partTime.totalCents)}`, `已到位来源金额小计：${formatCents(model.summary.totalPayrollCents)}`, reviewBasis(model), ...classificationSummary(model), '原来源状态保持不变，详情与技术追溯见附件。'].join('\n'), recipient: recipients[0], recipients, runId: model.runId, canonicalHash: model.canonicalHash }
}

export function renderUnifiedMonthlyHtml(model) {
  const p = model.metadata.requestedPeriod
  const sourceMark = payrollAuditSourceMark(model)
  const card = (label, value) => `<div class="card"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
  const problems = sourceProblemDescriptions(model).map((row) => `<li><b>${escapeHtml(row.title)}</b><br>${escapeHtml(row.detail)}</li>`).join('') || '<li>来源完整性检查通过。</li>'
  const groups = Object.keys(categoryLabels).map((category) => {
    const rows = model.issues.filter((issue) => issue.category === category)
    return `<h2>${escapeHtml(categoryLabels[category])}：${rows.length} 条</h2><ul>${rows.length ? rows.map((issue) => `<li>${escapeHtml(issueDescription(issue))}</li>`).join('') : '<li>已到位来源未确认此类记录。</li>'}</ul>`
  }).join('')
  const refs = model.sourceStatuses.map((source) => `<li>${escapeHtml(source.period.start)}～${escapeHtml(source.period.end)} · 原来源状态：${escapeHtml(payrollAuditDisplayLabel(source.result))}（${escapeHtml(source.result)}） · ${escapeHtml(source.runId)}</li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page{size:A4 portrait;margin:14mm 13mm 16mm}*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d2733;font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}main{max-width:184mm;margin:auto}section{background:#fff;min-height:260mm;padding:18mm 12mm}.cover{display:flex;flex-direction:column;justify-content:space-between}.brand{width:42mm}.cover h1{font-size:28px;margin:20px 0 4px}.period{font-size:20px;color:#536273}.source-mark{max-width:150mm;margin-top:12px;color:#7a8695;font-size:9px}.result{font-size:30px;font-weight:700;color:#d84f86}.page{break-before:page;padding-top:12mm;padding-bottom:12mm}.grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}.card{padding:7px;border:1px solid #e6e8ec;border-radius:14px}.card span{display:block;color:#697586;font-size:11px}.card b{font-size:18px}h2{font-size:20px;margin:16px 0 8px;break-after:avoid}ul{padding-left:18px;margin:8px 0}li{overflow-wrap:anywhere;margin:5px 0;break-inside:avoid}.notice{padding:12px;border-left:3px solid #d84f86;background:#fff5f8}.trace{font-size:9px;color:#697586}.components>div{display:flex;justify-content:space-between;padding:7px 10px;border-bottom:1px solid #eceef1}
  </style></head><body><main><section class="cover"><div><img class="brand" src="${WORDMARK_DATA_URI}" alt="budu"><h1>月度薪酬来源汇总${model.metadata.preview ? ' · 验收预览' : ''}</h1><p class="period">${escapeHtml(p.start.slice(0, 7))}</p><p class="source-mark" data-payroll-source-mark="true">${escapeHtml(sourceMark)}</p></div><div><p>汇总结论</p><div class="result">${escapeHtml(resultLabel(model))}</div><p>${escapeHtml(overallNotice(model))}</p></div><p class="notice">${escapeHtml(previewNotice(model) || '只聚合已保存正式来源，未改写工资事实。')}</p></section>
  <section class="page"><h2>仅已到位来源总览</h2><div class="grid">${card('全职来源人数', fullTimeValue(model, `${model.fullTime.employeeCount} 人`))}${card('兼职来源人数', `${model.partTime.employeeCount} 人`)}${card('已到位来源人数 · 非全月人数', `${model.summary.employeeCount} 人`)}${card('已到位来源总工时 · 非全月工时', `${model.summary.payableHours} 小时`)}${card('全职来源工时', fullTimeValue(model, `${model.fullTime.payableHours} 小时`))}${card('全职来源金额', fullTimeAmount(model, model.fullTime.totalCents))}${card('已到位来源金额小计 · 非全月总额', formatCents(model.summary.totalPayrollCents))}${card('待复核员工 · 旧来源标签', `${model.summary.reviewRequiredCount} / ${model.summary.employeeCount} 人`)}${card('旧来源待复核', `${model.summary.sourceReviewIssueCount} 项`)}${card('来源完整性问题', `${model.summary.sourceProblemCount} 项`)}${card('历史资料提示 · 非阻断', `${model.summary.auditHintCount} 条`)}${card('正常无需结算记录 · 按来源周期', `${model.summary.normalStatusCount} 条`)}</div><p>${escapeHtml(reviewBasis(model))}</p><h2>来源完整性问题</h2><ul>${problems}</ul></section>
  <section class="page"><h2>已到位兼职来源小计的金额组成</h2><div class="components">${components(model).map((row) => `<div><span>${escapeHtml(row.label)}</span><b>${escapeHtml(row.amount)}</b></div>`).join('')}<div><b>已到位兼职小计</b><b>${escapeHtml(formatCents(model.partTime.totalCents))}</b></div></div><p>${model.partTime.componentsMatchIncludedSubtotal ? '以上已记录组成与已纳入的小计完全相符；缺失资料部分不推断为零。' : '以上只是已知部分组成，不能作为完整可加总拆分；未知部分不反算。'}</p>${groups}<h2>最终结论</h2><p class="notice">${escapeHtml(overallNotice(model))}</p><p>只读取并聚合已保存的正式来源，未重新计算工资、未再次扫描考勤、未生成补报、未改写来源状态。</p><h2>附注 · 技术追溯</h2><div class="trace"><p>原汇总状态：${escapeHtml(model.summary.finalResult)}；汇总版本 ${model.metadata.aggregationVersion}；读取正式来源 ${model.executionEvidence.sourceReportsRead} 份。</p><ul>${refs}${model.sourceProblems.map((code) => `<li>${escapeHtml(code)}</li>`).join('')}</ul><p>旧来源待复核代码：${escapeHtml([...new Set(model.issues.filter((issue) => issue.category === 'ANOMALY').map((issue) => issue.type))].join('、'))}；历史提示代码：EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE。</p></div></section></main></body></html>`
}
