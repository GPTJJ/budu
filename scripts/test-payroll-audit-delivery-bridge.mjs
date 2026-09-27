import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { preparePayrollConnectedDelivery, claimPayrollConnectedDelivery, completePayrollConnectedDelivery } from '../server/payroll-audit-delivery-bridge.js'
import { runPayrollAuditJob } from '../server/payroll-audit-scheduler-core.js'

const metadata = { actualModel: 'GPT-5.6 Sol', actualReasoning: 'Medium' }
function snapshot() {
  const period = { periodStart: '2026-09-14', periodEnd: '2026-09-20' }
  return { generatedAt: '2026-09-21T01:00:00.000Z', productionSha: 'test-sha', database: 'budu_test', authorityDigest: 'digest', digests: {}, schedules: [], attendanceRows: [], cardAmountCentsById: { part: '0' }, authority: { period, employees: [{ id: 'part', name: '兼职', status: 'ACTIVE', type: 'parttime' }], storeNames: {}, result: { calculationReady: true, payroll: { employees: [{ employeeId: 'part', displayName: '兼职', payableHours: 0, salary: 0, dailyExplanations: [] }] }, readiness: { employees: [{ employeeId: 'part', blockers: [] }] }, blockers: [] } } }
}

test('TEST connected delivery is independently idempotent and never consumes formal SENT state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-connected-delivery-'))
  const previous = process.env.PAYROLL_AUDIT_DATA_DIR; process.env.PAYROLL_AUDIT_DATA_DIR = root
  try {
    const generated = await runPayrollAuditJob({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', email: false, allowNonProduction: true, ...metadata }, { snapshot: async () => snapshot() })
    const input = { jobKey: generated.job.jobKey, mode: 'TEST', recipients: ['yuegu1995@gmail.com'], expectedModel: metadata.actualModel, expectedReasoning: metadata.actualReasoning }
    const prepared = await preparePayrollConnectedDelivery(input)
    assert.equal(prepared.status, 'DELIVERY_PENDING'); assert.equal(prepared.formalEmailStatus, 'NOT_SENT')
    const claimed = await claimPayrollConnectedDelivery({ jobKey: input.jobKey, deliveryId: prepared.deliveryId, actorId: 'test' })
    assert.equal(claimed.status, 'SENDING'); assert.equal(claimed.attemptNumber, 1)
    const sent = await completePayrollConnectedDelivery({ jobKey: input.jobKey, deliveryId: prepared.deliveryId, status: 'SENT', messageId: 'safe-test-message', actorId: 'test' })
    assert.equal(sent.status, 'SENT'); assert.equal(sent.formalEmailStatus, 'NOT_SENT')
    const duplicate = await claimPayrollConnectedDelivery({ jobKey: input.jobKey, deliveryId: prepared.deliveryId, actorId: 'test' })
    assert.equal(duplicate.alreadySent, true); assert.equal(duplicate.attemptNumber, 1)
    const job = JSON.parse(fs.readFileSync(path.join(root, 'jobs', fs.readdirSync(path.join(root, 'jobs')).find((name) => name.endsWith('.json'))), 'utf8'))
    assert.equal(job.emailStatus, 'NOT_SENT'); assert.equal(job.emailAttempts.length, 0)
  } finally {
    if (previous === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a failed TEST delivery can be retried without changing formal delivery state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-connected-delivery-retry-'))
  const previous = process.env.PAYROLL_AUDIT_DATA_DIR; process.env.PAYROLL_AUDIT_DATA_DIR = root
  try {
    const generated = await runPayrollAuditJob({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', email: false, allowNonProduction: true, ...metadata }, { snapshot: async () => snapshot() })
    const prepared = await preparePayrollConnectedDelivery({ jobKey: generated.job.jobKey, mode: 'TEST', recipients: ['yuegu1995@gmail.com'], expectedModel: metadata.actualModel, expectedReasoning: metadata.actualReasoning })
    await claimPayrollConnectedDelivery({ jobKey: generated.job.jobKey, deliveryId: prepared.deliveryId, actorId: 'test' })
    const failed = await completePayrollConnectedDelivery({ jobKey: generated.job.jobKey, deliveryId: prepared.deliveryId, status: 'FAILED', safeErrorCode: 'CONNECTED_APP_TEMPORARY_FAILURE', actorId: 'test' })
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.attemptNumber, 1); assert.equal(failed.formalEmailStatus, 'NOT_SENT')
    const retried = await claimPayrollConnectedDelivery({ jobKey: generated.job.jobKey, deliveryId: prepared.deliveryId, actorId: 'test' })
    assert.equal(retried.status, 'SENDING'); assert.equal(retried.attemptNumber, 2); assert.equal(retried.formalEmailStatus, 'NOT_SENT')
  } finally {
    if (previous === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('recipient and model locks fail before a delivery identity is created', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-connected-delivery-lock-'))
  const previous = process.env.PAYROLL_AUDIT_DATA_DIR; process.env.PAYROLL_AUDIT_DATA_DIR = root
  try {
    const generated = await runPayrollAuditJob({ reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20', email: false, allowNonProduction: true, ...metadata }, { snapshot: async () => snapshot() })
    await assert.rejects(preparePayrollConnectedDelivery({ jobKey: generated.job.jobKey, mode: 'TEST', recipients: ['970701330@qq.com'], expectedModel: metadata.actualModel, expectedReasoning: metadata.actualReasoning }), (error) => error.code === 'PAYROLL_DELIVERY_RECIPIENTS_MISMATCH')
    await assert.rejects(preparePayrollConnectedDelivery({ jobKey: generated.job.jobKey, mode: 'TEST', recipients: ['yuegu1995@gmail.com'], expectedModel: 'GPT-6 Astra', expectedReasoning: 'High' }), (error) => error.code === 'MODEL_CONFIGURATION_MISMATCH')
  } finally {
    if (previous === undefined) delete process.env.PAYROLL_AUDIT_DATA_DIR; else process.env.PAYROLL_AUDIT_DATA_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
