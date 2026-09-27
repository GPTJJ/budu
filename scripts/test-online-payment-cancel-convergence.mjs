// P0 offline convergence suite for unpaid online-order cancellation.
// Synthetic provider evidence only: no real WeChat Pay call, no database, no
// production identity. Money safety is asserted on every path: only a proven
// non-SUCCESS trade may end a hold, and a SUCCESS trade is never cancelled.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createOnlinePaymentService } from '../server/online-payment-service.js'
import { createOnlinePaymentRecovery } from '../server/online-payment-recovery.js'
import { reconcileOnlineFinancials } from '../server/online-reconciliation.js'

const APP_ID = 'wx0123456789abcdef'
const MCH_ID = '1111111111'
const NOTIFY_URL = 'https://buducandy.cn/api/online-checkout/wechat/notify'
const PAYER_OPENID = 'oSyntheticPayerOpenId'
const AMOUNT = 8400

const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const platformPublicKey = platform.publicKey.export({ type: 'spki', format: 'pem' })
const merchantPrivateKey = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' })
const configuration = {
  appId: APP_ID, mchId: MCH_ID, merchantPrivateKey, merchantSerial: 'A1B2C3D4',
  apiV3Key: 'synthetic-api-v3-key-32bytes-len', platformPublicKey, platformKeyId: 'PUB_KEY_SYNTHETIC',
  notifyUrl: NOTIFY_URL,
}

function sign(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(16).toString('hex')
  const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), rawBody, Buffer.from('\n')])
  return {
    'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
    'wechatpay-signature': crypto.sign('RSA-SHA256', message, platform.privateKey).toString('base64'),
    'wechatpay-serial': configuration.platformKeyId,
  }
}

// Synthetic WeChat Pay v3 transport. The test drives trade_state directly; the
// close endpoint moves the trade to CLOSED exactly as the provider would.
// tradeType: undefined = mirror WeChat (only SUCCESS carries it), null = omit,
// string = send that value. includeAmount: undefined = mirror WeChat (CLOSED
// omits amount), true/false = force. These defaults keep the synthetic payloads
// faithful to the live provider shapes observed on 2026-09-18.
function provider({ state = 'NOTPAY', absent = false, closeStatus = null, amount = AMOUNT,
  tradeType, includeAmount } = {}) {
  const calls = { query: 0, close: 0 }
  const trade = { state, absent, closeStatus }
  async function request(method, path) {
    const query = /^\/v3\/pay\/transactions\/out-trade-no\/([A-Za-z0-9_-]{1,32})\?mchid=\d+$/.exec(path)
    if (method === 'GET' && query) {
      calls.query++
      if (trade.absent) {
        const rawBody = Buffer.from(JSON.stringify({ code: 'ORDER_NOT_EXIST', message: 'synthetic' }), 'utf8')
        return { statusCode: 404, headers: sign(rawBody), rawBody }
      }
      const st = trade.state
      const autoTradeType = st === 'SUCCESS' ? 'JSAPI' : null
      const sendTradeType = tradeType === undefined ? autoTradeType : tradeType
      const autoAmount = st === 'CLOSED' ? false : true
      const sendAmount = includeAmount === undefined ? autoAmount : includeAmount
      const rawBody = Buffer.from(JSON.stringify({
        appid: APP_ID, mchid: MCH_ID, out_trade_no: query[1], trade_state: st,
        ...(sendTradeType === null ? {} : { trade_type: sendTradeType }),
        ...(sendAmount ? { amount: { total: amount, currency: 'CNY' } } : {}),
        ...(st === 'SUCCESS' ? { transaction_id: '4200000000000000000001',
          payer: { openid: PAYER_OPENID }, success_time: new Date().toISOString() } : {}),
      }), 'utf8')
      return { statusCode: 200, headers: sign(rawBody), rawBody }
    }
    if (method === 'POST' && /\/close$/.test(path)) {
      calls.close++
      if (trade.closeStatus) { const rawBody = Buffer.alloc(0); return { statusCode: trade.closeStatus, headers: sign(rawBody), rawBody } }
      trade.state = 'CLOSED'
      const rawBody = Buffer.alloc(0)
      return { statusCode: 204, headers: sign(rawBody), rawBody }
    }
    throw Error(`UNEXPECTED_PROVIDER_REQUEST ${method} ${path}`)
  }
  return { trade, calls, request }
}

// Minimal faithful in-memory stand-in for the Prisma surface the payment
// service, cancellation, finalizer and reconciliation actually touch. The
// settlement version invariant enforced by onlineFinancialTransaction is
// reproduced so a broken update is caught rather than silently absorbed.
function store({ settlement, tender, quote, identity, reservation = null, account = null } = {}) {
  const rows = { settlement: { ...settlement }, tender: { ...tender }, quote, identity, reservation, account }
  const ledgers = [], compensations = [], outbox = []
  const increment = data => {
    const next = { ...data }
    if (next.version && typeof next.version === 'object' && next.version.increment) next.version = rows.settlement.version + next.version.increment
    return next
  }
  const withRelations = row => row && ({ ...row, tenders: [rows.tender].filter(t => t && t.settlementId === row.id),
    refunds: [], compensations: compensations.filter(c => c.settlementId === row.id), reservation: rows.reservation,
    quote: rows.quote })
  const tx = {
    $executeRaw: async () => 0,
    onlineSettlement: {
      findUnique: async () => withRelations(rows.settlement),
      update: async ({ data }) => { rows.settlement = { ...rows.settlement, ...increment(data) }; return rows.settlement },
      findMany: async () => [withRelations(rows.settlement)],
    },
    onlineTender: {
      findUnique: async ({ where }) => (where.merchantTradeNo ? (rows.tender.merchantTradeNo === where.merchantTradeNo ? rows.tender : null) : rows.tender),
      update: async ({ where, data }) => {
        if (where.settlementId_type && (where.settlementId_type.settlementId !== rows.tender.settlementId || where.settlementId_type.type !== rows.tender.type)) throw Error('TENDER_NOT_FOUND')
        rows.tender = { ...rows.tender, ...data }
        return rows.tender
      },
      updateMany: async ({ where, data }) => {
        if (where.settlementId !== rows.tender.settlementId || (where.status && where.status !== rows.tender.status)) return { count: 0 }
        rows.tender = { ...rows.tender, ...data }
        return { count: 1 }
      },
    },
    onlineCheckoutQuote: { findUnique: async () => rows.quote },
    weChatAuthIdentity: { findUnique: async ({ where }) => (where.id ? (rows.identity.id === where.id ? rows.identity : null)
      : (where.provider_appId_openId?.openId === rows.identity.openId ? rows.identity : null)) },
    sweetCardReservation: {
      findUnique: async ({ where }) => (rows.reservation && (where.settlementId ? rows.reservation.settlementId === where.settlementId : rows.reservation.id === where.id) ? rows.reservation : null),
      update: async ({ where, data }) => {
        if (!rows.reservation) throw Error('RESERVATION_NOT_FOUND')
        if (where.settlementId ? rows.reservation.settlementId !== where.settlementId : rows.reservation.id !== where.id) throw Error('RESERVATION_NOT_FOUND')
        if (where.settlementId) {
          if (rows.reservation.releaseCount) throw Error('RESERVATION_RELEASED_TWICE')
          rows.reservation.releaseCount = 1
        }
        rows.reservation = { ...rows.reservation, ...data }
        return rows.reservation
      },
      aggregate: async () => ({ _sum: { amountCents: rows.reservation?.status === 'RESERVED' ? rows.reservation.amountCents : 0n } }),
    },
    sweetCardAccount: {
      findUnique: async () => rows.account,
      update: async ({ data }) => { rows.account = { ...rows.account, ...data }; return rows.account },
    },
    sweetCardLedger: {
      create: async ({ data }) => { ledgers.push(data); return data },
      findUnique: async ({ where }) => ledgers.find(l => l.id === where.id) || null,
      aggregate: async () => ({ _sum: { amountCents: ledgers.reduce((n, l) => n + l.amountCents, 0n) } }),
    },
    onlinePaymentCompensation: { create: async ({ data }) => { compensations.push(data); return data } },
    onlineOutbox: { create: async ({ data }) => { outbox.push(data); return data } },
  }
  return { prisma: { $transaction: fn => fn(tx), onlineSettlement: tx.onlineSettlement, onlineTender: tx.onlineTender,
    weChatAuthIdentity: tx.weChatAuthIdentity }, rows, ledgers, compensations, outbox }
}

function seed({ status = 'PENDING', prepayRequestedAt = new Date(), expiresAt = new Date(Date.now() + 900000),
  sweetCardCents = 0n, accountId = null } = {}) {
  const id = 'os-' + crypto.randomUUID()
  const merchantTradeNo = `B${crypto.createHash('sha256').update(id).digest('hex').slice(0, 31)}`
  const settlement = { id, userId: 'u-synthetic', quoteId: 'oq-synthetic', namespace: 'cloudbase-miniprogram',
    externalOrderId: id, requestKey: 'rk-synthetic', requestFingerprint: 'fp-synthetic',
    accountId, status, version: 1, currency: 'CNY', merchandiseCents: 6900n, eligibleMerchandiseCents: 6900n,
    shippingCents: 1500n, totalCents: 8400n, sweetCardCents, wechatCents: 8400n - sweetCardCents,
    capturedLedgerId: null, expiresAt, paidAt: null, cancelledAt: null, reconciliationReason: null,
    createdAt: new Date(Date.now() - 60000), updatedAt: new Date(Date.now() - 60000) }
  const tender = { id: 't-synthetic', settlementId: id, type: 'WECHAT', amountCents: 8400n - sweetCardCents,
    status: 'PENDING', merchantTradeNo, providerTransactionId: null, prepayId: null,
    prepayRequestedAt, verifiedAt: null, providerSuccessAt: null }
  const quote = { id: 'oq-synthetic', userId: 'u-synthetic', requestKey: 'rk-synthetic', requestFingerprint: 'fp-synthetic',
    snapshot: { paymentIdentity: { identityId: 'wi-synthetic', appId: APP_ID, mchId: MCH_ID },
      cardValidity: { validFrom: null, expiresAt: null } }, expiresAt }
  const identity = { id: 'wi-synthetic', userId: 'u-synthetic', provider: 'WECHAT_MINIPROGRAM', appId: APP_ID, openId: PAYER_OPENID }
  const reservation = sweetCardCents > 0n ? { id: 'sr-synthetic', settlementId: id, accountId, userId: 'u-synthetic',
    requestKey: `reserve:${id}`, amountCents: sweetCardCents, status: 'RESERVED', expiresAt, capturedAt: null, releasedAt: null } : null
  const account = sweetCardCents > 0n ? { id: accountId, balanceCents: sweetCardCents, status: 'ACTIVE', version: 1,
    binding: { userId: 'u-synthetic' }, bindingMode: 'REQUIRED', claim: { userId: 'u-synthetic' } } : null
  return { settlement, tender, quote, identity, reservation, account }
}

const service = s => createOnlinePaymentService(s.prisma, configuration, { request: s.request, env: {} })

test('NOTPAY + cancel converges: close, re-query, CANCELLED, and the trade is closed once', async () => {
  const p = provider({ state: 'NOTPAY' })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(p.trade.state, 'CLOSED')
  assert.equal(s.rows.tender.status, 'CLOSED')
  assert.ok(s.rows.settlement.cancelledAt)
  assert.notEqual(s.rows.settlement.reconciliationReason, 'EXPIRY_REQUEST')
})

test('CLOSED + cancel converges to CANCELLED without a close call', async () => {
  const p = provider({ state: 'CLOSED' })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(p.calls.close, 0)
  assert.equal(s.rows.tender.status, 'CLOSED')
})

test('SUCCESS is never cancelled: cancel finalizes PAID instead', async () => {
  const p = provider({ state: 'SUCCESS' })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'PAID')
  assert.equal(p.calls.close, 0)
  assert.equal(s.rows.tender.status, 'SUCCEEDED')
  assert.equal(s.rows.settlement.cancelledAt, null)
})

test('ORDER_NOT_EXIST converges to CANCELLED once the absent grace has elapsed', async () => {
  const p = provider({ absent: true })
  const s = store(seed({ status: 'CLOSING', prepayRequestedAt: new Date(Date.now() - 600000) }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(s.rows.settlement.reconciliationReason, 'PROVIDER_TRADE_ABSENT')
})

test('ORDER_NOT_EXIST inside the grace window retains the hold instead of releasing', async () => {
  const p = provider({ absent: true })
  const s = store(seed({ status: 'CLOSING', prepayRequestedAt: new Date() }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CLOSING')
  assert.equal(s.rows.settlement.cancelledAt, null)
})

test('PAYERROR does not stay in CLOSING: it converges to CANCELLED', async () => {
  const p = provider({ state: 'PAYERROR' })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(s.rows.tender.status, 'CLOSED')
  assert.equal(p.calls.close, 1)
})

test('PAYERROR still converges when the provider refuses the close', async () => {
  const p = provider({ state: 'PAYERROR', closeStatus: 500 })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(s.rows.settlement.reconciliationReason, 'PROVIDER_PAYERROR')
  assert.equal(s.rows.tender.status, 'CLOSED')
})

test('REVOKED does not stay in CLOSING: it converges to CANCELLED', async () => {
  const p = provider({ state: 'REVOKED' })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(s.rows.tender.status, 'CLOSED')
})

test('PAYERROR is never released when the close raced a real payment', async () => {
  const p = provider({ state: 'PAYERROR' })
  const s = store(seed({ status: 'CLOSING' }))
  // The provider flips to SUCCESS between the close and the confirming re-query.
  const request = async (method, path) => { const reply = await p.request(method, path); if (method === 'POST') p.trade.state = 'SUCCESS'; return reply }
  const state = await createOnlinePaymentService(s.prisma, configuration, { request, env: {} }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'PAID')
  assert.equal(s.rows.settlement.cancelledAt, null)
})

test('USERPAYING keeps the hold while the provider trade can still be paid', async () => {
  const p = provider({ state: 'USERPAYING' })
  const s = store(seed({ status: 'CLOSING', expiresAt: new Date(Date.now() + 900000) }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CLOSING')
  assert.equal(p.calls.close, 0)
  assert.equal(s.rows.settlement.cancelledAt, null)
})

test('USERPAYING past time_expire leaves CLOSING via a bounded terminal state, never released', async () => {
  const p = provider({ state: 'USERPAYING' })
  const s = store(seed({ status: 'CLOSING', expiresAt: new Date(Date.now() - 3600000) }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'RECONCILIATION_REQUIRED')
  assert.equal(s.rows.settlement.reconciliationReason, 'PROVIDER_CLOSE_UNRESOLVED')
  assert.equal(s.rows.settlement.cancelledAt, null)
  assert.equal(s.rows.tender.status, 'PENDING')
})

test('USERPAYING that becomes CLOSED converges to CANCELLED on the next recovery pass', async () => {
  const p = provider({ state: 'USERPAYING' })
  const s = store(seed({ status: 'CLOSING' }))
  const payment = service({ prisma: s.prisma, request: p.request })
  assert.equal((await payment.recover(s.rows.settlement.id)).status, 'CLOSING')
  p.trade.state = 'CLOSED'
  assert.equal((await payment.recover(s.rows.settlement.id)).status, 'CANCELLED')
})

test('repeated cancel is idempotent and releases the reservation exactly once', async () => {
  const s = store(seed({ status: 'CLOSING', sweetCardCents: 1000n, accountId: 'a-synthetic' }))
  const p = provider({ state: 'NOTPAY', amount: Number(s.rows.settlement.wechatCents) })
  const payment = service({ prisma: s.prisma, request: p.request })
  const first = await payment.cancel(s.rows.settlement.id, 'u-synthetic')
  const second = await payment.cancel(s.rows.settlement.id, 'u-synthetic')
  const third = await payment.cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(first.status, 'CANCELLED')
  assert.equal(second.status, 'CANCELLED')
  assert.equal(third.status, 'CANCELLED')
  assert.equal(s.rows.reservation.status, 'RELEASED')
  assert.equal(s.rows.reservation.releaseCount, 1)
  assert.equal(s.ledgers.length, 0)
})

test('cancel is refused for a settlement owned by another customer', async () => {
  const p = provider({ state: 'NOTPAY' })
  const s = store(seed({ status: 'CLOSING' }))
  await assert.rejects(service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-other'), /订单不存在/)
  assert.equal(s.rows.settlement.status, 'CLOSING')
  assert.equal(p.calls.query, 0)
})

test('a provider transport failure fails safe: the hold is unchanged', async () => {
  const s = store(seed({ status: 'CLOSING' }))
  const request = async () => { throw Object.assign(Error('synthetic network failure'), { code: 'ONLINE_WECHAT_NETWORK_ERROR' }) }
  await assert.rejects(service({ prisma: s.prisma, request }).cancel(s.rows.settlement.id, 'u-synthetic'))
  assert.equal(s.rows.settlement.status, 'CLOSING')
  assert.equal(s.rows.settlement.cancelledAt, null)
  assert.equal(s.rows.tender.status, 'PENDING')
})

test('a cancelled settlement leaves the recovery scan so it no longer blocks a new purchase', async () => {
  const p = provider({ state: 'NOTPAY' })
  const s = store(seed({ status: 'CLOSING' }))
  const payment = service({ prisma: s.prisma, request: p.request })
  assert.equal((await payment.cancel(s.rows.settlement.id, 'u-synthetic')).status, 'CANCELLED')
  const seen = []
  const worker = createOnlinePaymentRecovery({ onlineSettlement: {
    findFirst: async () => ({ id: s.rows.settlement.id }),
    findMany: async () => (s.rows.settlement.status === 'CANCELLED' ? [] : [{ id: s.rows.settlement.id }]),
  } }, { recover: async id => { seen.push(id); return { status: s.rows.settlement.status } } })
  assert.equal((await worker.tick()).scanned, 0)
  assert.deepEqual(seen, [])
})

test('financial reconciliation stays at zero delta after a cancelled unpaid order', async () => {
  const p = provider({ state: 'NOTPAY' })
  const s = store(seed({ status: 'CLOSING' }))
  await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  const report = await reconcileOnlineFinancials(s.prisma)
  assert.equal(report.pass, true)
  assert.equal(report.monetaryDeltaCents, '0')
  assert.equal(report.mismatches, 0)
  assert.equal(report.pendingCompensations, 0)
  assert.equal(report.overdueReservations, 0)
})

// Regression for the production incident: WeChat's v3 query omits trade_type
// while a trade is unpaid, so requiring it rejected every NOTPAY response with
// 401 and left holds stuck in CLOSING forever.
test('a real WeChat NOTPAY query payload omits trade_type and must still converge', async () => {
  const p = provider({ state: 'NOTPAY', tradeType: null })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(p.trade.state, 'CLOSED')
})

test('a USERPAYING query payload without trade_type is accepted as provider truth', async () => {
  const p = provider({ state: 'USERPAYING', tradeType: null })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CLOSING')
  assert.equal(p.calls.close, 0)
})

test('a present but non-JSAPI trade_type is still rejected', async () => {
  const p = provider({ state: 'NOTPAY', tradeType: 'NATIVE' })
  const s = store(seed({ status: 'CLOSING' }))
  await assert.rejects(service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic'),
    /微信支付结果校验失败/)
  assert.equal(s.rows.settlement.status, 'CLOSING')
  assert.equal(s.rows.settlement.cancelledAt, null)
})

test('an unpaid query payload is rejected when the merchant id does not match', async () => {
  const s = store(seed({ status: 'CLOSING' }))
  const p = provider({ state: 'NOTPAY', tradeType: null })
  const request = async (method, path) => {
    const reply = await p.request(method, path)
    if (method === 'GET') {
      const body = JSON.parse(reply.rawBody.toString('utf8'))
      body.mchid = '9999999999'
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8')
      return { statusCode: 200, headers: sign(rawBody), rawBody }
    }
    return reply
  }
  await assert.rejects(createOnlinePaymentService(s.prisma, configuration, { request, env: {} })
    .cancel(s.rows.settlement.id, 'u-synthetic'), /微信支付结果校验失败/)
  assert.equal(s.rows.settlement.cancelledAt, null)
})

// Second production shape: a CLOSED trade omits amount entirely, so requiring
// an amount rejected the very response that proves the order is unpayable.
test('a real WeChat CLOSED payload omits amount and must still converge', async () => {
  const p = provider({ state: 'CLOSED' })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
  assert.equal(s.rows.settlement.cancelledAt !== null, true)
  assert.equal(s.rows.tender.status, 'CLOSED')
})

test('a CLOSED payload that DOES report an amount is still checked against the tender', async () => {
  const p = provider({ state: 'CLOSED', includeAmount: true, amount: 999 })
  const s = store(seed({ status: 'CLOSING' }))
  await assert.rejects(service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic'),
    /核对不一致/)
  assert.equal(s.rows.settlement.cancelledAt, null)
})

test('a CLOSED payload reporting a matching amount still converges', async () => {
  const p = provider({ state: 'CLOSED', includeAmount: true, amount: AMOUNT })
  const s = store(seed({ status: 'CLOSING' }))
  const state = await service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic')
  assert.equal(state.status, 'CANCELLED')
})

test('an amount is still mandatory for a SUCCESS trade', async () => {
  const p = provider({ state: 'SUCCESS', includeAmount: false })
  const s = store(seed({ status: 'CLOSING' }))
  await assert.rejects(service({ prisma: s.prisma, request: p.request }).cancel(s.rows.settlement.id, 'u-synthetic'),
    /微信支付结果校验失败/)
  assert.equal(s.rows.settlement.cancelledAt, null)
  assert.equal(s.rows.tender.status, 'PENDING')
})
