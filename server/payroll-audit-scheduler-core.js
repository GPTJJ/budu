import { payrollAuditRevision, payrollAuditRevisionFields } from './payroll-audit-revision.js'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PAYROLL_AUDIT_SOURCE, previousMonthPeriod, previousWeekPeriod } from './payroll-audit-report.js'
import { loadReusableAuditRun, markEmailDelivery } from './payroll-audit-run-store.js'
import { PAYROLL_AUDIT_RECIPIENTS, payrollAuditEmailFailureDiagnostic, sendPayrollAuditEmail } from './payroll-audit-email.js'
import { archivePayrollAuditJob, listPayrollAuditJobs, payrollAuditDataRoot, readPayrollAuditJob, withPayrollAuditJobLock, writePayrollAuditJob } from './payroll-audit-job-store.js'
import { runPayrollAuditFromSnapshot } from '../scripts/payroll-audit-runner.mjs'
import { buildNaturalMonthSummary } from './payroll-audit-natural-month.js'
import { runUnifiedSummaryFromSources } from '../scripts/payroll-audit-unified-runner.mjs'

const exec = promisify(execFile)
const TIME_ZONE = 'Asia/Shanghai'
const MAX_EMAIL_ATTEMPTS = 3
export const PAYROLL_AUDIT_AUTOMATION_MODEL = 'GPT-5.6 Sol'
export const PAYROLL_AUDIT_AUTOMATION_REASONING = 'Medium'
const TYPES = Object.freeze({
  WEEKLY_PART_TIME: { employmentType: 'parttime', identity: 'PAYROLL_AUDIT_WEEKLY_PART_TIME' },
  MONTHLY_PART_TIME: { employmentType: 'parttime', identity: 'PAYROLL_AUDIT_MONTHLY_PART_TIME_V1' },
  MONTHLY_FULL_TIME_REVIEWED: { employmentType: 'fulltime', identity: 'PAYROLL_AUDIT_MONTHLY_FULL_TIME_REVIEWED_V1' },
  MONTHLY_NATURAL_SUMMARY: { employmentType: '', identity: 'PAYROLL_AUDIT_MONTHLY_NATURAL_SUMMARY_V1' },
  MONTHLY_FULL_TIME: { employmentType: 'fulltime', identity: 'PAYROLL_AUDIT_MONTHLY_FULL_TIME' },
  MONTHLY_UNIFIED_SUMMARY: { employmentType: '', identity: 'PAYROLL_AUDIT_MONTHLY_UNIFIED_SUMMARY' },
})

export function validatePayrollAuditModelConfiguration(actualModel, actualReasoning) {
  if (actualModel !== PAYROLL_AUDIT_AUTOMATION_MODEL || actualReasoning !== PAYROLL_AUDIT_AUTOMATION_REASONING) {
    throw Object.assign(new Error('Payroll audit automation model configuration mismatch'), {
      code: 'MODEL_CONFIGURATION_MISMATCH',
      expectedModel: PAYROLL_AUDIT_AUTOMATION_MODEL,
      expectedReasoning: PAYROLL_AUDIT_AUTOMATION_REASONING,
    })
  }
}

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
  if (reportType.startsWith('MONTHLY_')) {
    const expectedEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    if (start.getUTCDate() !== 1 || expectedEnd.toISOString().slice(0, 10) !== periodEnd) throw Object.assign(new Error('Monthly audit must be a complete natural month'), { code: 'PAYROLL_AUDIT_PERIOD_INVALID' })
  }
}

export function payrollAuditJobKey({ reportType, periodStart, periodEnd, test = false, revision }) {
  validatePayrollAuditPeriod(reportType, periodStart, periodEnd)
  const version = payrollAuditRevision(revision, reportType)
  const identity = version === 'V1' ? TYPES[reportType].identity : TYPES[reportType].identity.replace(/_V1$/, `_${version}`)
  return `${test ? 'TEST:' : ''}${identity}:${periodStart}:${periodEnd}`
}

async function snapshot(periodStart, periodEnd) {
  const script = path.join(process.cwd(), 'scripts/payroll-audit-extract.mjs')
  const { stdout } = await exec(process.execPath, [script], { env: { ...process.env, AUDIT_PERIOD_START: periodStart, AUDIT_PERIOD_END: periodEnd, AUDIT_DIGEST_ONLY: '0', BUDU_APP_ROOT: process.cwd() }, maxBuffer: 64 * 1024 * 1024, timeout: 60000 })
  return JSON.parse(stdout)
}

async function deliver(job, { resend = false, actorId = '', send = sendPayrollAuditEmail } = {}) {
  if (job.reportType.startsWith('MONTHLY_')) throw Object.assign(new Error('Monthly reports require parent-reviewed Connected App delivery'), { code: 'PAYROLL_PARENT_REVIEW_REQUIRED' })
  const payload = JSON.parse(fs.readFileSync(job.artifacts.email, 'utf8'))
  if (job.test) payload.subject = `[TEST] ${payload.subject}`
  try {
    const result = await send(payload)
    const manifest = markEmailDelivery(job.artifacts.manifest, { status: 'SENT', messageId: result.messageId, resend, actorId })
    job.emailStatus = 'SENT'; job.sentAt = new Date().toISOString(); job.retryCount = manifest.email.attempts.length
    job.emailAttempts = manifest.email.attempts
  } catch (error) {
    const errorCode = String(error.code || 'PAYROLL_AUDIT_EMAIL_FAILED')
    const diagnostic = payrollAuditEmailFailureDiagnostic(error)
    const manifest = markEmailDelivery(job.artifacts.manifest, { status: 'FAILED', errorCode, diagnostic, resend, actorId })
    job.emailStatus = 'FAILED'; job.retryCount = manifest.email.attempts.length; job.emailAttempts = manifest.email.attempts; job.lastErrorCode = errorCode; job.lastEmailDiagnostic = diagnostic
  }
  job.updatedAt = new Date().toISOString()
  writePayrollAuditJob(job)
  return job
}

function existingJobContract(job, input) {
  const manifestPath = job?.artifacts?.manifest
  if (!manifestPath || !fs.existsSync(manifestPath)) return { sendable: false, reason: 'ARTIFACT_MANIFEST_MISSING' }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const modelPath = job.artifacts.model || manifest.artifacts?.model?.path
    if (!modelPath || !fs.existsSync(modelPath)) return { sendable: false, reason: 'CANONICAL_MODEL_MISSING' }
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'))
    if (!loadReusableAuditRun(manifestPath, model.canonicalHash)) return { sendable: false, reason: 'ARTIFACT_INTEGRITY_FAILED' }
    if (Number(model.schemaVersion || 0) < 6) return { sendable: false, reason: 'STALE_SCHEMA' }
    if (model.runId !== job.runId || model.canonicalHash !== job.canonicalHash || model.metadata?.reportType !== job.reportType || model.metadata?.requestedPeriod?.start !== job.periodStart || model.metadata?.requestedPeriod?.end !== job.periodEnd || payrollAuditRevision(model.metadata?.revision, job.reportType) !== payrollAuditRevision(input.revision, job.reportType) || payrollAuditRevision(job.revision, job.reportType) !== payrollAuditRevision(input.revision, job.reportType)) return { sendable: false, reason: 'REPORT_IDENTITY_MISMATCH' }
    if (model.metadata?.source !== PAYROLL_AUDIT_SOURCE) return { sendable: false, reason: 'REPORT_SOURCE_MISSING' }
    if (model.metadata?.actualModel !== input.actualModel || model.metadata?.actualReasoning !== input.actualReasoning) return { sendable: false, reason: 'MODEL_CONFIGURATION_MISMATCH' }
    return { sendable: true, model }
  } catch {
    return { sendable: false, reason: 'ARTIFACT_READ_FAILED' }
  }
}

function loadUnifiedSourceReports(periodStart, periodEnd) {
  const jobs = listPayrollAuditJobs().filter((job) => job.test !== true && job.artifacts?.manifest && fs.existsSync(job.artifacts.manifest))
  const source = (job) => {
    const manifest = JSON.parse(fs.readFileSync(job.artifacts.manifest, 'utf8'))
    const modelPath = job.artifacts.model || manifest.artifacts?.model?.path
    if (!modelPath || !fs.existsSync(modelPath)) return null
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'))
    if (!loadReusableAuditRun(job.artifacts.manifest, model.canonicalHash)) return null
    return { job, model }
  }
  const fullTimeJob = jobs.find((job) => job.reportType === 'MONTHLY_FULL_TIME' && job.periodStart === periodStart && job.periodEnd === periodEnd)
  const partTimeSources = jobs
    .filter((job) => job.reportType === 'WEEKLY_PART_TIME' && job.periodStart <= periodEnd && job.periodEnd >= periodStart)
    .map(source)
    .filter(Boolean)
  return { fullTimeSource: fullTimeJob ? source(fullTimeJob) : null, partTimeSources }
}

export async function runUnifiedMonthlySummaryJob(input, dependencies = {}) {
  if(input.email !== false) throw Object.assign(new Error('Monthly preparation must not send'),{code:'PAYROLL_MONTHLY_PREPARE_ONLY'})
  validatePayrollAuditModelConfiguration(input.actualModel, input.actualReasoning)
  const jobKey = payrollAuditJobKey(input)
  return withPayrollAuditJobLock(jobKey, async () => {
    const existing = readPayrollAuditJob(jobKey)
    if (existing?.emailStatus === 'SENT') return { job: existing, reused: true }
    if (existing?.artifacts && input.email === false) return { job: existing, reused: true }
    if (existing?.artifacts && existing.retryCount < MAX_EMAIL_ATTEMPTS && input.email !== false) return { job: await deliver(existing, { send: dependencies.send }), reused: true }
    if (existing?.retryCount >= MAX_EMAIL_ATTEMPTS) return { job: existing, reused: true }
    const sources = dependencies.loadSources
      ? await dependencies.loadSources(input.periodStart, input.periodEnd)
      : loadUnifiedSourceReports(input.periodStart, input.periodEnd)
    const result = await runUnifiedSummaryFromSources({
      periodStart: input.periodStart, periodEnd: input.periodEnd,
      actualModel: input.actualModel, actualReasoning: input.actualReasoning,
      generatedAt: input.generatedAt,
      fullTimeSource: sources.fullTimeSource, partTimeSources: sources.partTimeSources,
      outputRoot: path.join(payrollAuditDataRoot(), 'runs'),
    })
    const now = new Date().toISOString()
    const job = writePayrollAuditJob({
      jobKey, reportType: 'MONTHLY_UNIFIED_SUMMARY', employeeType: 'fulltime+parttime',
      periodStart: input.periodStart, periodEnd: input.periodEnd, test: input.test === true,
      runId: result.model.runId, canonicalHash: result.model.canonicalHash,
      runStatus: result.model.summary.finalResult, anomalyCount: result.model.summary.issueCount,
      employeeCount: result.model.summary.employeeCount, emailStatus: input.email === false ? 'NOT_SENT' : 'PENDING',
      recipients: [...PAYROLL_AUDIT_RECIPIENTS], retryCount: 0, emailAttempts: [],
      sourceReferences: result.model.sourceReferences,
      executionEvidence: result.model.executionEvidence,
      artifacts: { model: result.paths.model, markdown: result.paths.markdown, pdf: result.paths.pdf, email: result.paths.email, manifest: result.paths.manifest },
      reviewContext: input.reviewContext,
      actorId: input.actorId || 'system:scheduler', createdAt: now, updatedAt: now,
    })
    return { job: input.email === false ? job : await deliver(job, { send: dependencies.send }), reused: result.reused }
  })
}

export async function runPayrollAuditJob(input, dependencies = {}) {
  if (input.reportType.startsWith('MONTHLY_') && input.email !== false) throw Object.assign(new Error('Monthly preparation must not send'), { code: 'PAYROLL_MONTHLY_PREPARE_ONLY' })
  if (input.reportType === 'MONTHLY_NATURAL_SUMMARY') return runNaturalMonthSummaryJob(input, dependencies)
  if (input.reportType === 'MONTHLY_UNIFIED_SUMMARY') return runUnifiedMonthlySummaryJob(input, dependencies)
  validatePayrollAuditModelConfiguration(input.actualModel, input.actualReasoning)
  const config = TYPES[input.reportType]
  const jobKey = payrollAuditJobKey(input)
  return withPayrollAuditJobLock(jobKey, async () => {
    let existing = readPayrollAuditJob(jobKey)
    if (existing?.emailStatus === 'SENT') return { job: existing, reused: true }
    if (existing?.artifacts) {
      const contract = existingJobContract(existing, input)
      if (!contract.sendable && ['MONTHLY_FULL_TIME_REVIEWED','MONTHLY_PART_TIME'].includes(input.reportType)) throw Object.assign(new Error('Existing natural-month source requires explicit reconciliation'),{code:'NATURAL_MONTH_EXISTING_ARTIFACT_INVALID'})
      if (!contract.sendable) {
        const archived = archivePayrollAuditJob(existing, `${contract.reason}/NON_CANONICAL/NOT_SENDABLE`)
        existing = null
        dependencies.onArchivedStaleJob?.(archived)
      }
    }
    if(existing?.artifacts && ['MONTHLY_FULL_TIME_REVIEWED','MONTHLY_PART_TIME'].includes(input.reportType) && input.email === false) return {job:existing,reused:true}
    if (existing?.artifacts && existing.retryCount < MAX_EMAIL_ATTEMPTS && input.email !== false) return { job: await deliver(existing, { send: dependencies.send }), reused: true }
    if (existing?.retryCount >= MAX_EMAIL_ATTEMPTS) return { job: existing, reused: true }
    const captured = dependencies.snapshot ? await dependencies.snapshot(input.periodStart, input.periodEnd) : await snapshot(input.periodStart, input.periodEnd)
    const subjects = (captured.authority?.employees || []).filter((row) => row.type === config.employmentType).map((row) => row.id)
    const result = await runPayrollAuditFromSnapshot({
      snapshot: captured, periodStart: input.periodStart, periodEnd: input.periodEnd,
      mode: 'FINAL', scope: config.employmentType.toUpperCase(), scopeEmployeeIds: subjects,
      reportType: input.reportType, ...payrollAuditRevisionFields(input.revision, input.reportType), employeeType: config.employmentType,
      employmentTypeAuthority: 'Employee.employmentType', employmentTypeHistoryAvailable: false,
      actualModel: input.actualModel, actualReasoning: input.actualReasoning,
      outputRoot: path.join(payrollAuditDataRoot(), 'runs'), allowNonProduction: input.allowNonProduction === true,
    })
    const now = new Date().toISOString()
    const job = writePayrollAuditJob({
      jobKey, reportType: input.reportType, ...payrollAuditRevisionFields(input.revision, input.reportType), employeeType: config.employmentType,
      periodStart: input.periodStart, periodEnd: input.periodEnd, test: input.test === true,
      runId: result.model.runId, canonicalHash: result.model.canonicalHash,
      runStatus: result.model.summary.finalResult, anomalyCount: result.model.summary.anomalyCount,
      employeeCount: result.model.summary.employeeCount, emailStatus: input.email === false ? 'NOT_SENT' : 'PENDING',
      recipients: [...PAYROLL_AUDIT_RECIPIENTS], retryCount: 0, emailAttempts: [],
      artifacts: { model: result.paths.model, markdown: result.paths.markdown, pdf: result.paths.pdf, email: result.paths.email, manifest: result.paths.manifest },
      employmentTypeLimitation: 'No effective-dated employment type history; current Employee.employmentType is recorded. This warning alone does not block verified current-period payroll.',
      reviewContext: input.reviewContext,
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
  validatePayrollAuditModelConfiguration(dependencies.actualModel, dependencies.actualReasoning)
  const results = []
  for (const input of recoverablePayrollAuditJobs(now)) {
    if(input.reportType.startsWith('MONTHLY_')) { results.push({skipped:true,reportType:input.reportType,periodStart:input.periodStart,periodEnd:input.periodEnd,reason:'MONTHLY_PARENT_PREPARATION_ONLY'});continue }
    results.push(await runPayrollAuditJob({
    ...input, email: true,
    actualModel: dependencies.actualModel,
    actualReasoning: dependencies.actualReasoning,
  }, dependencies))
  }
  for (const job of listPayrollAuditJobs().filter((row) => row.emailStatus === 'FAILED' && row.retryCount < MAX_EMAIL_ATTEMPTS && !row.test && !String(row.reportType).startsWith('MONTHLY_'))) {
    if (results.some((row) => row.job?.jobKey === job.jobKey)) continue
    results.push({ job: await withPayrollAuditJobLock(job.jobKey, () => deliver(job, { send: dependencies.send })), reused: true })
  }
  return results
}

export async function runNaturalMonthSummaryJob(input, dependencies = {}) {
  validatePayrollAuditModelConfiguration(input.actualModel, input.actualReasoning)
  if (input.email !== false) throw Object.assign(new Error('Monthly preparation must not send'), { code:'PAYROLL_MONTHLY_PREPARE_ONLY' })
  const jobKey=payrollAuditJobKey(input)
  return withPayrollAuditJobLock(jobKey,async()=>{
    const existing=readPayrollAuditJob(jobKey)
    if(existing?.artifacts) {
      const contract=existingJobContract(existing,input)
      if(!contract.sendable) throw Object.assign(new Error('Existing monthly artifact requires explicit reconciliation'),{code:'NATURAL_MONTH_EXISTING_ARTIFACT_INVALID'})
    }
    const load=type=>{
      const job=readPayrollAuditJob(payrollAuditJobKey({...input,reportType:type}))
      if(!job) return null
      const contract=existingJobContract(job,input)
      if(!contract.sendable) throw Object.assign(new Error('Monthly source not reusable'),{code:'NATURAL_MONTH_SOURCE_ARTIFACT_INVALID'})
      return {job,model:contract.model}
    }
    const sources=dependencies.loadSources ? await dependencies.loadSources(input.periodStart,input.periodEnd) : {fullTimeSource:load('MONTHLY_FULL_TIME_REVIEWED'),partTimeMonthlySource:load('MONTHLY_PART_TIME')}
    if(existing?.artifacts) {
      const expected = buildNaturalMonthSummary({...input,...sources})
      if(expected.canonicalHash !== existing.canonicalHash) throw Object.assign(new Error('Existing summary differs from revision sources'), {code:'NATURAL_MONTH_SNAPSHOT_MISMATCH'})
      return {job:existing,reused:true}
    }
    const result=await runUnifiedSummaryFromSources({...input,...sources,naturalMonth:true,outputRoot:path.join(payrollAuditDataRoot(),'runs')})
    const now=new Date().toISOString()
    const job=writePayrollAuditJob({jobKey,reportType:input.reportType,...payrollAuditRevisionFields(input.revision,input.reportType),employeeType:'fulltime+parttime',periodStart:input.periodStart,periodEnd:input.periodEnd,test:input.test===true,runId:result.model.runId,canonicalHash:result.model.canonicalHash,runStatus:result.model.summary.finalResult,anomalyCount:result.model.summary.anomalyCount,employeeCount:result.model.summary.employeeCount,emailStatus:'NOT_SENT',recipients:[...PAYROLL_AUDIT_RECIPIENTS],retryCount:0,emailAttempts:[],sourceReferences:result.model.sourceReferences,artifacts:{model:result.paths.model,markdown:result.paths.markdown,pdf:result.paths.pdf,email:result.paths.email,manifest:result.paths.manifest},reviewContext:input.reviewContext,actorId:input.actorId||'system:scheduler',createdAt:now,updatedAt:now})
    return {job,reused:result.reused}
  })
}

export async function prepareNaturalMonthReports(input,dependencies={}) {
  if(!input.preparationThreadId || !input.parentReviewThreadId || input.preparationThreadId === input.parentReviewThreadId) throw Object.assign(new Error('Distinct preparation and parent review threads required'),{code:'PAYROLL_PARENT_REVIEW_CONTEXT_REQUIRED'})
  payrollAuditJobKey({...input,reportType:'MONTHLY_NATURAL_SUMMARY'})
  validatePayrollAuditModelConfiguration(input.actualModel,input.actualReasoning)
  input={...input,reviewContext:{preparationThreadId:input.preparationThreadId,parentReviewThreadId:input.parentReviewThreadId}}
  const captured=dependencies.snapshot ? await dependencies.snapshot(input.periodStart,input.periodEnd) : await snapshot(input.periodStart,input.periodEnd)
  const sourceDependencies={...dependencies,snapshot:async()=>captured}
  const results=[]
  for(const reportType of ['MONTHLY_FULL_TIME_REVIEWED','MONTHLY_PART_TIME']) results.push(await runPayrollAuditJob({...input,reportType,email:false},sourceDependencies))
  for(const result of results) {
    const contract=existingJobContract(result.job,input)
    if(!contract.sendable || contract.model.metadata.authorityDigest !== captured.authorityDigest || contract.model.metadata.productionSha !== captured.productionSha) throw Object.assign(new Error('Existing monthly source snapshot differs; preserve and reconcile explicitly'),{code:'NATURAL_MONTH_SOURCE_SNAPSHOT_STALE'})
  }
  results.push(await runPayrollAuditJob({...input,reportType:'MONTHLY_NATURAL_SUMMARY',email:false},dependencies))
  return {results,deliveryJobKeys:[results[0].job.jobKey,results[2].job.jobKey]}
}
