import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.PUBLIC_BASE_URL = 'https://budu.example'

const {
  PARTNER_REVIEW_REQUIRED_EVENT,
  deliverPartnerReplenishmentReviewRequired,
  partnerReviewRequiredCopy,
} = await import('../server/partner-replenishment-notification.js')

const submittedOrder = (overrides = {}) => ({
  id: 'rpl-submitted-1',
  orderNo: 'RPL-20260921-1',
  status: 'SUBMITTED',
  partnerNameSnapshot: '森醒',
  partnerStoreNameSnapshot: '北京门店',
  requestedTotalAmountCents: 40000n,
  submittedAt: new Date('2026-09-21T01:00:00.000Z'),
  items: [
    { requestedQuantityBase: 100, approvedQuantityBase: null },
    { requestedQuantityBase: 25, approvedQuantityBase: null },
  ],
  ...overrides,
})

function fakePrisma() {
  const notifications = new Map()
  const deliveries = new Map()
  return {
    notifications,
    deliveries,
    notification: {
      async create({ data }) {
        if (notifications.has(data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        notifications.set(data.id, { ...data })
        return notifications.get(data.id)
      },
      async findUnique({ where }) {
        return notifications.get(where.id) || null
      },
    },
    notificationDelivery: {
      async create({ data }) {
        if (deliveries.has(data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        deliveries.set(data.id, { ...data })
        return deliveries.get(data.id)
      },
      async update({ where, data }) {
        deliveries.set(where.id, { ...deliveries.get(where.id), ...data })
        return deliveries.get(where.id)
      },
    },
  }
}

const binding = { username: 'budu', userId: 'dh' }
const config = { channel: 'wecom', corpId: 'ww-test', agentId: '1', secret: 'test' }

test('SUBMITTED copy is review-only and uses requested facts', () => {
  const copy = partnerReviewRequiredCopy(submittedOrder())
  assert.equal(copy.title, '【Partner 补货待审核】')
  assert.match(copy.content, /合作商：森醒/)
  assert.match(copy.content, /补货单号：RPL-20260921-1/)
  assert.match(copy.content, /商品：2 项/)
  assert.match(copy.content, /申请金额：¥400\.00/)
  assert.match(copy.content, /状态：待审核/)
  assert.doesNotMatch(copy.content, /待发货|批准|备货/)
})

test('SUBMITTED sends one developer WeCom message and never invokes a group sender', async () => {
  const prismaClient = fakePrisma()
  const sends = []
  const result = await deliverPartnerReplenishmentReviewRequired({
    prismaClient,
    order: submittedOrder(),
    recipientBinding: binding,
    personalConfig: config,
    sendPersonal: async (_cfg, recipient, message) => {
      sends.push({ recipient, message })
      return { ok: true, errcode: 0, errmsg: 'ok' }
    },
  })
  assert.equal(result.status, 'sent')
  assert.equal(result.event, PARTNER_REVIEW_REQUIRED_EVENT)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].recipient.openId, 'dh')
  assert.equal([...prismaClient.deliveries.values()][0].channel, 'wecom')
  assert.equal([...prismaClient.deliveries.values()].some((row) => row.channel === 'wecom_group_robot'), false)
})

test('duplicate SUBMITTED delivery is idempotent', async () => {
  const prismaClient = fakePrisma()
  let sends = 0
  const input = {
    prismaClient,
    order: submittedOrder(),
    recipientBinding: binding,
    personalConfig: config,
    sendPersonal: async () => {
      sends += 1
      return { ok: true, errcode: 0, errmsg: 'ok' }
    },
  }
  assert.equal((await deliverPartnerReplenishmentReviewRequired(input)).status, 'sent')
  assert.equal((await deliverPartnerReplenishmentReviewRequired(input)).status, 'duplicate')
  assert.equal(sends, 1)
  assert.equal(prismaClient.deliveries.size, 1)
})

test('APPROVED and REJECTED states never send the review-required notification', async () => {
  for (const status of ['APPROVED', 'REJECTED']) {
    const prismaClient = fakePrisma()
    let sends = 0
    const result = await deliverPartnerReplenishmentReviewRequired({
      prismaClient,
      order: submittedOrder({ id: `rpl-${status}`, status }),
      recipientBinding: binding,
      personalConfig: config,
      sendPersonal: async () => {
        sends += 1
        return { ok: true }
      },
    })
    assert.equal(result.status, 'skipped')
    assert.equal(sends, 0)
    assert.equal(prismaClient.notifications.size, 0)
  }
})

test('developer WeCom failure is recorded without throwing or changing the submitted order', async () => {
  const prismaClient = fakePrisma()
  const order = submittedOrder()
  const result = await deliverPartnerReplenishmentReviewRequired({
    prismaClient,
    order,
    recipientBinding: binding,
    personalConfig: config,
    sendPersonal: async () => ({ ok: false, errcode: 60011, errmsg: 'not allowed' }),
  })
  assert.equal(result.status, 'failed')
  assert.equal(order.status, 'SUBMITTED')
  const delivery = [...prismaClient.deliveries.values()][0]
  assert.equal(delivery.status, 'failed')
  assert.match(delivery.error, /60011/)
})

test('source triggers after committed create result and keeps the group notifier separate', () => {
  const partnerAuth = fs.readFileSync(new URL('../server/partner-auth.js', import.meta.url), 'utf8')
  const submittedSource = fs.readFileSync(new URL('../server/partner-replenishment-notification.js', import.meta.url), 'utf8')
  const approvedSource = fs.readFileSync(new URL('../server/transfer-notification.js', import.meta.url), 'utf8')
  const createIndex = partnerAuth.indexOf('const result = await createReplenishmentOrder')
  const notifyIndex = partnerAuth.indexOf('await deliverPartnerReplenishmentReviewRequired')
  const responseIndex = partnerAuth.indexOf('return res.status(result.reused ? 200 : 201)')
  assert.equal(createIndex > 0 && notifyIndex > createIndex && responseIndex > notifyIndex, true)
  assert.match(partnerAuth.slice(notifyIndex, responseIndex), /\.catch\(\(error\)/)
  assert.doesNotMatch(submittedSource, /sendWechatMarkdownResult|wecom_group_robot/)
  assert.match(submittedSource, /sendWechatPersonal/)
  assert.match(approvedSource, /approvedQuantityBase/)
  assert.match(approvedSource, /wecom_group_robot/)
})
