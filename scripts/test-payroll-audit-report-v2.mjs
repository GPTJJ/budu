import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  buildPayrollAuditReportModel,
  payrollAuditDisplayLabel,
  previousMonthPeriod,
  payrollAuditSourceMark,
  renderPayrollAuditEmail,
  renderPayrollAuditHtml,
  renderPayrollAuditMarkdown,
} from '../server/payroll-audit-report.js'
import { markEmailDelivery } from '../server/payroll-audit-run-store.js'
import { runPayrollAuditFromSnapshot } from './payroll-audit-runner.mjs'
import { renderPayrollAuditPdf } from './render-payroll-audit-pdf.mjs'

const period = { periodStart: '2026-08-01', periodEnd: '2026-08-31' }
const executionMetadata = { actualModel: 'GPT-5.6 Sol', actualReasoning: 'Medium' }
const sourceMarkText = '由 budu Payroll Audit Automation 生成 · 来源：budu OS Payroll Audit · 模型：GPT-5.6 Sol / Medium'

function extractPdfPages(pdf, firstPage, lastPage, temporaryRoot) {
  const poppler = spawnSync('pdftotext', ['-f', String(firstPage), '-l', String(lastPage), pdf, '-'], { encoding: 'utf8' })
  if (!poppler.error && poppler.status === 0) return poppler.stdout
  if (process.platform !== 'darwin') throw poppler.error || new Error(poppler.stderr || 'pdftotext failed')
  const swiftFile = path.join(temporaryRoot, 'extract-pdf-pages.swift')
  fs.writeFileSync(swiftFile, `import Foundation\nimport PDFKit\nlet document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!\nlet first = Int(CommandLine.arguments[2])! - 1\nlet last = Int(CommandLine.arguments[3])! - 1\nfor index in first...last { print(document.page(at: index)?.string ?? "") }\n`)
  const result = spawnSync('swift', [swiftFile, pdf, String(firstPage), String(lastPage)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function pdfPageCount(pdf, temporaryRoot) {
  const info = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' })
  if (!info.error && info.status === 0) return Number((info.stdout.match(/^Pages:\s+(\d+)/m) || [])[1])
  if (process.platform !== 'darwin') throw info.error || new Error(info.stderr || 'pdfinfo failed')
  const swiftFile = path.join(temporaryRoot, 'pdf-page-count.swift')
  fs.writeFileSync(swiftFile, 'import Foundation\nimport PDFKit\nprint(PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!.pageCount)\n')
  const result = spawnSync('swift', [swiftFile, pdf], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return Number(result.stdout.trim())
}

function assertSourceMarkPlacement(pdf, temporaryRoot) {
  const pages = pdfPageCount(pdf, temporaryRoot)
  assert.ok(pages >= 2, `expected multi-page PDF, got ${pages}`)
  const firstPageText = extractPdfPages(pdf, 1, 1, temporaryRoot)
  const laterPagesText = extractPdfPages(pdf, 2, pages, temporaryRoot)
  assert.equal((firstPageText.match(/budu Payroll Audit Automation/g) || []).length, 1)
  assert.equal((laterPagesText.match(/budu Payroll Audit Automation/g) || []).length, 0)
  return pages
}

function snapshotFixture() {
  return {
    generatedAt: '2026-09-01T00:30:00.000Z',
    productionSha: 'prod-sha-test',
    database: 'budu_test',
    authorityDigest: 'authority-digest-test',
    authority: {
      period,
      storeNames: { guanshe: '北京官舍店', tongying: '北京通盈中心店' },
      employees: [
        { id: 'emp-capybara', employeeNo: 'BUDU-0001', name: '卡皮巴拉', status: 'ACTIVE' },
        { id: 'emp-review', employeeNo: 'BUDU-0002', name: '陈文慧', status: 'ACTIVE' },
        { id: 'emp-blocked', employeeNo: 'BUDU-0003', name: '隋晓', status: 'ACTIVE' },
      ],
      result: {
        calculationReady: false,
        payroll: { employees: [
          { employeeId: 'emp-capybara', displayName: '卡皮巴拉', payableHours: 8, basePay: 260, commission: 20, customAllowance: 5, salary: 285, dailyExplanations: [{ date: '2026-08-03', storeKey: 'tongying', storeName: '北京通盈中心店', payableHours: 8, payableHoursSource: 'ACTUAL_HOURS', explanation: { state: 'NORMAL' } }] },
          { employeeId: 'emp-review', displayName: '陈文慧', payableHours: 6, basePay: 198, commission: 0, salary: 198, dailyExplanations: [{ date: '2026-08-04', storeKey: 'guanshe', storeName: '北京官舍店', payableHours: 6, payableHoursSource: 'ACTUAL_HOURS', explanation: { state: 'NORMAL' } }] },
        ] },
        readiness: { employees: [
          { employeeId: 'emp-capybara', blockers: [] },
          { employeeId: 'emp-review', blockers: [] },
          { employeeId: 'emp-blocked', blockers: [{ type: 'CALCULATION_BLOCKER', reason: 'MISSING_ACTUAL_HOURS', date: '2026-08-18', storeKey: 'guanshe', detail: 'actualHours missing' }] },
        ] },
        blockers: [{ type: 'CALCULATION_BLOCKER', reason: 'MISSING_ACTUAL_HOURS', employeeId: 'emp-blocked', date: '2026-08-18', storeKey: 'guanshe', detail: 'actualHours missing' }],
      },
    },
    cardAmountCentsById: { 'emp-capybara': '28500', 'emp-review': '19801' },
    attendanceRows: [
      { id: 'dss-1', employeeId: 'emp-capybara', date: '2026-08-03', storeKey: 'tongying', storeId: 'tongying', actualHours: 8, payableHours: 8, payableHoursSource: 'ACTUAL_HOURS' },
      { id: 'dss-2', employeeId: 'emp-review', date: '2026-08-04', storeKey: 'guanshe', storeId: 'guanshe', actualHours: 6, payableHours: 6, payableHoursSource: 'ACTUAL_HOURS' },
    ],
    schedules: [
      { id: 'schedule-1', storeKey: 'guanshe', date: '2026-08-03', shifts: [{ employeeId: 'emp-capybara', staff: '卡皮巴拉', time: '10:00-18:00' }] },
      { id: 'schedule-legacy', storeKey: 'guanshe', date: '2026-08-05', shifts: [{ staff: '历史姓名', time: '10:00-18:00' }] },
    ],
  }
}

function build(options = {}) {
  const snapshot = snapshotFixture()
  return buildPayrollAuditReportModel({
    period, authority: snapshot.authority, schedules: snapshot.schedules,
    attendanceRows: snapshot.attendanceRows, cardAmountCentsById: snapshot.cardAmountCentsById,
    generatedAt: snapshot.generatedAt, productionSha: snapshot.productionSha,
    authorityDigest: snapshot.authorityDigest, auditMode: options.mode || 'FINAL', scope: options.scope || 'ALL',
    scopeEmployeeIds: options.ids, ...executionMetadata,
  })
}

test('canonical model keeps missing payroll and a one-cent card mismatch blocked', () => {
  const model = build()
  assert.equal(model.summary.finalResult, 'BLOCKED')
  assert.equal(model.summary.passCount, 1)
  assert.equal(model.summary.reviewRequiredCount, 0)
  assert.equal(model.summary.blockedCount, 2)
  assert.equal(model.employeeResults.find((row) => row.employeeId === 'emp-review').differenceCents, '1')
})

function statusFixture() {
  const employeeId = 'paid'
  return {
    ...executionMetadata, period, employmentTypeHistoryAvailable: false,
    authority: {
      employees: [{ id: employeeId, name: '测试员工', type: 'parttime' }],
      result: {
        payroll: { employees: [{
          employeeId, payableHours: 8, salary: 200, basePay: 200,
          dailyExplanations: [{ date: '2026-08-03', storeKey: 'test', payableHours: 8,
            payableHoursSource: 'ACTUAL_HOURS', basePay: 200, finalPay: 200 }],
        }] },
        readiness: { employees: [{ employeeId, blockers: [] }] }, blockers: [],
      },
    },
    attendanceRows: [{ employeeId, date: '2026-08-03', storeKey: 'test', actualHours: 8, payableHoursSource: 'ACTUAL_HOURS' }],
    cardAmountCentsById: { [employeeId]: '20000' },
  }
}

function addIdleEmployee(input, employeeId = 'idle') {
  input.authority.employees.push({ id: employeeId, name: '未出勤员工', type: 'parttime' })
  input.scopeEmployeeIds = input.authority.employees.map((row) => row.id)
  return input
}

test('CASE 1: verified paid employee retains employment history warning without HOLD', () => {
  const model = buildPayrollAuditReportModel(statusFixture())
  assert.equal(model.employeeResults[0].status, 'PASS')
  const warning = model.employeeResults[0].issues.find((issue) => issue.type === 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE')
  assert.ok(warning)
  assert.equal(warning.payrollImpact, 'NO')
  assert.equal(model.summary.finalResult, 'PASS')
  assert.equal(model.summary.settlementRecommendation, '可以进入独立结算复核')
})

test('CASE 2: no attendance, payroll or card uses report-only NO_PAYROLL_REQUIRED', () => {
  for (const actualHours of [null, 0]) {
    const input = addIdleEmployee(statusFixture())
    if (actualHours === 0) input.attendanceRows.push({ employeeId: 'idle', date: '2026-08-04', actualHours: 0 })
    const model = buildPayrollAuditReportModel(input)
    const idle = model.employeeResults.find((row) => row.employeeId === 'idle')
    assert.equal(idle.status, 'PASS')
    assert.equal(idle.authoritativePayrollCents, null)
    assert.equal(idle.employeeCardCents, null)
    assert.ok(idle.issues.some((issue) => issue.rootCause === 'NO_PAYROLL_REQUIRED' && issue.payrollImpact === 'NO'))
    assert.equal(model.summary.finalResult, 'PASS')
    assert.match(renderPayrollAuditMarkdown(model), /本期无需结算/)
  }
})

test('CASE 3: actual hours without payroll stay blocked even when totals match', () => {
  const input = addIdleEmployee(statusFixture())
  input.attendanceRows.push({ employeeId: 'idle', date: '2026-08-04', actualHours: 10 })
  const model = buildPayrollAuditReportModel(input)
  assert.equal(model.summary.differenceCents, '0')
  assert.equal(model.employeeResults.find((row) => row.employeeId === 'idle').status, 'BLOCKED')
  assert.equal(model.summary.finalResult, 'BLOCKED')
})

test('CASE 4: one-cent amount mismatch blocks settlement', () => {
  const input = statusFixture()
  input.cardAmountCentsById.paid = '20001'
  const model = buildPayrollAuditReportModel(input)
  assert.equal(model.employeeResults[0].status, 'BLOCKED')
  assert.equal(model.summary.settlementRecommendation, '暂不建议进入结算')
  assert.match(renderPayrollAuditMarkdown(model), /员工薪酬卡片：不一致/)
})

test('CASE 5: mixed paid and informational-only employees allow settlement with matching conclusions', () => {
  const model = buildPayrollAuditReportModel(addIdleEmployee(statusFixture()))
  assert.equal(model.summary.passCount, 2)
  assert.equal(model.summary.reviewRequiredCount, 0)
  assert.equal(model.summary.blockedCount, 0)
  assert.equal(model.summary.finalResult, 'PASS')
  assert.equal(model.summary.settlementRecommendation, '可以进入独立结算复核')
  assert.match(renderPayrollAuditMarkdown(model), /薪酬权威：通过\n员工薪酬卡片：一致/)
  assert.match(renderPayrollAuditHtml(model), /<span>薪酬权威<\/span><b>通过<\/b>/)
  assert.match(renderPayrollAuditHtml(model), /<span>员工薪酬卡片<\/span><b>一致<\/b>/)
})

test('CASE 6: a real amount-affecting blocker in a mixed batch keeps HOLD', () => {
  const input = addIdleEmployee(statusFixture())
  input.authority.result.readiness.employees[0].blockers.push({
    type: 'CALCULATION_BLOCKER', reason: 'MISSING_ACTUAL_HOURS', detail: 'actualHours missing',
  })
  const model = buildPayrollAuditReportModel(input)
  assert.equal(model.summary.differenceCents, '0')
  assert.equal(model.summary.finalResult, 'BLOCKED')
  assert.equal(model.summary.settlementRecommendation, '暂不建议进入结算')
  assert.match(renderPayrollAuditMarkdown(model), /薪酬权威：未通过\n员工薪酬卡片：一致/)
})

test('opposite employee card errors cannot cancel each other into a PASS', () => {
  const input = statusFixture()
  input.authority.employees.push({ id: 'other', type: 'parttime' })
  input.authority.result.payroll.employees.push({ ...input.authority.result.payroll.employees[0], employeeId: 'other' })
  input.cardAmountCentsById = { paid: '20001', other: '19999' }
  const model = buildPayrollAuditReportModel(input)
  assert.equal(model.summary.differenceCents, '0')
  assert.equal(model.summary.blockedCount, 2)
  assert.equal(model.summary.finalResult, 'BLOCKED')
})

test('zero attendance never hides adjustment-only readiness or a nonzero card', () => {
  for (const fact of ['adjustment', 'card']) {
    const input = addIdleEmployee(statusFixture())
    if (fact === 'adjustment') input.authority.result.readiness.employees.push({ employeeId: 'idle', days: 0, blockers: [] })
    else input.cardAmountCentsById.idle = '100'
    const idle = buildPayrollAuditReportModel(input).employeeResults.find((row) => row.employeeId === 'idle')
    assert.equal(idle.status, 'BLOCKED', fact)
    assert.ok(idle.issues.some((issue) => issue.type === 'PAYROLL_SUBJECT_OUTSIDE_RANGE' && issue.payrollImpact === 'YES'))
  }
})

test('employee-scoped identity, contribution and global calculation blockers remain effective', () => {
  for (const reason of ['IDENTITY_ERROR', 'LEGACY_PAY_ADJUSTMENT_IDENTITY', 'LEGACY_BIG_BONUS_IDENTITY']) {
    const input = statusFixture()
    input.authority.result.blockers = [{ type: 'CALCULATION_BLOCKER', reason, employeeId: 'paid' }]
    assert.equal(buildPayrollAuditReportModel(input).summary.finalResult, 'BLOCKED', reason)
    input.authority.result.blockers[0] = { type: 'CALCULATION_BLOCKER', reason, employeeIds: ['paid'] }
    assert.equal(buildPayrollAuditReportModel(input).summary.finalResult, 'BLOCKED', reason)
    delete input.authority.result.blockers[0].employeeIds
    assert.equal(buildPayrollAuditReportModel(input).summary.finalResult, 'BLOCKED', reason)
  }
})

test('unknown employment type keeps review but does not falsely label matching cards inconsistent', () => {
  const input = statusFixture()
  delete input.authority.employees[0].type
  const model = buildPayrollAuditReportModel(input)
  assert.equal(model.summary.finalResult, 'REVIEW_REQUIRED')
  assert.match(renderPayrollAuditMarkdown(model), /员工薪酬卡片：一致/)
  assert.match(renderPayrollAuditHtml(model), /<span>员工薪酬卡片<\/span><b>一致<\/b>/)
})

test('missing salary, explicit missing card and invalid actualHours fail closed', () => {
  for (const missing of ['salary', 'card', 'hours', 'identity']) {
    const input = statusFixture()
    if (missing === 'salary') delete input.authority.result.payroll.employees[0].salary
    if (missing === 'card') input.cardAmountCentsById.paid = null
    if (missing === 'hours') input.attendanceRows[0].actualHours = null
    if (missing === 'identity') input.authority.employees = []
    assert.equal(buildPayrollAuditReportModel(input).summary.finalResult, 'BLOCKED', missing)
  }
})

test('status classification never mutates authority amounts, hours, components or input', () => {
  const input = addIdleEmployee(statusFixture())
  const before = JSON.stringify(input)
  const model = buildPayrollAuditReportModel(input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(model.summary.authoritativePayrollCents, '20000')
  assert.equal(model.summary.employeeCardCents, '20000')
  assert.equal(model.employeeResults.find((row) => row.employeeId === 'paid').payableHours, 8)
  assert.equal(model.employeeResults.find((row) => row.employeeId === 'paid').components[0].amountCents, '20000')
})

test('an explicitly empty employment-type scope never falls back to all payroll subjects', () => {
  const model = buildPayrollAuditReportModel({
    period: { periodStart: '2026-09-14', periodEnd: '2026-09-20' },
    authority: snapshotFixture().authority,
    scopeEmployeeIds: [],
    reportType: 'WEEKLY_PART_TIME',
    employeeType: 'parttime',
    ...executionMetadata,
  })
  assert.equal(model.summary.employeeCount, 0)
  assert.deepEqual(model.employeeResults, [])
})

test('Cardbara is normal authority subject and Schedule mismatch does not fail payroll', () => {
  const capybara = build().employeeResults.find((row) => row.employeeId === 'emp-capybara')
  assert.equal(capybara.businessRole, '老板替班')
  assert.equal(capybara.status, 'PASS')
  assert.equal(capybara.scheduleStatus, 'REVIEW')
  assert.equal(capybara.dailyReconciliation.find((row) => row.date === '2026-08-03').scheduleResult, 'STORE_CHANGED')
})

test('dynamic Payroll components and every period day are preserved', () => {
  const employee = build({ ids: ['emp-capybara'] }).employeeResults[0]
  assert.ok(employee.components.some((component) => component.key === 'customAllowance'))
  assert.equal(employee.dailyReconciliation.length, 31)
  assert.equal(employee.dailyReconciliation[0].result, 'NO_ACTUAL_ATTENDANCE')
})

test('daily payroll breakdown persists exact component and final-pay cents for month slicing', () => {
  const snapshot = snapshotFixture()
  snapshot.authority.employees = snapshot.authority.employees.filter((row) => row.id === 'emp-capybara')
  snapshot.authority.result.readiness.employees = snapshot.authority.result.readiness.employees.filter((row) => row.employeeId === 'emp-capybara')
  snapshot.authority.result.blockers = []
  snapshot.authority.result.payroll.employees = [{
    employeeId: 'emp-capybara', displayName: '卡皮巴拉', payableHours: 8,
    basePay: 260, commission: 20, bigBonus: 5, salary: 285,
    dailyExplanations: [{
      date: '2026-08-03', storeKey: 'tongying', storeName: '北京通盈中心店', payableHours: 8,
      payableHoursSource: 'ACTUAL_HOURS', basePay: 260, commission: 20, bigBonus: 5,
      transferSubsidy: 0, salaryAdjustment: 0, finalPay: 285, explanation: { state: 'NORMAL' },
    }],
  }]
  const model = buildPayrollAuditReportModel({
    period, authority: snapshot.authority, schedules: snapshot.schedules, attendanceRows: snapshot.attendanceRows,
    cardAmountCentsById: { 'emp-capybara': '28500' }, scopeEmployeeIds: ['emp-capybara'], ...executionMetadata,
  })
  const employee = model.employeeResults[0]
  const payrollDay = employee.dailyReconciliation.find((row) => row.date === '2026-08-03')
  assert.equal(employee.dailyPayrollBreakdownComplete, true)
  assert.equal(payrollDay.payroll.totalCents, '28500')
  assert.equal(payrollDay.payroll.components.basePay, '26000')
  assert.equal(payrollDay.payroll.components.commission, '2000')
  assert.equal(payrollDay.payroll.components.bigBonus, '500')
})

test('PREVIEW and FINAL metadata retain the caller-resolved effective range', () => {
  const preview = buildPayrollAuditReportModel({ ...snapshotFixture(), period: { periodStart: '2026-09-01', periodEnd: '2026-09-14' }, auditMode: 'PREVIEW', scopeEmployeeIds: ['emp-capybara'], ...executionMetadata })
  const final = build({ mode: 'FINAL', ids: ['emp-capybara'] })
  assert.equal(preview.metadata.auditMode, 'PREVIEW')
  assert.equal(preview.metadata.effectivePeriod.end, '2026-09-14')
  assert.equal(final.metadata.effectivePeriod.end, '2026-08-31')
})

test('previous-month resolver uses full natural month', () => {
  assert.deepEqual(previousMonthPeriod(new Date('2026-10-01T00:10:00+08:00')), { periodStart: '2026-09-01', periodEnd: '2026-09-30' })
  assert.deepEqual(previousMonthPeriod(new Date('2026-03-01T00:10:00+08:00')), { periodStart: '2026-02-01', periodEnd: '2026-02-28' })
})

test('Markdown, PDF HTML and email share the canonical model', () => {
  const model = build()
  const markdown = renderPayrollAuditMarkdown(model)
  const html = renderPayrollAuditHtml(model)
  const email = renderPayrollAuditEmail(model)
  for (const output of [markdown, html, email.body]) {
    assert.match(output, /暂不建议结算|审查阻断/)
    assert.match(output, /3/)
  }
  assert.match(markdown, new RegExp(model.canonicalHash))
  assert.equal(email.canonicalHash, model.canonicalHash)
  assert.equal(email.recipient, 'yuegu1995@gmail.com')
  assert.deepEqual(email.recipients, ['yuegu1995@gmail.com', '970701330@qq.com', 'korea_jing@163.com'])
  assert.equal(email.subject, 'budu 全职员工薪酬审查报告｜2026年08月｜暂不建议结算')
  assert.equal(model.schemaVersion, 6)
  assert.equal(model.metadata.actualModel, 'GPT-5.6 Sol')
  assert.equal(model.metadata.actualReasoning, 'Medium')
  assert.equal(model.metadata.source, 'budu OS Payroll Audit')
  assert.equal(payrollAuditSourceMark(model), sourceMarkText)
  assert.equal(model.metadata.brand.name, 'budu')
  assert.doesNotMatch(`${markdown}\n${html}\n${email.body}`, /password|webhook|token|credential/i)
})

test('Chinese-first presentation keeps technical codes only as trace labels', () => {
  const model = build()
  const html = renderPayrollAuditHtml(model)
  const markdown = renderPayrollAuditMarkdown(model)
  assert.equal(payrollAuditDisplayLabel('PASS'), '通过')
  assert.equal(payrollAuditDisplayLabel('FAIL'), '未通过')
  assert.equal(payrollAuditDisplayLabel('MATCH'), '一致')
  assert.equal(payrollAuditDisplayLabel('REVIEW_REQUIRED'), '需人工复核')
  assert.equal(payrollAuditDisplayLabel('BLOCKED', 'cover'), '暂不建议结算')
  assert.equal(payrollAuditDisplayLabel('SCHEDULE_ONLY'), '仅有排班记录')
  assert.equal(payrollAuditDisplayLabel('NO_ACTUAL_ATTENDANCE'), '无实际出勤')
  assert.equal(payrollAuditDisplayLabel('UNKNOWN'), '待确认')
  for (const label of ['管理层总览', '员工薪酬审查', '最终审查结论', '本次未自动处理', '薪酬权威', '员工薪酬卡片']) assert.match(html, new RegExp(label))
  assert.match(html, /缺少实际工时/)
  assert.match(html, /本周期缺少薪酬权威结果/)
  assert.match(html, /class="technical-code">技术追溯：MISSING_ACTUAL_HOURS/)
  assert.doesNotMatch(html, />MANAGEMENT SUMMARY<|>EMPLOYEE AUDIT<|>FINAL AUDIT CONCLUSION<|>NO ACTION EXECUTED</)
  assert.match(markdown, /北京官舍店 10:00-18:00/)
  assert.match(markdown, /北京通盈中心店 8小时/)
})

test('presentation-only rendering does not mutate canonical payroll values', () => {
  const model = build()
  const before = JSON.stringify(model)
  renderPayrollAuditMarkdown(model)
  renderPayrollAuditHtml(model)
  renderPayrollAuditEmail(model)
  assert.equal(JSON.stringify(model), before)
  assert.equal(model.summary.employeeCount, 3)
  assert.equal(model.summary.issueCount, 3)
  assert.equal(model.summary.authoritativePayrollCents, '48300')
  assert.equal(model.summary.employeeCardCents, '48301')
})

test('headless run writes protected MD/PDF/email artifacts and duplicate trigger reuses run', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-report-test-'))
  try {
    const snapshot = snapshotFixture()
    const options = { snapshot, periodStart: period.periodStart, periodEnd: period.periodEnd, mode: 'FINAL', scope: 'ALL', outputRoot, email: true, allowNonProduction: true, ...executionMetadata }
    const first = await runPayrollAuditFromSnapshot(options)
    const second = await runPayrollAuditFromSnapshot(options)
    assert.equal(first.reused, false)
    assert.equal(second.reused, true)
    assert.ok(fs.statSync(first.paths.markdown).size > 1000)
    assert.ok(fs.statSync(first.paths.pdf).size > 10000)
    assert.equal(fs.statSync(first.paths.pdf).mode & 0o777, 0o600)
    const payload = JSON.parse(fs.readFileSync(first.paths.email, 'utf8'))
    assert.deepEqual(payload.attachments, [first.paths.pdf, first.paths.markdown])
    assert.equal(payload.canonicalHash, first.model.canonicalHash)
    const failed = markEmailDelivery(first.paths.manifest, { status: 'FAILED', errorCode: 'TEST_TRANSPORT' })
    assert.equal(failed.email.status, 'FAILED')
    const sent = markEmailDelivery(first.paths.manifest, { status: 'SENT', messageId: 'gmail-test-id' })
    assert.equal(sent.email.status, 'SENT')
    assert.equal(sent.email.attempts.length, 2)
    assert.equal((await runPayrollAuditFromSnapshot(options)).reused, true)
    const pages = assertSourceMarkPlacement(first.paths.pdf, outputRoot)
    assert.ok(pages >= 4, `expected multi-page PDF, got ${pages}`)
    const weekly = await runPayrollAuditFromSnapshot({
      ...options,
      periodStart: '2026-09-14',
      periodEnd: '2026-09-20',
      reportType: 'WEEKLY_PART_TIME',
      employeeType: 'parttime',
    })
    assert.equal(weekly.model.metadata.reportType, 'WEEKLY_PART_TIME')
    assertSourceMarkPlacement(weekly.paths.pdf, outputRoot)
    const html = renderPayrollAuditHtml(first.model)
    assert.match(html, /brand-wordmark/)
    assert.doesNotMatch(html, />BUDU 薪酬审查报告</)
    assert.match(html, /卡皮巴拉/)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('one-page PDF renders the source mark exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-one-page-'))
  const pdf = path.join(root, 'one-page.pdf')
  try {
    const mark = payrollAuditSourceMark({ metadata: executionMetadata })
    await renderPayrollAuditPdf(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><p>${mark}</p></body></html>`, pdf)
    assert.equal(pdfPageCount(pdf, root), 1)
    const extracted = extractPdfPages(pdf, 1, 1, root)
    assert.equal((extracted.match(/budu Payroll Audit Automation/g) || []).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('production extractor is read-only by construction', () => {
  const source = fs.readFileSync(new URL('./payroll-audit-extract.mjs', import.meta.url), 'utf8')
  assert.match(source, /SET TRANSACTION READ ONLY/)
  assert.doesNotMatch(source, /tx\.[A-Za-z0-9_]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/)
  assert.match(source, /DailyStoreStaff/)
  assert.match(source, /PayrollNotice/)
})


test('classification is consistent across model, HTML, Markdown and email for 0 anomalies / 9 hints / 2 normal employees', () => {
  const input = statusFixture()
  const paid = input.authority.result.payroll.employees[0]
  input.authority.employees = []
  input.authority.result.payroll.employees = []
  input.authority.result.readiness.employees = []
  input.attendanceRows = []
  input.cardAmountCentsById = {}
  for (let i = 0; i < 7; i += 1) {
    const id = `paid-${i}`
    const amount = i === 6 ? 783.4 : 600
    input.authority.employees.push({ id, name: id, type: 'parttime' })
    input.authority.result.payroll.employees.push({ ...paid, employeeId: id, salary: amount, basePay: amount })
    input.authority.result.readiness.employees.push({ employeeId: id, blockers: [] })
    input.attendanceRows.push({ employeeId: id, date: '2026-08-03', actualHours: 8 })
    input.cardAmountCentsById[id] = String(Math.round(amount * 100))
  }
  addIdleEmployee(input, 'idle-1'); addIdleEmployee(input, 'idle-2')
  const model = buildPayrollAuditReportModel(input)
  assert.equal(model.summary.anomalyCount, 0)
  assert.equal(model.summary.issueCount, 0)
  assert.equal(model.summary.auditHintCount, 9)
  assert.equal(model.summary.noPayrollRequiredCount, 2)
  assert.equal(model.summary.authoritativePayrollCents, '438340')
  assert.equal(model.summary.employeeCardCents, '438340')
  assert.equal(model.summary.finalResult, 'PASS')
  assert.equal(model.employeeResults.flatMap(row => row.issues).filter(i => i.category === 'AUDIT_HINT').length, 9)
  const html = renderPayrollAuditHtml(model)
  const markdown = renderPayrollAuditMarkdown(model)
  const email = renderPayrollAuditEmail(model).body
  for (const output of [html, markdown, email]) {
    assert.doesNotMatch(output, /需关注问题|异常 00|异常与处理建议|请按员工明细逐项核对/)
    assert.match(output, /阻断异常/)
    assert.match(output, /历史资料提示/)
    assert.match(output, /本期无需结算/)
    assert.match(output, /4,383.40/)
  }
  assert.match(markdown, /阻断异常：0 项/)
  assert.match(markdown, /历史资料提示：9 条/)
  assert.match(markdown, /本期无需结算：2 人/)
  assert.equal((html.match(/历史资料提示（非阻断）：/g) || []).length, 9)
  assert.equal((html.match(/正常状态：本期无需结算/g) || []).length, 2)
  assert.doesNotMatch(email, /重点问题/)
})

test('true blockers keep anomaly classification regardless of payrollImpact or reason spelling', () => {
  for (const reason of ['MISSING_ACTUAL_HOURS', 'PAYROLL_AUTHORITY_AMOUNT_MISSING', 'IDENTITY_REVIEW_REQUIRED', 'EMPLOYMENT_TYPE_HISTORY_UNAVAILABLE', 'FUTURE_AUTHORITY_BLOCKER']) {
    const input = statusFixture()
    input.authority.result.readiness.employees[0].blockers.push({ type: 'CALCULATION_BLOCKER', reason })
    const model = buildPayrollAuditReportModel(input)
    const blocker = model.employeeResults[0].issues.find(issue => issue.blockingSource === 'AUTHORITY_BLOCKER')
    assert.equal(blocker.category, 'ANOMALY', reason)
    assert.ok(model.summary.anomalyCount > 0, reason)
    assert.equal(model.summary.finalResult, 'BLOCKED', reason)
  }
  const input = statusFixture()
  input.cardAmountCentsById.paid = '20001'
  const model = buildPayrollAuditReportModel(input)
  const mismatch = model.employeeResults[0].issues.find(issue => issue.type === 'EMPLOYEE_CARD_PROJECTION_ERROR')
  assert.equal(mismatch.payrollImpact, 'NO')
  assert.equal(mismatch.category, 'ANOMALY')
  assert.equal(model.summary.anomalyCount, 1)
  assert.equal(model.summary.finalResult, 'BLOCKED')
  const missing = addIdleEmployee(statusFixture())
  missing.attendanceRows.push({ employeeId: 'idle', date: '2026-08-04', actualHours: 10 })
  const missingModel = buildPayrollAuditReportModel(missing)
  assert.equal(missingModel.summary.anomalyCount, 1)
  assert.equal(missingModel.summary.noPayrollRequiredCount, 0)
  const unknown = statusFixture()
  unknown.authority.employees[0].type = 'unknown'
  const unknownModel = buildPayrollAuditReportModel(unknown)
  assert.equal(unknownModel.summary.finalResult, 'REVIEW_REQUIRED')
  assert.equal(unknownModel.summary.anomalyCount, 1)
})
