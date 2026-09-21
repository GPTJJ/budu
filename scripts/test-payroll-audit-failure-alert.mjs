import assert from 'node:assert/strict'
import test from 'node:test'

import { deliverPayrollAuditFailureAlert, payrollAuditFailureAlertCopy } from '../server/payroll-audit-failure-alert.js'

function duplicateError() { const error = new Error('duplicate'); error.code = 'P2002'; return error }
function fakePrisma() {
  const notifications = new Map(); const deliveries = new Map()
  return {
    notifications, deliveries,
    notification: {
      create: async ({ data }) => { if (notifications.has(data.id)) throw duplicateError(); notifications.set(data.id, { ...data }); return notifications.get(data.id) },
      findUnique: async ({ where }) => notifications.get(where.id) || null,
    },
    notificationDelivery: {
      create: async ({ data }) => { if (deliveries.has(data.id)) throw duplicateError(); deliveries.set(data.id, { ...data }); return deliveries.get(data.id) },
      update: async ({ where, data }) => { const row = deliveries.get(where.id); deliveries.set(where.id, { ...row, ...data }); return deliveries.get(where.id) },
    },
  }
}

const failure = {
  reportType: 'WEEKLY_PART_TIME', periodStart: '2026-09-14', periodEnd: '2026-09-20',
  reportId: 'report-1', stage: 'CONNECTED_APP_SEND', safeErrorCode: 'CONNECTED_APP_UNAVAILABLE', formalStatus: 'NOT_SENT',
}

test('payroll failure alert uses the existing developer WeCom channel and is idempotent', async () => {
  const prismaClient = fakePrisma(); const sent = []
  const dependencies = {
    prismaClient,
    recipientBinding: { username: 'budu', userId: 'dh' },
    personalConfig: { channel: 'wecom', corpId: 'corp', agentId: '1', secret: 'secret' },
    sendPersonal: async (_config, binding, message) => { sent.push({ binding, message }); return { ok: true } },
  }
  const first = await deliverPayrollAuditFailureAlert({ ...failure, ...dependencies })
  const duplicate = await deliverPayrollAuditFailureAlert({ ...failure, ...dependencies })
  assert.equal(first.status, 'sent'); assert.equal(first.recipientCount, 1)
  assert.equal(duplicate.status, 'duplicate'); assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].binding, { openId: 'dh' })
  assert.match(sent[0].message.title, /薪酬审查邮件发送失败/)
  assert.match(sent[0].message.content, /兼职周报/)
  assert.match(sent[0].message.content, /CONNECTED_APP_UNAVAILABLE/)
  assert.equal(prismaClient.notifications.size, 1); assert.equal(prismaClient.deliveries.size, 1)
})

test('failure alert records an unavailable channel without exposing configuration', async () => {
  const prismaClient = fakePrisma()
  const result = await deliverPayrollAuditFailureAlert({ ...failure, prismaClient, recipientBinding: null, personalConfig: null })
  assert.equal(result.status, 'skipped'); assert.equal(result.safeErrorCode, 'DEVELOPER_WECOM_UNAVAILABLE')
  assert.equal([...prismaClient.deliveries.values()][0].status, 'skipped')
  assert.doesNotMatch(JSON.stringify(result), /secret|token|corp/i)
})

test('failure copy rejects unknown report identities and contains only safe fields', () => {
  assert.throws(() => payrollAuditFailureAlertCopy({ ...failure, reportType: 'UNKNOWN' }), /Invalid payroll/)
  const copy = payrollAuditFailureAlertCopy({ ...failure, safeErrorCode: 'bad code with spaces' })
  assert.match(copy.content, /BAD_CODE_WITH_SPACES/)
})
