import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { duePayrollAuditJobs, payrollAuditJobKey, recoverablePayrollAuditJobs, resendPayrollAuditJob, runPayrollAuditJob } from '../server/payroll-audit-scheduler-core.js'
import { previousWeekPeriod } from '../server/payroll-audit-report.js'
import { canManagePayrollAudit } from '../server/payroll-audit-admin.js'
import { checkPayrollAuditEmailTransport, payrollAuditEmailFailureDiagnostic, sendPayrollAuditEmail } from '../server/payroll-audit-email.js'
import { writePayrollAuditJob } from '../server/payroll-audit-job-store.js'

function snapshot() {
  const period = { periodStart: '2026-09-14', periodEnd: '2026-09-20' }
  const employees = [
    { id: 'part', employeeNo: 'BUDU-1', name: '兼职', status: 'ACTIVE', type: 'parttime' },
    { id: 'full', employeeNo: 'BUDU-2', name: '全职', status: 'ACTIVE', type: 'fulltime' },
  ]
  return { generatedAt: '2026-09-21T01:00:00.000Z', productionSha: 'test-sha', database: 'budu_test', authorityDigest: 'digest',
    digests: {}, schedules: [], attendanceRows: [{ id: 'dss', employeeId: 'part', date: '2026-09-14', storeKey: 'x', actualHours: 4, payableHours: 4, payableHoursSource: 'ACTUAL_HOURS' }],
    cardAmountCentsById: { part: '12000', full: '30000' }, authority: { period, employees, storeNames: { x: '测试店' }, result: { calculationReady: true,
      payroll: { employees: [
        { employeeId: 'part', displayName: '兼职', payableHours: 4, basePay: 100, overtimePay: 10, commission: 10, salary: 120, dailyExplanations: [{ date: '2026-09-14', storeKey: 'x', storeName: '测试店', payableHours: 4, payableHoursSource: 'ACTUAL_HOURS', explanation: { state: 'NORMAL' } }] },
        { employeeId: 'full', displayName: '全职', payableHours: 8, basePay: 300, salary: 300, dailyExplanations: [] },
      ] }, readiness: { employees: [{ employeeId: 'part', blockers: [] }, { employeeId: 'full', blockers: [] }] }, blockers: [] } } }
}

const executionMetadata = { actualModel: 'GPT-5.6 Sol', actualReasoning: 'Medium' }

test('natural week and Shanghai Monday/month-first scheduling are exact and independent', () => {
  assert.deepEqual(previousWeekPeriod(new Date('2026-09-21T00:15:00+08:00')), { periodStart: '2026-09-14', periodEnd: '2026-09-20' })
  assert.deepEqual(duePayrollAuditJobs(new Date('2026-05-31T16:15:00.000Z')), [
    { reportType: 'WEEKLY_PART_TIME', periodStart: '2026-05-25', periodEnd: '2026-05-31' },
    { reportType: 'MONTHLY_FULL_TIME', periodStart: '2026-05-01', periodEnd: '2026-05-31' },
  ])
  assert.deepEqual(duePayrollAuditJobs(new Date('2026-05-31T15:59:59.000Z')), [])
})

test('daily reconciliation catches a missed Monday but honors activation cutoff', () => {
  assert.deepEqual(recoverablePayrollAuditJobs(new Date('2026-09-22T01:00:00.000Z'), '2026-09-21'), [
    { reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20' },
  ])
  assert.throws(() => recoverablePayrollAuditJobs(new Date('2026-09-22T01:00:00.000Z'), ''), /START_DATE/)
})

test('weekly isolates current canonical PART_TIME, keeps actualHours/overtime/commission, retries once and explicit resend audits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-scheduler-'))
  const old = process.env.PAYROLL_AUDIT_DATA_DIR
  process.env.PAYROLL_AUDIT_DATA_DIR = root
  let sends = 0
  const send = async (payload) => {
    sends += 1
    assert.deepEqual(payload.recipients, ['yuegu1995@gmail.com', '970701330@qq.com', 'korea_jing@163.com'])
    if (sends === 1) throw Object.assign(new Error('test failure'), { code: 'TEST_TRANSPORT' })
    return { messageId: `message-${sends}` }
  }
  const input = { reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', email: true, allowNonProduction: true, ...executionMetadata }
  try {
    const first = await runPayrollAuditJob(input, { snapshot: async () => snapshot(), send })
    assert.equal(first.job.emailStatus, 'FAILED')
    assert.equal(first.job.lastEmailDiagnostic.safeErrorCode, 'TEST_TRANSPORT')
    assert.equal(first.job.employeeCount, 1)
    const model = JSON.parse(fs.readFileSync(path.join(root, 'runs', first.job.runId, 'canonical-report-model.json'), 'utf8'))
    assert.deepEqual(model.employeeResults.map((row) => row.employeeId), ['part'])
    assert.equal(model.employeeResults[0].employmentType, 'parttime')
    assert.equal(model.employeeResults[0].dailyReconciliation[0].actual[0].authority, 'ACTUAL_HOURS')
    assert.ok(model.employeeResults[0].components.some((row) => row.key === 'overtimePay'))
    assert.ok(model.employeeResults[0].components.some((row) => row.key === 'commission'))
    assert.equal(model.summary.finalResult, 'REVIEW_REQUIRED')
    assert.equal(model.metadata.actualModel, 'GPT-5.6 Sol')
    assert.equal(model.metadata.actualReasoning, 'Medium')
    assert.equal(model.metadata.source, 'budu OS Payroll Audit')
    const second = await runPayrollAuditJob(input, { snapshot: async () => { throw new Error('must reuse report') }, send })
    assert.equal(second.job.emailStatus, 'SENT')
    assert.equal(second.job.retryCount, 2)
    const resent = await resendPayrollAuditJob(second.job.jobKey, 'developer-1', { send })
    assert.equal(resent.emailAttempts.at(-1).resend, true)
    assert.equal(resent.emailAttempts.at(-1).actorId, 'developer-1')
    assert.equal(sends, 3)
  } finally {
    if (old === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = old
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stale non-canonical weekly artifact is archived and replaced instead of retried', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-stale-'))
  const old = process.env.PAYROLL_AUDIT_DATA_DIR
  process.env.PAYROLL_AUDIT_DATA_DIR = root
  const jobKey = payrollAuditJobKey({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20' })
  try {
    const runDir = path.join(root, 'runs', 'old-run')
    fs.mkdirSync(runDir, { recursive: true })
    const files = { model: path.join(runDir, 'canonical-report-model.json'), markdown: path.join(runDir, 'old.md'), pdf: path.join(runDir, 'old.pdf') }
    const staleModel = { schemaVersion: 4, runId: 'old-run', canonicalHash: 'old-hash', metadata: { reportType: 'WEEKLY_PART_TIME', requestedPeriod: { start: '2026-09-14', end: '2026-09-20' }, productionSha: 'old-sha' }, summary: { finalResult: 'BLOCKED' } }
    fs.writeFileSync(files.model, JSON.stringify(staleModel)); fs.writeFileSync(files.markdown, 'old'); fs.writeFileSync(files.pdf, 'old')
    const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const manifest = path.join(runDir, 'manifest.json')
    fs.writeFileSync(manifest, JSON.stringify({ canonicalHash: 'old-hash', artifacts: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, { path: file, sha256: sha(file) }])), email: { status: 'FAILED', attempts: [{ status: 'FAILED' }] } }))
    const email = path.join(runDir, 'email-payload.json'); fs.writeFileSync(email, JSON.stringify({ subject: 'old', body: 'old', attachments: [] }))
    writePayrollAuditJob({ jobKey, reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', runId: 'old-run', emailStatus: 'FAILED', retryCount: 1, artifacts: { ...files, email, manifest } })
    let sends = 0
    const result = await runPayrollAuditJob({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', email: true, allowNonProduction: true, ...executionMetadata }, { snapshot: async () => snapshot(), send: async () => { sends += 1; return { messageId: 'new-message' } } })
    assert.notEqual(result.job.runId, 'old-run')
    assert.equal(result.job.emailStatus, 'SENT')
    assert.equal(sends, 1)
    const archivedFiles = fs.readdirSync(path.join(root, 'jobs', 'history'))
    assert.equal(archivedFiles.length, 1)
    const archived = JSON.parse(fs.readFileSync(path.join(root, 'jobs', 'history', archivedFiles[0]), 'utf8'))
    assert.equal(archived.archival.classification, 'STALE_SCHEMA/NON_CANONICAL/NOT_SENDABLE')
    assert.equal(archived.emailStatus, 'FAILED')
  } finally {
    if (old === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = old
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('formal identities separate weekly, monthly and test delivery', () => {
  const weekly = payrollAuditJobKey({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20' })
  const testKey = payrollAuditJobKey({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', test: true })
  const monthly = payrollAuditJobKey({ reportType: 'MONTHLY_FULL_TIME', periodStart: '2026-09-01', periodEnd: '2026-09-30' })
  assert.notEqual(weekly, monthly)
  assert.notEqual(weekly, testKey)
})

test('monthly isolates FULL_TIME and server RBAC only permits active developer/admin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-monthly-'))
  const old = process.env.PAYROLL_AUDIT_DATA_DIR
  process.env.PAYROLL_AUDIT_DATA_DIR = root
  try {
    const result = await runPayrollAuditJob({ reportType: 'MONTHLY_FULL_TIME', periodStart: '2026-09-01', periodEnd: '2026-09-30', email: false, allowNonProduction: true, ...executionMetadata }, { snapshot: async () => snapshot() })
    const model = JSON.parse(fs.readFileSync(path.join(root, 'runs', result.job.runId, 'canonical-report-model.json'), 'utf8'))
    assert.deepEqual(model.employeeResults.map((row) => row.employeeId), ['full'])
    assert.equal(model.metadata.employeeType, 'fulltime')
    for (const role of ['developer', 'admin']) assert.equal(canManagePayrollAudit({ id: role, role, status: 'active' }), true)
    for (const role of ['finance', 'hr', 'manager', 'staff', 'partner', 'customer']) assert.equal(canManagePayrollAudit({ id: role, role, status: 'active' }), false)
    assert.equal(canManagePayrollAudit({ id: 'admin', role: 'admin', status: 'disabled' }), false)
  } finally {
    if (old === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = old
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('model mismatch fails before snapshot or report artifacts are created', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-model-mismatch-'))
  const old = process.env.PAYROLL_AUDIT_DATA_DIR
  process.env.PAYROLL_AUDIT_DATA_DIR = root
  let snapshotCalled = false
  try {
    await assert.rejects(
      runPayrollAuditJob({
        reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20',
        email: false, allowNonProduction: true, actualModel: 'GPT-6 Astra', actualReasoning: 'High',
      }, { snapshot: async () => { snapshotCalled = true; return snapshot() } }),
      (error) => error.code === 'MODEL_CONFIGURATION_MISMATCH',
    )
    assert.equal(snapshotCalled, false)
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    if (old === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = old
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Gmail transport addresses exactly the three fixed recipients without external agent dependency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-mail-'))
  const attachment = path.join(dir, 'report.md')
  fs.writeFileSync(attachment, 'test', { mode: 0o600 })
  let raw = ''
  const fakeFetch = async (url, options) => {
    if (String(url).includes('/token')) return { ok: true, json: async () => ({ access_token: 'ephemeral-test-token' }) }
    raw = JSON.parse(options.body).raw
    return { ok: true, json: async () => ({ id: 'gmail-id' }) }
  }
  try {
    const result = await sendPayrollAuditEmail({ subject: 'test', body: 'body', attachments: [attachment] }, { credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', from: 'sender@example.com' }, fetch: fakeFetch })
    const mime = Buffer.from(raw, 'base64url').toString('utf8')
    assert.match(mime, /To: yuegu1995@gmail\.com, 970701330@qq\.com, korea_jing@163\.com/)
    assert.deepEqual(result.recipients, ['yuegu1995@gmail.com', '970701330@qq.com', 'korea_jing@163.com'])
    assert.doesNotMatch(mime, /secret|refresh|ephemeral-test-token/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Gmail health is non-sending and failures expose only structured safe diagnostics', async () => {
  let sends = 0
  const healthyFetch = async (url) => {
    if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'ephemeral-test-token' }) }
    sends += 1
    assert.match(String(url), /\/profile$/)
    return { ok: true, status: 200, json: async () => ({ emailAddress: 'sender@example.com' }) }
  }
  const options = { credentials: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', from: 'sender@example.com' }, fetch: healthyFetch }
  const health = await checkPayrollAuditEmailTransport(options)
  assert.equal(health.authenticated, true)
  assert.equal(sends, 1)
  await assert.rejects(checkPayrollAuditEmailTransport({ ...options, fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), (error) => {
    const diagnostic = payrollAuditEmailFailureDiagnostic(error)
    assert.deepEqual({ stage: diagnostic.stage, phase: diagnostic.phase, status: diagnostic.httpStatus, retryable: diagnostic.retryable }, { stage: 'OAUTH_TOKEN_REFRESH', phase: 'AUTH', status: 401, retryable: false })
    assert.doesNotMatch(JSON.stringify(diagnostic), /ephemeral-test-token|clientSecret|refreshToken/)
    return true
  })
})

test('scheduler runtime path has no Codex, ChatGPT, OpenAI or agent dependency', () => {
  const files = ['scripts/payroll-audit-scheduler.mjs', 'scripts/run-payroll-audit-scheduler-host.sh', 'server/payroll-audit-scheduler-core.js', 'server/payroll-audit-email.js']
  const source = files.map((file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n')
  assert.doesNotMatch(source, /codex|chatgpt|openai|agent/i)
})
