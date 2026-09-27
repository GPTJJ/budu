import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.PUBLIC_BASE_URL = 'https://budu.example'

const {
  STOCKING_GROUP_CHANNEL,
  TRANSFER_RECIPIENT_POLICY,
  approvedReplenishmentItemSummary,
  deliverPartnerReplenishmentStockingNotification,
  deliverTransferRequestNotification,
  transferItemSummary,
} = await import('../server/transfer-notification.js')
const { sendWechatMarkdownResult, wecomWebhookUrl } = await import('../server/wechat-alert.js')

const transfer = (overrides = {}) => ({
  id: 'tr-routing-1',
  fromStoreKey: 'guanshe',
  fromStoreName: '北京官舍店',
  storeKey: 'tongying',
  storeName: '北京通盈中心店',
  createdBy: 'requester',
  createdAt: new Date('2026-09-20T03:00:00.000Z'),
  status: 'pending',
  items: [
    { itemCode: 'NO.2', productName: '柠檬', quantity: null, boxQuantity: 0, pieceQuantity: 166 },
    { itemCode: 'NO.10', productName: '香草', quantity: null, boxQuantity: 1, pieceQuantity: 50 },
    { itemCode: 'MAT-1', productName: '冰袋', quantity: 8 },
  ],
  ...overrides,
})

const replenishment = (overrides = {}) => ({
  id: 'rpl-1',
  orderNo: 'RPL-20260920-1',
  status: 'APPROVED',
  partnerNameSnapshot: '森醒',
  partnerStoreNameSnapshot: '北京门店',
  reviewedByActorName: 'reviewer',
  reviewedAt: new Date('2026-09-20T04:00:00.000Z'),
  items: [
    { productCodeSnapshot: 'CANDY-1', productNameSnapshot: '糖果A', orderUnitSnapshot: 'PCS', requestedQuantityBase: 100, approvedQuantityBase: 60 },
    { productCodeSnapshot: 'CANDY-2', productNameSnapshot: '糖果B', orderUnitSnapshot: 'PCS', requestedQuantityBase: 50, approvedQuantityBase: 0 },
    { productCodeSnapshot: 'FOOD-1', productNameSnapshot: '原料', orderUnitSnapshot: 'KG', requestedQuantityBase: 3000, approvedQuantityBase: 1500 },
  ],
  ...overrides,
})

function fakePrisma() {
  const notifications = new Map()
  const deliveries = new Map()
  return {
    notifications,
    deliveries,
    store: {
      async findUnique({ where }) {
        assert.equal(where.key, 'guanshe')
        return { name: '北京官舍店' }
      },
    },
    notification: {
      async create({ data }) {
        if (notifications.has(data.id)) throw Object.assign(new Error('duplicate notification'), { code: 'P2002' })
        notifications.set(data.id, { ...data })
        return notifications.get(data.id)
      },
      async findUnique({ where }) {
        return notifications.get(where.id) || null
      },
    },
    notificationDelivery: {
      async create({ data }) {
        if (deliveries.has(data.id)) throw Object.assign(new Error('duplicate delivery'), { code: 'P2002' })
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

function groupHarness(result = { ok: true, errcode: 0, errmsg: 'ok' }) {
  const calls = []
  return {
    calls,
    send: async (title, content) => {
      calls.push({ title, content })
      return result
    },
  }
}

test('item summaries preserve transfer quantities and Partner final approved quantities', () => {
  const transferSummary = transferItemSummary(transfer().items)
  assert.match(transferSummary, /NO\.2 柠檬 × 166颗/)
  assert.match(transferSummary, /NO\.10 香草 × 1箱 \+ 50颗/)
  assert.match(transferSummary, /MAT-1 冰袋 × 8件/)
  const partnerSummary = approvedReplenishmentItemSummary(replenishment().items)
  assert.match(partnerSummary, /糖果A × 60 颗/)
  assert.doesNotMatch(partnerSummary, /100/)
  assert.doesNotMatch(partnerSummary, /糖果B/)
  assert.match(partnerSummary, /原料 × 1\.5 KG/)
})

test('group robot requires the existing explicit webhook and validates provider errcode', async () => {
  const originalWebhook = process.env.WECHAT_WORK_WEBHOOK_URL
  const originalFetch = global.fetch
  const calls = []
  try {
    delete process.env.WECHAT_WORK_WEBHOOK_URL
    global.fetch = async (...args) => {
      calls.push(args)
      return Response.json({ errcode: 0, errmsg: 'ok' })
    }
    assert.equal(wecomWebhookUrl(), '')
    assert.equal((await sendWechatMarkdownResult('title', 'content')).errcode, 'CONFIG_MISSING')
    assert.equal(calls.length, 0)
    process.env.WECHAT_WORK_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only'
    assert.equal((await sendWechatMarkdownResult('title', 'content')).ok, true)
    assert.equal(calls.length, 1)
    global.fetch = async () => Response.json({ errcode: 93000, errmsg: 'invalid webhook' })
    assert.equal((await sendWechatMarkdownResult('title', 'content')).ok, false)
  } finally {
    global.fetch = originalFetch
    if (originalWebhook === undefined) delete process.env.WECHAT_WORK_WEBHOOK_URL
    else process.env.WECHAT_WORK_WEBHOOK_URL = originalWebhook
  }
})

test('internal transfer always sends one group message without schedule or personal recipient lookup', async () => {
  const prismaClient = fakePrisma()
  const group = groupHarness()
  const result = await deliverTransferRequestNotification({ prismaClient, transfer: transfer(), sendGroup: group.send })
  assert.equal(result.ok, true)
  assert.equal(result.recipientPolicy, TRANSFER_RECIPIENT_POLICY)
  assert.equal(result.groupCount, 1)
  assert.equal(group.calls.length, 1)
  assert.match(group.calls[0].content, /业务类型：\*\* 内部调拨/)
  assert.match(group.calls[0].content, /北京官舍店/)
  assert.match(group.calls[0].content, /北京通盈中心店/)
  assert.equal([...prismaClient.deliveries.values()][0].channel, STOCKING_GROUP_CHANNEL)
})

test('internal transfer remains group-routed when no schedule API exists', async () => {
  const prismaClient = fakePrisma()
  assert.equal('schedule' in prismaClient, false)
  const group = groupHarness()
  const result = await deliverTransferRequestNotification({ prismaClient, transfer: transfer({ id: 'tr-no-shift' }), sendGroup: group.send })
  assert.equal(result.status, 'sent')
  assert.equal(group.calls.length, 1)
})

test('Partner approval sends one group message using approved quantities and not requested quantities', async () => {
  const prismaClient = fakePrisma()
  const group = groupHarness()
  const result = await deliverPartnerReplenishmentStockingNotification({ prismaClient, order: replenishment(), sendGroup: group.send })
  assert.equal(result.ok, true)
  assert.equal(group.calls.length, 1)
  assert.match(group.calls[0].content, /业务类型：\*\* Partner补货/)
  assert.match(group.calls[0].content, /糖果A × 60 颗/)
  assert.doesNotMatch(group.calls[0].content, /100/)
  assert.doesNotMatch(group.calls[0].content, /糖果B/)
  assert.match(group.calls[0].content, /状态：\*\* 待发货/)
})

test('SUBMITTED Partner order is not a stocking trigger', async () => {
  const prismaClient = fakePrisma()
  const group = groupHarness()
  const result = await deliverPartnerReplenishmentStockingNotification({
    prismaClient,
    order: replenishment({ status: 'SUBMITTED', reviewedAt: null }),
    sendGroup: group.send,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(group.calls.length, 0)
  assert.equal(prismaClient.notifications.size, 0)
})

test('duplicate transfer and Partner approval requests do not resend group messages', async () => {
  const prismaClient = fakePrisma()
  const group = groupHarness()
  await deliverTransferRequestNotification({ prismaClient, transfer: transfer(), sendGroup: group.send })
  await deliverTransferRequestNotification({ prismaClient, transfer: transfer(), sendGroup: group.send })
  await deliverPartnerReplenishmentStockingNotification({ prismaClient, order: replenishment(), sendGroup: group.send })
  await deliverPartnerReplenishmentStockingNotification({ prismaClient, order: replenishment(), sendGroup: group.send })
  assert.equal(group.calls.length, 2)
  assert.equal(prismaClient.deliveries.size, 2)
})

test('provider failure is recorded and does not throw into the completed business operation', async () => {
  const prismaClient = fakePrisma()
  const group = groupHarness({ ok: false, errcode: 93000, errmsg: 'invalid webhook' })
  const result = await deliverTransferRequestNotification({ prismaClient, transfer: transfer(), sendGroup: group.send })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  const delivery = [...prismaClient.deliveries.values()][0]
  assert.equal(delivery.status, 'failed')
  assert.match(delivery.error, /93000/)
})

test('source keeps original business triggers, removes personal shift routing, and leaves other WeCom paths intact', () => {
  const source = fs.readFileSync(new URL('../server/transfer-notification.js', import.meta.url), 'utf8')
  const v2 = fs.readFileSync(new URL('../server/v2.js', import.meta.url), 'utf8')
  const partnerDomain = fs.readFileSync(new URL('../server/partner-domain.js', import.meta.url), 'utf8')
  const notificationCenter = fs.readFileSync(new URL('../server/notification-center.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /schedule\.findMany|wechatBinding|sendWechatPersonal|developerWecomRecipientBinding/)
  assert.match(v2, /deliverTransferRequestNotification\(\{ transfer: serialized \}\)/)
  assert.match(v2, /deliverTransferRequestNotification[\s\S]+\.catch\(\(error\)/)
  assert.match(partnerDomain, /REPLENISHMENT_REVIEW_ACTIONS\.APPROVE/)
  assert.match(partnerDomain, /deliverPartnerReplenishmentStockingNotification/)
  assert.match(partnerDomain, /deliverPartnerReplenishmentStockingNotification[\s\S]+\.catch\(\(error\)/)
  assert.match(notificationCenter, /export async function notify\(opt\)/)
  assert.match(notificationCenter, /deliverCustomerRequestWecom/)
})
