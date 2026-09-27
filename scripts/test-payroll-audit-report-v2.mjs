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

function assertSourceMarkPlacement(pdf, temporaryRoot) {
  const info = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' })
  assert.equal(info.status, 0)
  const pages = Number((info.stdout.match(/^Pages:\s+(\d+)/m) || [])[1])
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

test('canonical model supports PASS, REVIEW_REQUIRED, BLOCKED and one-cent mismatch', () => {
  const model = build()
  assert.equal(model.summary.finalResult, 'BLOCKED')
  assert.equal(model.summary.passCount, 1)
  assert.equal(model.summary.reviewRequiredCount, 1)
  assert.equal(model.summary.blockedCount, 1)
  assert.equal(model.employeeResults.find((row) => row.employeeId === 'emp-review').differenceCents, '1')
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
    const info = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' })
    assert.match(info.stdout, /^Pages:\s+1$/m)
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
