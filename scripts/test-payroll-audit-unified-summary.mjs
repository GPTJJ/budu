import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { payrollAuditJobKey, runUnifiedMonthlySummaryJob } from '../server/payroll-audit-scheduler-core.js'
import { buildUnifiedMonthlyPayrollSummary, renderUnifiedMonthlyHtml, renderUnifiedMonthlyMarkdown, renderUnifiedMonthlyEmail } from '../server/payroll-audit-unified-summary.js'
import { runUnifiedSummaryFromSources } from './payroll-audit-unified-runner.mjs'

const executionMetadata = { actualModel: 'GPT-5.6 Sol', actualReasoning: 'Medium' }
const month = { periodStart: '2026-09-01', periodEnd: '2026-09-30' }

const day = (date, totalCents, basePayCents, commissionCents, payableHours) => ({
  date, payableHours,
  payroll: {
    complete: true, totalCents: String(totalCents),
    components: { basePay: String(basePayCents), overtimePay: '0', commission: String(commissionCents), transferSubsidy: '0', bigBonus: '0', salaryAdjustment: '0' },
  },
})

function employee(employeeId, rows, status = 'PASS') {
  return { employeeId, employeeName: employeeId, status, issues: status === 'PASS' ? [] : [{ type: 'TEST_REVIEW' }], dailyPayrollBreakdownComplete: true, dailyReconciliation: rows }
}

function weekly(runId, start, end, employees = []) {
  return { job: { runId }, model: { schemaVersion: 5, runId, canonicalHash: `${runId}-hash`, metadata: { reportType: 'WEEKLY_PART_TIME', requestedPeriod: { start, end } }, summary: { finalResult: employees.some((row) => row.status !== 'PASS') ? 'REVIEW_REQUIRED' : 'PASS' }, employeeResults: employees } }
}

function sources() {
  const fullTimeSource = { job: { runId: 'full-sep' }, model: {
    schemaVersion: 5, runId: 'full-sep', canonicalHash: 'full-hash', metadata: { reportType: 'MONTHLY_FULL_TIME', requestedPeriod: { start: '2026-09-01', end: '2026-09-30' } }, summary: { finalResult: 'PASS' },
    employeeResults: [{ employeeId: 'full-1', employeeName: '全职一', status: 'PASS', payableHours: 160, authoritativePayrollCents: '100000', issues: [], components: [{ key: 'basePay', amountCents: '80000' }, { key: 'overtimePay', amountCents: '5000' }, { key: 'commission', amountCents: '15000' }] }],
  } }
  const partTimeSources = [
    weekly('week-1', '2026-08-31', '2026-09-06', [employee('part-1', [day('2026-08-31', 10000, 8000, 2000, 1), day('2026-09-01', 20000, 16000, 4000, 2)])]),
    weekly('week-2', '2026-09-07', '2026-09-13', [employee('part-1', [day('2026-09-08', 30000, 24000, 6000, 3)])]),
    weekly('week-3', '2026-09-14', '2026-09-20', [employee('part-2', [day('2026-09-15', 15000, 12000, 3000, 1.5)], 'REVIEW_REQUIRED')]),
    weekly('week-4', '2026-09-21', '2026-09-27', [employee('part-1', [])]),
    weekly('week-5', '2026-09-28', '2026-10-04', [employee('part-1', [day('2026-09-30', 40000, 32000, 8000, 4), day('2026-10-01', 50000, 40000, 10000, 5)])]),
  ]
  return { fullTimeSource, partTimeSources }
}

function extractPdfPages(pdf, firstPage, lastPage, root) {
  const poppler = spawnSync('pdftotext', ['-f', String(firstPage), '-l', String(lastPage), pdf, '-'], { encoding: 'utf8' })
  if (!poppler.error && poppler.status === 0) return poppler.stdout
  if (process.platform !== 'darwin') throw poppler.error || new Error(poppler.stderr || 'pdftotext failed')
  const swiftFile = path.join(root, 'extract.swift')
  fs.writeFileSync(swiftFile, `import Foundation\nimport PDFKit\nlet d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!\nfor i in (Int(CommandLine.arguments[2])!-1)...(Int(CommandLine.arguments[3])!-1){print(d.page(at:i)?.string ?? "")}\n`)
  const result = spawnSync('swift', [swiftFile, pdf, String(firstPage), String(lastPage)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('unified summary reuses monthly result, slices weekly dates and deduplicates part-time employees', () => {
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...sources(), generatedAt: '2026-10-01T01:00:00.000Z' })
  assert.equal(model.fullTime.employeeCount, 1)
  assert.equal(model.fullTime.totalCents, '100000')
  assert.equal(model.partTime.employeeCount, 2)
  assert.equal(model.partTime.payableHours, 10.5)
  assert.equal(model.partTime.totalCents, '105000')
  assert.equal(model.partTime.basePayCents, '84000')
  assert.equal(model.partTime.commissionCents, '21000')
  assert.equal(model.summary.totalPayrollCents, '205000')
  assert.equal(model.sourceReferences.fullTimeSourceReportId, 'full-sep')
  assert.deepEqual(model.sourceReferences.partTimeSourceReportIds, ['week-1', 'week-2', 'week-3', 'week-4', 'week-5'])
  assert.equal(model.executionEvidence.sourceReportsRead, 6)
  assert.equal(model.executionEvidence.payrollCoreReexecuted, false)
  assert.equal(model.executionEvidence.dailyStoreStaffRescanned, false)
})

test('missing or legacy weekly and missing monthly sources review without re-audit', () => {
  const present = sources()
  const missingWeekly = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, fullTimeSource: present.fullTimeSource, partTimeSources: present.partTimeSources.slice(0, 4) })
  assert.equal(missingWeekly.summary.finalResult, 'REVIEW_REQUIRED')
  assert.ok(missingWeekly.sourceProblems.some((row) => row.startsWith('SOURCE_REPORT_MISSING:WEEKLY_PART_TIME')))
  const legacy = sources()
  legacy.partTimeSources[0].model.schemaVersion = 4
  const insufficient = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...legacy })
  assert.ok(insufficient.sourceProblems.includes('MONTH_BOUNDARY_SOURCE_INSUFFICIENT:week-1'))
  const missingFullTime = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, fullTimeSource: null, partTimeSources: sources().partTimeSources })
  assert.ok(missingFullTime.sourceProblems.includes('SOURCE_REPORT_MISSING:MONTHLY_FULL_TIME'))
  for (const model of [missingWeekly, insufficient, missingFullTime]) assert.equal(model.executionEvidence.payrollCoreReexecuted, false)
})

test('unified identity is independent and duplicate generation reuses artifacts with first-page-only source mark', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-unified-payroll-'))
  try {
    const options = { ...month, ...executionMetadata, ...sources(), generatedAt: '2026-10-01T01:00:00.000Z', outputRoot: root }
    const first = await runUnifiedSummaryFromSources(options)
    const second = await runUnifiedSummaryFromSources(options)
    assert.equal(first.reused, false)
    assert.equal(second.reused, true)
    assert.match(path.basename(first.paths.pdf), /统一月度薪酬总览/)
    assert.notEqual(payrollAuditJobKey({ reportType: 'MONTHLY_UNIFIED_SUMMARY', ...month }), payrollAuditJobKey({ reportType: 'MONTHLY_FULL_TIME', ...month }))
    const html = renderUnifiedMonthlyHtml(first.model)
    assert.equal((html.match(/data-payroll-source-mark="true"/g) || []).length, 1)
    const info = spawnSync('pdfinfo', [first.paths.pdf], { encoding: 'utf8' })
    const pages = Number((info.stdout.match(/^Pages:\s+(\d+)/m) || [])[1])
    assert.ok(pages >= 3)
    assert.equal((extractPdfPages(first.paths.pdf, 1, 1, root).match(/budu Payroll Audit Automation/g) || []).length, 1)
    assert.equal((extractPdfPages(first.paths.pdf, 2, pages, root).match(/budu Payroll Audit Automation/g) || []).length, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('scheduler unified path never calls snapshot or payroll audit engine and is idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-unified-job-'))
  const old = process.env.PAYROLL_AUDIT_DATA_DIR
  process.env.PAYROLL_AUDIT_DATA_DIR = root
  let sourceReads = 0
  let payrollCalls = 0
  try {
    const input = { reportType: 'MONTHLY_UNIFIED_SUMMARY', ...month, ...executionMetadata, email: false, allowNonProduction: true, generatedAt: '2026-10-01T01:00:00.000Z' }
    const dependencies = { loadSources: async () => { sourceReads += 1; return sources() }, snapshot: async () => { payrollCalls += 1; throw new Error('must not execute') } }
    const first = await runUnifiedMonthlySummaryJob(input, dependencies)
    const second = await runUnifiedMonthlySummaryJob(input, dependencies)
    assert.equal(first.job.reportType, 'MONTHLY_UNIFIED_SUMMARY')
    assert.equal(first.job.executionEvidence.payrollCoreReexecuted, false)
    assert.equal(second.reused, true)
    assert.equal(sourceReads, 1)
    assert.equal(payrollCalls, 0)
  } finally {
    if (old === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = old
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unified scheduler rejects model mismatch before reading source reports', async () => {
  let sourceReads = 0
  await assert.rejects(
    runUnifiedMonthlySummaryJob({ reportType: 'MONTHLY_UNIFIED_SUMMARY', ...month, actualModel: 'GPT-6 Astra', actualReasoning: 'High', email: false }, {
      loadSources: async () => { sourceReads += 1; return sources() },
    }),
    (error) => error.code === 'MODEL_CONFIGURATION_MISMATCH',
  )
  assert.equal(sourceReads, 0)
})


test('unified classification preserves amounts, excludes new hints and normal states, and needs no daily breakdown for verified no-payroll', () => {
  const data = sources()
  data.partTimeSources[2].model.employeeResults[0].status = 'PASS'
  data.partTimeSources[2].model.employeeResults[0].issues = []
  data.partTimeSources[2].model.summary.finalResult = 'PASS'
  const before = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data })
  for (const source of [data.fullTimeSource, ...data.partTimeSources]) {
    source.model.employeeResults[0].issues.push({ type: 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE', category: 'AUDIT_HINT', blockingSource: null, evidence: 'history gap', payrollImpact: 'NO' })
    source.model.employeeResults.push({ employeeId: 'idle', employeeName: 'idle', status: 'PASS', payableHours: null, authoritativePayrollCents: null, employeeCardCents: null, dailyPayrollBreakdownComplete: false, dailyReconciliation: [], issues: [{ type: 'PAYROLL_SUBJECT_OUTSIDE_RANGE', rootCause: 'NO_PAYROLL_REQUIRED', category: 'NORMAL_STATUS', blockingSource: null, payrollImpact: 'NO', amountImpactCents: '0' }] })
  }
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data })
  assert.equal(model.summary.totalPayrollCents, before.summary.totalPayrollCents)
  assert.equal(model.partTime.totalCents, before.partTime.totalCents)
  assert.equal(model.summary.issueCount, 0)
  assert.equal(model.summary.auditHintCount, 6)
  assert.equal(model.summary.normalStatusCount, 6)
  assert.equal(model.summary.finalResult, 'PASS')
  assert.deepEqual(model.sourceProblems, [])
  assert.equal(model.issues.length, 12)
  for (const output of [renderUnifiedMonthlyHtml(model), renderUnifiedMonthlyMarkdown(model), renderUnifiedMonthlyEmail(model).body]) {
    assert.match(output, /历史资料提示/)
    assert.match(output, /正常无需结算记录/)
    assert.match(output, /旧来源待复核/)
    assert.match(output, /来源完整性问题/)
    assert.doesNotMatch(output, /异常与需要关注/)
  }
})

test('legacy blocked sources, unknown issues and genuine payroll/card blockers cannot be washed into PASS', () => {
  for (const type of ['EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE', 'MISSING_ACTUAL_HOURS', 'PAYROLL_SUBJECT_OUTSIDE_RANGE', 'EMPLOYEE_CARD_PROJECTION_ERROR', 'UNKNOWN_NEW_ISSUE']) {
    const data = sources()
    const row = data.partTimeSources[0].model.employeeResults[0]
    row.status = 'BLOCKED'
    row.issues = [{ type, payrollImpact: 'NO' }]
    data.partTimeSources[0].model.summary.finalResult = 'BLOCKED'
    data.partTimeSources.pop()
    const original = JSON.stringify(data)
    const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data })
    assert.equal(model.summary.finalResult, 'BLOCKED', type)
    assert.equal(model.issues.find(issue => issue.sourceReportId === 'week-1').category, 'ANOMALY', type)
    assert.ok(model.summary.issueCount >= 2)
    assert.ok(model.sourceProblems.some(problem => problem.startsWith('SOURCE_REPORT_MISSING')))
    assert.equal(JSON.stringify(data), original)
  }
})

test('legacy PASS information requires specific evidence; payrollImpact NO alone never downgrades an issue', () => {
  const data = sources()
  const row = data.fullTimeSource.model.employeeResults[0]
  row.employmentType = 'fulltime'; row.employeeCardCents = '100000'; row.differenceCents = '0'
  row.issues = [{ type: 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE', payrollImpact: 'NO' }, { type: 'EMPLOYEE_CARD_PROJECTION_ERROR', payrollImpact: 'NO', amountImpactCents: '1' }]
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data })
  assert.equal(model.fullTime.issues[0].category, 'AUDIT_HINT')
  assert.equal(model.fullTime.issues[1].category, 'ANOMALY')
  assert.equal(model.summary.finalResult, 'REVIEW_REQUIRED')
  const held = structuredClone(data)
  held.fullTimeSource.model.summary.finalResult = 'BLOCKED'
  held.fullTimeSource.model.employeeResults[0].status = 'BLOCKED'
  const blocked = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...held })
  assert.equal(blocked.fullTime.issues[0].category, 'ANOMALY')
  assert.equal(blocked.summary.finalResult, 'BLOCKED')
})

test('monthly local preview clearly records actual cutoff and retains missing persisted source status', () => {
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, fullTimeSource: null, partTimeSources: [], preview: true, dataAsOf: '2026-09-30T14:47:57.422Z' })
  assert.equal(model.summary.finalResult, 'REVIEW_REQUIRED')
  assert.equal(model.summary.sourceProblemCount, 6)
  assert.equal(model.summary.issueCount, 6)
  assert.equal(model.summary.auditHintCount, 0)
  assert.equal(model.metadata.preview, true)
  for (const output of [renderUnifiedMonthlyHtml(model), renderUnifiedMonthlyMarkdown(model), renderUnifiedMonthlyEmail(model).body]) {
    assert.match(output, /本地验收预览/)
    assert.match(output, /22:47:57/)
    assert.match(output, /不能形成9月完整应发总额/)
  }
})


test('recognized synthetic legacy history stays informational while original BLOCKED source remains held', () => {
  const data = sources()
  const row = data.fullTimeSource.model.employeeResults[0]
  row.status = 'BLOCKED'; row.employmentType = 'fulltime'
  row.issues = [{ type: 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE', rootCause: 'Employment type is current-state only.', errorLayer: 'Employee authority', payrollImpact: 'UNKNOWN' }]
  data.fullTimeSource.model.summary.finalResult = 'BLOCKED'
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data })
  assert.equal(model.fullTime.issues[0].category, 'AUDIT_HINT')
  assert.equal(model.summary.auditHintCount, 1)
  assert.equal(model.summary.finalResult, 'BLOCKED')
  assert.equal(model.sourceStatuses[0].result, 'BLOCKED')
})


test('unified v4 states missing full-time values as unknown, separates record counts and shows every recorded component', () => {
  const data = sources()
  data.fullTimeSource = null
  data.partTimeSources = data.partTimeSources.slice(2, 4)
  data.partTimeSources[0].model.summary.finalResult = 'BLOCKED'
  const row = data.partTimeSources[0].model.employeeResults[0]
  row.status = 'BLOCKED'
  row.issues = [{ type: 'PAYROLL_SUBJECT_OUTSIDE_RANGE', payrollImpact: 'YES' }]
  const daily = row.dailyReconciliation[0]
  daily.payroll.components.transferSubsidy = '8800'
  daily.payroll.components.bigBonus = '11040'
  daily.payroll.components.salaryAdjustment = '10000'
  daily.payroll.totalCents = '44840'
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data, preview: true, dataAsOf: '2026-09-30T14:49:25.347Z' })
  assert.equal(model.summary.sourceReviewIssueCount, 1)
  assert.equal(model.summary.sourceProblemCount, 4)
  assert.equal(model.summary.issueCount, 5)
  assert.equal(model.summary.finalResult, 'BLOCKED')
  assert.equal(model.partTime.totalCents, '44840')
  assert.equal(model.partTime.componentsMatchIncludedSubtotal, true)
  assert.equal(model.partTime.componentTotalsCents.transferSubsidy, '8800')
  assert.equal(model.partTime.componentTotalsCents.bigBonus, '11040')
  assert.equal(model.partTime.componentTotalsCents.salaryAdjustment, '10000')
  for (const output of [renderUnifiedMonthlyHtml(model), renderUnifiedMonthlyMarkdown(model), renderUnifiedMonthlyEmail(model).body]) {
    assert.match(output, /来源未到位/)
    assert.match(output, /旧来源待复核/)
    assert.match(output, /来源完整性问题/)
    assert.match(output, /这不是已证实工资算错/)
    assert.doesNotMatch(output, /真实异常|REVIEW_REQUIRED|Mode:|Source reports read:/)
  }
  const html = renderUnifiedMonthlyHtml(model)
  assert.match(html, /全职来源人数<\/span><b>来源未到位 \/ 未知/)
  assert.match(html, /全职来源工时<\/span><b>来源未到位 \/ 未知/)
  assert.match(html, /跨店补贴<\/span><b>¥88.00/)
  assert.match(html, /大单奖励<\/span><b>¥110.40/)
  assert.match(html, /工资调整<\/span><b>¥100.00/)
})

test('in-month incomplete daily source records are described as daily detail gaps, not cross-month periods', () => {
  const data = sources()
  const row = data.partTimeSources[2].model.employeeResults[0]
  row.dailyPayrollBreakdownComplete = false
  row.authoritativePayrollCents = null
  row.dailyPayrollBreakdownReason = 'MONTH_BOUNDARY_SOURCE_INSUFFICIENT'
  const model = buildUnifiedMonthlyPayrollSummary({ ...month, ...executionMetadata, ...data })
  const detail = model.insufficientSourceDetails[0]
  assert.equal(detail.period.start, '2026-09-14')
  assert.equal(detail.employees[0].payrollMissing, true)
  const html = renderUnifiedMonthlyHtml(model)
  assert.match(html, /逐日工资明细完整性不足：2026-09-14～2026-09-20/)
  assert.match(html, /本周期权威工资结果为空/)
  assert.match(html, /不是日期跨月缺口/)
  assert.equal(model.summary.sourceProblemCount, 1)
})
