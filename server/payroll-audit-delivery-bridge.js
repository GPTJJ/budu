import crypto from 'node:crypto'
import fs from 'node:fs'

import { PAYROLL_AUDIT_RECIPIENTS } from './payroll-audit-email.js'
import { readPayrollAuditJob, withPayrollAuditJobLock, writePayrollAuditJob } from './payroll-audit-job-store.js'
import { PAYROLL_AUDIT_SOURCE } from './payroll-audit-report.js'
import { loadReusableAuditRun } from './payroll-audit-run-store.js'

const TEST_RECIPIENTS = Object.freeze(['yuegu1995@gmail.com'])
const clean = (value) => String(value || '').trim()
const sameSet = (left, right) => [...left].sort().join('\n') === [...right].sort().join('\n')
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, filePath)
}

function loadAuthority(jobKey) {
  const job = readPayrollAuditJob(jobKey)
  if (!job?.artifacts?.manifest) throw Object.assign(new Error('Payroll audit job is missing'), { code: 'PAYROLL_DELIVERY_JOB_MISSING' })
  const manifest = JSON.parse(fs.readFileSync(job.artifacts.manifest, 'utf8'))
  const modelPath = job.artifacts.model || manifest.artifacts?.model?.path
  if (!modelPath || !fs.existsSync(modelPath)) throw Object.assign(new Error('Canonical report model is missing'), { code: 'PAYROLL_DELIVERY_MODEL_MISSING' })
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'))
  if (!loadReusableAuditRun(job.artifacts.manifest, model.canonicalHash)) throw Object.assign(new Error('Canonical report artifact integrity failed'), { code: 'PAYROLL_DELIVERY_ARTIFACT_INVALID' })
  return { job, manifest, model, modelPath }
}

function publicRecord(record) {
  return {
    deliveryId: record.deliveryId,
    reportId: record.reportId,
    mode: record.mode,
    recipients: record.recipients,
    status: record.status,
    attemptNumber: record.attemptNumber,
    provider: record.provider,
    artifact: record.artifact,
    messageId: record.messageId || '',
    sentAt: record.sentAt || '',
    safeErrorCode: record.safeErrorCode || '',
    canonicalHash:record.canonicalHash,
    parentReview:record.parentReview||null,
  }
}

// Thread identifiers are orchestration labels, not authenticated principals.
// Only the parent orchestrator holds/uses the Gmail sending capability.
const monthly = job => job.reportType.startsWith('MONTHLY_')
const reviewBinding = (job, model, manifest, record) => ({reportId:model.runId,canonicalHash:model.canonicalHash,pdfHash:manifest.artifacts.pdf.sha256,periodStart:job.periodStart,periodEnd:job.periodEnd,recipients:[...record.recipients].sort()})
function requireParentReview(job, model, manifest, record) {
  if(!monthly(job)) return
  if(record.mode !== 'FORMAL' || !sameSet(record.recipients,PAYROLL_AUDIT_RECIPIENTS) || record.reportId!==model.runId || record.canonicalHash!==model.canonicalHash || record.artifact.sha256!==manifest.artifacts.pdf.sha256) throw Object.assign(new Error('Monthly delivery identity or artifact changed'),{code:'PAYROLL_PARENT_REVIEW_REQUIRED'})
  const binding=reviewBinding(job,model,manifest,record)
  if(!record.parentReview || record.parentReview.bindingHash !== hash(binding)) throw Object.assign(new Error('Exact monthly artifact has not been parent reviewed'),{code:'PAYROLL_PARENT_REVIEW_REQUIRED'})
}

export async function reviewPayrollConnectedDelivery(input) {
  return withPayrollAuditJobLock(input.jobKey,async()=>{
    const {job,manifest,model}=loadAuthority(input.jobKey)
    const record=manifest.deliveryBridge?.deliveries?.[input.deliveryId]
    if(!record || record.mode!=='FORMAL' || !monthly(job)) throw Object.assign(new Error('Monthly formal delivery required'),{code:'PAYROLL_PARENT_REVIEW_IDENTITY_INVALID'})
    if(['SENDING','SENT'].includes(record.status)) throw Object.assign(new Error('Delivery already active'),{code:'PAYROLL_PARENT_REVIEW_ALREADY_ACTIVE'})
    if(!job.reviewContext || input.reviewerThreadId!==job.reviewContext.parentReviewThreadId || input.preparationThreadId!==job.reviewContext.preparationThreadId || input.reviewerThreadId===input.preparationThreadId) throw Object.assign(new Error('Independent parent review thread required'),{code:'PAYROLL_PARENT_REVIEW_NOT_INDEPENDENT'})
    if(!sameSet(record.recipients,PAYROLL_AUDIT_RECIPIENTS)) throw Object.assign(new Error('Formal recipients changed'),{code:'PAYROLL_DELIVERY_RECIPIENTS_MISMATCH'})
    const binding=reviewBinding(job,model,manifest,record)
    const supplied={reportId:input.reportId,canonicalHash:input.canonicalHash,pdfHash:input.pdfHash,periodStart:input.periodStart,periodEnd:input.periodEnd,recipients:[...new Set(input.recipients||[])].sort()}
    if(hash(binding)!==hash(supplied)) throw Object.assign(new Error('Reviewed artifact binding differs'),{code:'PAYROLL_PARENT_REVIEW_BINDING_MISMATCH'})
    if(input.decision!=='APPROVED' || !clean(input.evidence)) throw Object.assign(new Error('Explicit reviewed-content decision required'),{code:'PAYROLL_PARENT_REVIEW_DECISION_REQUIRED'})
    record.parentReview={...binding,bindingHash:hash(binding),reviewerThreadId:clean(input.reviewerThreadId),preparationThreadId:clean(input.preparationThreadId),evidence:clean(input.evidence),reviewedAt:new Date().toISOString(),decision:'APPROVED'}
    writeJsonAtomic(job.artifacts.manifest,manifest)
    return {...publicRecord(record),parentReview:record.parentReview}
  })
}

export async function preparePayrollConnectedDelivery(input) {
  return withPayrollAuditJobLock(input.jobKey, async () => {
    const { job, manifest, model } = loadAuthority(input.jobKey)
    const mode = clean(input.mode).toUpperCase()
    if(job.reportType==='MONTHLY_PART_TIME') throw Object.assign(new Error('Part-time monthly source is not a delivery report'),{code:'PAYROLL_SOURCE_NOT_DELIVERABLE'})
    const recipients = [...new Set((input.recipients || []).map((value) => clean(value).toLowerCase()).filter(Boolean))]
    if(monthly(job) && mode !== 'FORMAL') throw Object.assign(new Error('Monthly reports only allow parent-reviewed formal delivery'),{code:'PAYROLL_MONTHLY_FORMAL_ONLY'})
    if (!['TEST', 'FORMAL'].includes(mode)) throw Object.assign(new Error('Invalid delivery mode'), { code: 'PAYROLL_DELIVERY_MODE_INVALID' })
    const expectedRecipients = mode === 'TEST' ? TEST_RECIPIENTS : PAYROLL_AUDIT_RECIPIENTS
    if (!sameSet(recipients, expectedRecipients)) throw Object.assign(new Error('Delivery recipients do not match the locked recipient set'), { code: 'PAYROLL_DELIVERY_RECIPIENTS_MISMATCH' })
    if (model.metadata?.actualModel !== input.expectedModel || model.metadata?.actualReasoning !== input.expectedReasoning) throw Object.assign(new Error('Canonical report model contract mismatch'), { code: 'MODEL_CONFIGURATION_MISMATCH' })
    if (Number(model.schemaVersion || 0) < 6 || model.metadata?.source !== PAYROLL_AUDIT_SOURCE) throw Object.assign(new Error('Canonical report source contract mismatch'), { code: 'PAYROLL_DELIVERY_SOURCE_MISMATCH' })
    if (model.runId !== job.runId || model.metadata?.requestedPeriod?.start !== job.periodStart || model.metadata?.requestedPeriod?.end !== job.periodEnd || model.metadata?.employeeType !== job.employeeType) throw Object.assign(new Error('Canonical report identity mismatch'), { code: 'PAYROLL_DELIVERY_REPORT_IDENTITY_MISMATCH' })
    const deliveryId = hash({ reportId: model.runId, canonicalHash: model.canonicalHash, recipients: [...recipients].sort(), mode }).slice(0, 24)
    manifest.deliveryBridge ||= { schemaVersion: 1, deliveries: {} }
    let record = manifest.deliveryBridge.deliveries[deliveryId]
    if (!record) {
      const now = new Date().toISOString()
      record = {
        deliveryId, reportId: model.runId, canonicalHash: model.canonicalHash, mode, recipients,
        provider: 'GMAIL_CONNECTED_APP', status: 'DELIVERY_PENDING', attemptNumber: 0,
        artifact: { path: manifest.artifacts.pdf.path, sha256: manifest.artifacts.pdf.sha256 },
        createdAt: now, updatedAt: now,
        history: [{ status: 'GENERATED', at: now }, { status: 'DELIVERY_PENDING', at: now }],
      }
      manifest.deliveryBridge.deliveries[deliveryId] = record
      writeJsonAtomic(job.artifacts.manifest, manifest)
    }
    return { ...publicRecord(record), reviewContext:job.reviewContext||null, formalEmailStatus: job.emailStatus }
  })
}

export async function claimPayrollConnectedDelivery(input) {
  return withPayrollAuditJobLock(input.jobKey, async () => {
    const { job, manifest, model } = loadAuthority(input.jobKey)
    const record = manifest.deliveryBridge?.deliveries?.[input.deliveryId]
    if (!record) throw Object.assign(new Error('Delivery identity is missing'), { code: 'PAYROLL_DELIVERY_ID_MISSING' })
    if (record.status === 'SENT') return { ...publicRecord(record), alreadySent: true, formalEmailStatus: job.emailStatus }
    requireParentReview(job,model,manifest,record)
    if (record.status === 'SENDING') throw Object.assign(new Error('Delivery is already claimed'), { code: 'PAYROLL_DELIVERY_ALREADY_SENDING' })
    record.status = 'SENDING'; record.attemptNumber += 1; record.updatedAt = new Date().toISOString()
    record.history.push({ status: 'SENDING', at: record.updatedAt, attemptNumber: record.attemptNumber, actorId: clean(input.actorId) })
    writeJsonAtomic(job.artifacts.manifest, manifest)
    return { ...publicRecord(record), alreadySent: false, formalEmailStatus: job.emailStatus }
  })
}

export async function completePayrollConnectedDelivery(input) {
  return withPayrollAuditJobLock(input.jobKey, async () => {
    const { job, manifest, model } = loadAuthority(input.jobKey)
    const record = manifest.deliveryBridge?.deliveries?.[input.deliveryId]
    if (!record) throw Object.assign(new Error('Delivery identity is missing'), { code: 'PAYROLL_DELIVERY_ID_MISSING' })
    if (record.status === 'SENT') return { ...publicRecord(record), alreadySent: true, formalEmailStatus: job.emailStatus }
    if (record.status !== 'SENDING') throw Object.assign(new Error('Delivery must be claimed before completion'), { code: 'PAYROLL_DELIVERY_NOT_CLAIMED' })
    const status = clean(input.status).toUpperCase()
    if (!['SENT', 'FAILED'].includes(status)) throw Object.assign(new Error('Invalid completion status'), { code: 'PAYROLL_DELIVERY_STATUS_INVALID' })
    if(status==='SENT') requireParentReview(job,model,manifest,record)
    const now = new Date().toISOString()
    record.status = status; record.updatedAt = now
    if (status === 'SENT') {
      const messageId = clean(input.messageId)
      if (!/^[A-Za-z0-9._-]{4,200}$/.test(messageId)) throw Object.assign(new Error('Safe Gmail message id is required'), { code: 'PAYROLL_DELIVERY_MESSAGE_ID_INVALID' })
      record.messageId = messageId; record.sentAt = now; record.recipientCount = record.recipients.length
      record.history.push({ status: 'SENT', at: now, attemptNumber: record.attemptNumber, provider: record.provider, messageId })
      if (record.mode === 'FORMAL') {
        manifest.email.status = 'SENT'; manifest.email.messageId = messageId
        manifest.email.attempts.push({ at: now, status: 'SENT', messageId, errorCode: '', diagnostic: null, resend: false, actorId: clean(input.actorId), provider: record.provider })
        job.emailStatus = 'SENT'; job.sentAt = now; job.retryCount = manifest.email.attempts.length; job.emailAttempts = manifest.email.attempts; job.updatedAt = now
        writePayrollAuditJob(job)
      }
    } else {
      record.safeErrorCode = clean(input.safeErrorCode || 'PAYROLL_CONNECTED_APP_DELIVERY_FAILED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 100)
      record.history.push({ status: 'FAILED', at: now, attemptNumber: record.attemptNumber, provider: record.provider, safeErrorCode: record.safeErrorCode })
    }
    writeJsonAtomic(job.artifacts.manifest, manifest)
    return { ...publicRecord(record), alreadySent: false, formalEmailStatus: job.emailStatus }
  })
}

// Read-only exact attachment snapshot. Caller receives bytes, not a mutable path.
export function readPayrollDeliveryPdf(input) {
  const {job,manifest,model}=loadAuthority(input.jobKey)
  if(input.reportId!==model.runId || input.canonicalHash!==model.canonicalHash || input.pdfHash!==manifest.artifacts.pdf.sha256 || input.periodStart!==job.periodStart || input.periodEnd!==job.periodEnd) throw Object.assign(new Error('Attachment identity mismatch'),{code:'PAYROLL_ATTACHMENT_IDENTITY_MISMATCH'})
  const bytes=fs.readFileSync(manifest.artifacts.pdf.path)
  const pdfHash=crypto.createHash('sha256').update(bytes).digest('hex')
  if(pdfHash!==input.pdfHash) throw Object.assign(new Error('Attachment changed during read'),{code:'PAYROLL_ATTACHMENT_BYTES_CHANGED'})
  return {bytes,pdfHash,reportId:model.runId,canonicalHash:model.canonicalHash,periodStart:job.periodStart,periodEnd:job.periodEnd}
}
