import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineLogistics } from '../server/online-logistics.js'

const APP_ID = 'wxfce0a3c4bb430023'
const SETTLEMENT = 'os-' + 'a'.repeat(64)
const AUTHORIZATION = { id: 'ofa-1', method: 'DELIVERY', trackingNo: 'SF1234567890' }
const VALID = {
  settlementId: SETTLEMENT,
  receiverPhone: '13800000000',
  goodsName: '92%生巧克力',
  goodsImgUrl: 'https://cdn.example.com/p/c1.jpg',
  orderDetailPath: 'pages/order-detail/order-detail?payNo=B1',
}

/** A minimal in-memory stand-in for the columns this service actually touches. */
function store({ settlement = { id: SETTLEMENT, userId: 'u1', tenders: [] }, authorization = AUTHORIZATION, identity = { openId: 'oPENID-1' } } = {}) {
  const state = { traces: new Map(), row: null, settlement, authorization, identity, claimable: true, raw: [] }
  const prisma = {
    onlineSettlement: { findUnique: async () => state.settlement },
    onlineFulfillmentAuthorization: { findUnique: async () => state.authorization },
    weChatAuthIdentity: { findFirst: async () => state.identity },
    onlineLogisticsTrace: {
      findUnique: async ({ where }) => state.traces.get(where.settlementId) || null,
      create: async ({ data }) => {
        if (state.traces.has(data.settlementId)) throw Object.assign(Error('unique'), { code: 'P2002' })
        // Mirrors the column defaults the real table applies on insert.
        const row = { status: 'PENDING', attempts: 0, waybillToken: null, lastError: null, syncedAt: null, ...data }
        state.traces.set(data.settlementId, row)
        state.row = row
        return row
      },
    },
    $transaction: async fn => fn(prisma),
    $queryRaw: async (_strings, ...values) => {
      const row = state.row
      if (!row || row.status !== 'PENDING' || !state.claimable) return []
      state.claimable = false
      row.attempts += 1
      row.leaseOwner = values[0]
      return [{
        id: row.id, settlement_id: row.settlementId, authorization_id: row.authorizationId, attempts: row.attempts,
        lease_owner: row.leaseOwner, receiver_phone: row.receiverPhone, goods_name: row.goodsName,
        goods_img_url: row.goodsImgUrl, order_detail_path: row.orderDetailPath,
      }]
    },
    $executeRaw: async (strings, ...values) => {
      const sql = typeof strings === 'string' ? strings : strings.join('§')
      state.raw.push({ sql, values })
      const row = state.row
      row.leaseOwner = null
      if (sql.includes("status = 'SYNCED'")) { row.status = 'SYNCED'; row.waybillToken = values[0] }
      else if (sql.includes("'UNSUPPORTED'")) { row.status = 'UNSUPPORTED'; row.lastError = 'LOGISTICS_UNSUPPORTED_NO_WECHAT_TRANSACTION' }
      else if (sql.includes("status = 'FAILED'")) { row.status = 'FAILED'; row.lastError = values[0] }
      else { row.lastError = values[0]; row.availableAt = 'deferred' }
      return 1
    },
  }
  return { state, prisma }
}

function service(options = {}, calls = []) {
  const { state, prisma } = store(options)
  const logistics = createOnlineLogistics(prisma, {
    appId: APP_ID,
    logistics: { reportWaybill: async input => { calls.push(input); return options.report ?? { status: 'SYNCED', waybillToken: 'o_ARWtoken' } } },
  })
  return { logistics, state, calls }
}

test('SVC-01 registering the same shipment twice is idempotent', async () => {
  const { logistics, state } = service()
  const first = await logistics.register(VALID)
  const second = await logistics.register(VALID)
  assert.deepEqual(first, second)
  assert.equal(state.traces.size, 1)
  assert.equal(first.status, 'PENDING')
  assert.equal(first.officialTracking, 'PENDING')
})

test('SVC-02 logistics is never registered before the merchant ships', async () => {
  const { logistics } = service({ authorization: null })
  await assert.rejects(() => logistics.register(VALID), /尚未发货/)
})

test('SVC-03 a pickup order never enters the logistics flow', async () => {
  const { logistics } = service({ authorization: { id: 'ofa-2', method: 'PICKUP', trackingNo: null } })
  await assert.rejects(() => logistics.register(VALID), /不是配送订单/)
})

test('SVC-04 incomplete reporting facts are refused instead of stored', async () => {
  for (const key of ['receiverPhone', 'goodsName', 'goodsImgUrl', 'orderDetailPath']) {
    const { logistics, state } = service()
    await assert.rejects(() => logistics.register({ ...VALID, [key]: '' }), /参数不完整/)
    assert.equal(state.traces.size, 0)
  }
})

test('SVC-05 conflicting facts for the same shipment are rejected, not silently overwritten', async () => {
  const { logistics } = service()
  await logistics.register(VALID)
  await assert.rejects(() => logistics.register({ ...VALID, receiverPhone: '13900000000' }), /冲突/)
  await assert.rejects(() => logistics.register({ ...VALID, goodsName: '别的商品' }), /冲突/)
})

test('SVC-06 the read view exposes a token only when WeChat issued one', async () => {
  const { logistics, state } = service()
  assert.equal(await logistics.status(SETTLEMENT), null)

  await logistics.register(VALID)
  assert.deepEqual(await logistics.status(SETTLEMENT), { status: 'PENDING', waybillToken: null, officialTracking: 'PENDING' })

  state.row.status = 'SYNCED'; state.row.waybillToken = 'o_ARWtoken'
  assert.deepEqual(await logistics.status(SETTLEMENT), { status: 'SYNCED', waybillToken: 'o_ARWtoken', officialTracking: 'AVAILABLE' })

  state.row.status = 'UNSUPPORTED'
  assert.deepEqual(await logistics.status(SETTLEMENT), { status: 'UNSUPPORTED', waybillToken: null, officialTracking: 'UNSUPPORTED' })
})

test('SVC-07 a Sweet Card-only settlement reports nothing to WeChat and degrades honestly', async () => {
  // Sweet Card can never pay shipping, so this is the "no WeChat tender" shape.
  const { logistics, state, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [] } })
  await logistics.register(VALID)
  const summary = await logistics.tick()
  assert.equal(summary.unsupported, 1)
  assert.equal(calls.length, 0, 'WeChat must not be called without a real transaction id')
  assert.equal(state.row.status, 'UNSUPPORTED')
  assert.deepEqual(await logistics.status(SETTLEMENT), { status: 'UNSUPPORTED', waybillToken: null, officialTracking: 'UNSUPPORTED' })
})

test('SVC-08 a real WeChat tender is reported verbatim and the token is persisted', async () => {
  const tender = { type: 'WECHAT', status: 'SUCCEEDED', providerTransactionId: '4200003114202609180000000001' }
  const { logistics, state, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [tender] } })
  await logistics.register(VALID)
  const summary = await logistics.tick()
  assert.equal(summary.synced, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].transId, tender.providerTransactionId)
  assert.equal(calls[0].openid, 'oPENID-1')
  assert.equal(calls[0].waybillId, 'SF1234567890')
  assert.equal(calls[0].receiverPhone, VALID.receiverPhone)
  assert.equal(state.row.status, 'SYNCED')
  assert.equal(state.row.waybillToken, 'o_ARWtoken')
  assert.equal((await logistics.status(SETTLEMENT)).officialTracking, 'AVAILABLE')
})

test('SVC-09 a payment that is not SUCCEEDED is not a transaction id to report', async () => {
  const unsettled = { type: 'WECHAT', status: 'PENDING', providerTransactionId: '4200003114202609180000000001' }
  const { logistics, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [unsettled] } })
  await logistics.register(VALID)
  assert.equal((await logistics.tick()).unsupported, 1)
  assert.equal(calls.length, 0)
})

test('SVC-10 a WeChat rejection is recorded, and a retryable one is deferred rather than dropped', async () => {
  const tender = { type: 'WECHAT', status: 'SUCCEEDED', providerTransactionId: '4200003114202609180000000001' }
  const rejected = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [tender] }, report: { status: 'FAILED', code: 9300513 } })
  await rejected.logistics.register(VALID)
  assert.equal((await rejected.logistics.tick()).failed, 1)
  assert.equal(rejected.state.row.status, 'FAILED')
  assert.equal(rejected.state.row.lastError, 'LOGISTICS_REJECTED_9300513')

  const deferred = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [tender] }, report: { status: 'PENDING', code: -1 } })
  await deferred.logistics.register(VALID)
  assert.equal((await deferred.logistics.tick()).pending, 1)
  assert.equal(deferred.state.row.status, 'PENDING')
  assert.equal(deferred.state.row.availableAt, 'deferred', 'a retryable failure must be rescheduled, not lost')
})

test('SVC-11 an already-synced shipment is never re-reported', async () => {
  const tender = { type: 'WECHAT', status: 'SUCCEEDED', providerTransactionId: '4200003114202609180000000001' }
  const { logistics, state, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [tender] } })
  await logistics.register(VALID)
  await logistics.tick()
  assert.equal(calls.length, 1)
  // A later pass finds nothing to claim: the trace is no longer PENDING.
  assert.equal((await logistics.tick()).scanned, 0)
  assert.equal(calls.length, 1)
  assert.equal(state.row.waybillToken, 'o_ARWtoken')
})

test('SVC-12 a missing buyer identity is a hard failure, never a fabricated openid', async () => {
  const tender = { type: 'WECHAT', status: 'SUCCEEDED', providerTransactionId: '4200003114202609180000000001' }
  const { logistics, state, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', tenders: [tender] }, identity: null })
  await logistics.register(VALID)
  assert.equal((await logistics.tick()).failed, 1)
  assert.equal(state.row.lastError, 'LOGISTICS_REJECTED_OPENID')
  assert.equal(calls.length, 0)
})
