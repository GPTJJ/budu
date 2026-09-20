import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { previousMonthPeriod, previousWeekPeriod } from './payroll-audit-report.js'
import { markEmailDelivery } from './payroll-audit-run-store.js'
import { PAYROLL_AUDIT_RECIPIENTS, sendPayrollAuditEmail } from './payroll-audit-email.js'
import { listPayrollAuditJobs, payrollAuditDataRoot, readPayrollAuditJob, withPayrollAuditJobLock, writePayrollAuditJob } from './payroll-audit-job-store.js'
import { runPayrollAuditFromSnapshot } from '../scripts/payroll-audit-runner.mjs'

const exec = promisify(execFile)
const TIME_ZONE = 'Asia/Shanghai'
const MAX_EMAIL_ATTEMPTS = 3
const TYPES = Object.freeze({
  WEEKLY_PART_TIME: { employmentType: 'parttime', identity: 'PAYROLL_AUDIT_WEEKLY_PART_TIME' },
  MONTHLY_FULL_TIME: { employmentType: 'fulltime', identity: 'PAYROLL_AUDIT_MONTHLY_FULL_TIME' },
})

const dateParts = (now) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
}).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))

export function duePayrollAuditJobs(now = new Date()) {
  const parts = dateParts(now)
  const jobs = []
  if (parts.weekday === 'Mon') jobs.push({ reportType: 'WEEKLY_PART_TIME', ...previousWeekPeriod(now, TIME_ZONE) })
  if (parts.day === '01') jobs.push({ reportType: 'MONTHLY_FULL_TIME', ...previousMonthPeriod(now, TIME_ZONE) })
  return jobs
}

export function recoverablePayrollAuditJobs(now = new Date(), startDate = process.env.PAYROLL_AUDIT_SCHEDULER_START_DATE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) throw Object.assign(new Error('PAYROLL_AUDIT_SCHEDULER_START_DATE is required'), { code: 'PAYROLL_AUDIT_SCHEDULER_START_DATE_REQUIRED' })
  const parts = dateParts(now)
  const businessDate = `${parts.year}-${parts.month}-${parts.day}`
  const weeklyPeriod = previousWeekPeriod(now, TIME_ZONE)
  const today = new Date(`${businessDate}T00:00:00.000Z`)
  const weeklyDue = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)
  const monthlyDue = `${parts.year}-${parts.month}-01`
  const jobs = []
  if (weeklyDue >= startDate) jobs.push({ reportType: 'WEEKLY_PART_TIME', ...weeklyPeriod })
  if (monthlyDue >= startDate) jobs.push({ reportType: 'MONTHLY_FULL_TIME', ...previousMonthPeriod(now, TIME_ZONE) })
  return jobs
}

export function validatePayrollAuditPeriod(reportType, periodStart, periodEnd) {
  if (!TYPES[reportType] || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) throw Object.assign(new Error('Invalid payroll audit period'), { code: 'PAYROLL_AUDIT_PERIOD_INVALID' })
  const start = new Date(`${periodStart}T00:00:00.000Z`)
  const end = new Date(`${periodEnd}T00:00:00.000Z`)
  if (reportType === 'WEEKLY_PART_TIME' && (start.getUTCDay() !== 1 || end.getUTCDay() !== 0 || end - start !== 6 * 86400000)) throw Object.assign(new Error('Weekly audit must be Monday through Sunday'), { code: 'PAYROLL_AUDIT_PERIOD_INVALID' })
  if (reportType === 'MONTHLY_FULL_TIME') {
    const expectedEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    if (start.getUTCDate() !== 1 || expectedEnd.toISOString().slice(0, 10) !== periodEnd) throw Object.assign(new Error('Monthly audit must be a complete natural month'), { code: 'PAYROLL_AUDIT_PERIOD_INVALID' })
  }
}

export function payrollAuditJobKey({ reportType, periodStart, periodEnd, test = false }) {
  validatePayrollAuditPeriod(reportType, periodStart, periodEnd)
  return `${test ? 'TEST:' : ''}${TYPES[reportType].identity}:${periodStart}:${periodEnd}`
}

async function snapshot(periodStart, periodEnd) {
  const script = path.join(process.cwd(), 'scripts/payroll-audit-extract.mjs')
  const { stdout } = await exec(process.execPath, [script], { env: { ...process.env, AUDIT_PERIOD_START: periodStart, AUDIT_PERIOD_END: periodEnd, AUDIT_DIGEST_ONLY: '0', BUDU_APP_ROOT: process.cwd() }, maxBuffer: 64 * 1024 * 1024, timeout: 60000 })
  return JSON.parse(stdout)
}

async function deliver(job, { resend = false, actorId = '', send = sendPayrollAuditEmail } = {}) {
  const payload = JSON.parse(fs.readFileSync(job.artifacts.email, 'utf8'))
  if (job.test) payload.subject = `[TEST] ${payload.subject}`
  try {
    const result = await send(payload)
    const manifest = markEmailDelivery(job.artifacts.manifest, { status: 'SENT', messageId: result.messageId, resend, actorId })
    job.emailStatus = 'SENT'; job.sentAt = new Date().toISOString(); job.retryCount = manifest.email.attempts.length
    job.emailAttempts = manifest.email.attempts
  } catch (error) {
    const errorCode = String(error.code || 'PAYROLL_AUDIT_EMAIL_FAILED')
    const manifest = markEmailDelivery(job.artifacts.manifest, { status: 'FAILED', errorCode, resend, actorId })
    job.emailStatus = 'FAILED'; job.retryCount = manifest.email.attempts.length; job.emailAttempts = manifest.email.attempts; job.lastErrorCode = errorCode
  }
  job.updatedAt = new Date().toISOString()
  writePayrollAuditJob(job)
  return job
}

export async function runPayrollAuditJob(input, dependencies = {}) {
  const config = TYPES[input.reportType]
  const jobKey = payrollAuditJobKey(input)
  return withPayrollAuditJobLock(jobKey, async () => {
    let existing = readPayrollAuditJob(jobKey)
    if (existing?.emailStatus === 'SENT') return { job: existing, reused: true }
    if (existing?.artifacts && existing.retryCount < MAX_EMAIL_ATTEMPTS && input.email !== false) return { job: await deliver(existing, { send: dependencies.send }), reused: true }
    if (existing?.retryCount >= MAX_EMAIL_ATTEMPTS) return { job: existing, reused: true }
    const captured = dependencies.snapshot ? await dependencies.snapshot(input.periodStart, input.periodEnd) : await snapshot(input.periodStart, input.periodEnd)
    const subjects = (captured.authority?.employees || []).filter((row) => row.type === config.employmentType).map((row) => row.id)
    const result = await runPayrollAuditFromSnapshot({
      snapshot: captured, periodStart: input.periodStart, periodEnd: input.periodEnd,
      mode: 'FINAL', scope: config.employmentType.toUpperCase(), scopeEmployeeIds: subjects,
      reportType: input.reportType, employeeType: config.employmentType,
      employmentTypeAuthority: 'Employee.employmentType', employmentTypeHistoryAvailable: false,
      outputRoot: path.join(payrollAuditDataRoot(), 'runs'), allowNonProduction: input.allowNonProduction === true,
    })
    const now = new Date().toISOString()
    const job = writePayrollAuditJob({
      jobKey, reportType: input.reportType, employeeType: config.employmentType,
      periodStart: input.periodStart, periodEnd: input.periodEnd, test: input.test === true,
      runId: result.model.runId, canonicalHash: result.model.canonicalHash,
      runStatus: result.model.summary.finalResult, anomalyCount: result.model.summary.issueCount,
      employeeCount: result.model.summary.employeeCount, emailStatus: input.email === false ? 'NOT_SENT' : 'PENDING',
      recipients: [...PAYROLL_AUDIT_RECIPIENTS], retryCount: 0, emailAttempts: [],
      artifacts: { markdown: result.paths.markdown, pdf: result.paths.pdf, email: result.paths.email, manifest: result.paths.manifest },
      employmentTypeLimitation: 'No effective-dated employment type history; current Employee.employmentType is recorded and every subject is REVIEW_REQUIRED.',
      actorId: input.actorId || 'system:scheduler', createdAt: now, updatedAt: now,
    })
    return { job: input.email === false ? job : await deliver(job, { send: dependencies.send }), reused: result.reused }
  })
}

export async function resendPayrollAuditJob(jobKey, actorId, dependencies = {}) {
  return withPayrollAuditJobLock(jobKey, async () => {
    const job = readPayrollAuditJob(jobKey)
    if (!job?.artifacts) throw Object.assign(new Error('Payroll audit job not found'), { code: 'PAYROLL_AUDIT_JOB_NOT_FOUND' })
    return deliver(job, { resend: true, actorId, send: dependencies.send })
  })
}

export async function runDuePayrollAuditJobs(now = new Date(), dependencies = {}) {
  const results = []
  for (const input of recoverablePayrollAuditJobs(now)) results.push(await runPayrollAuditJob({ ...input, email: true }, dependencies))
  for (const job of listPayrollAuditJobs().filter((row) => row.emailStatus === 'FAILED' && row.retryCount < MAX_EMAIL_ATTEMPTS && !row.test)) {
    if (results.some((row) => row.job.jobKey === job.jobKey)) continue
    results.push({ job: await withPayrollAuditJobLock(job.jobKey, () => deliver(job, { send: dependencies.send })), reused: true })
  }
  return results
}
