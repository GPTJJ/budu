import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  buildPayrollAuditReportModel,
  previousMonthPeriod,
  renderPayrollAuditEmail,
  renderPayrollAuditHtml,
  renderPayrollAuditMarkdown,
} from '../server/payroll-audit-report.js'
import { markEmailDelivery } from '../server/payroll-audit-run-store.js'
import { runPayrollAuditFromSnapshot } from './payroll-audit-runner.mjs'

const period = { periodStart: '2026-08-01', periodEnd: '2026-08-31' }

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
    scopeEmployeeIds: options.ids,
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

test('PREVIEW and FINAL metadata retain the caller-resolved effective range', () => {
  const preview = buildPayrollAuditReportModel({ ...snapshotFixture(), period: { periodStart: '2026-09-01', periodEnd: '2026-09-14' }, auditMode: 'PREVIEW', scopeEmployeeIds: ['emp-capybara'] })
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
    assert.match(output, /BLOCKED/)
    assert.match(output, /3/)
  }
  assert.match(markdown, new RegExp(model.canonicalHash))
  assert.equal(email.canonicalHash, model.canonicalHash)
  assert.equal(email.recipient, 'yuegu1995@gmail.com')
  assert.equal(email.subject, 'budu｜2026年08月薪酬审查报告｜BLOCKED')
  assert.equal(model.schemaVersion, 3)
  assert.equal(model.metadata.brand.name, 'budu')
  assert.doesNotMatch(`${markdown}\n${html}\n${email.body}`, /password|webhook|token|credential/i)
})

test('headless run writes protected MD/PDF/email artifacts and duplicate trigger reuses run', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-report-test-'))
  try {
    const snapshot = snapshotFixture()
    const options = { snapshot, periodStart: period.periodStart, periodEnd: period.periodEnd, mode: 'FINAL', scope: 'ALL', outputRoot, email: true, allowNonProduction: true }
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
    const info = spawnSync('pdfinfo', [first.paths.pdf], { encoding: 'utf8' })
    assert.equal(info.status, 0)
    const pages = Number((info.stdout.match(/^Pages:\s+(\d+)/m) || [])[1])
    assert.ok(pages >= 4, `expected multi-page PDF, got ${pages}`)
    const html = renderPayrollAuditHtml(first.model)
    assert.match(html, /brand-wordmark/)
    assert.doesNotMatch(html, />BUDU 薪酬审查报告</)
    assert.match(html, /卡皮巴拉/)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('production extractor is read-only by construction', () => {
  const source = fs.readFileSync(new URL('./payroll-audit-extract.mjs', import.meta.url), 'utf8')
  assert.match(source, /SET TRANSACTION READ ONLY/)
  assert.doesNotMatch(source, /tx\.[A-Za-z0-9_]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/)
  assert.match(source, /DailyStoreStaff/)
  assert.match(source, /PayrollNotice/)
})
