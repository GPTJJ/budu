import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { MemoryPrisma, applyData, matches } from './helpers/memory-prisma.mjs'

// Synthetic memory adapters + actual loopback Express handlers and signatures.
// No production URL, merchant request, real order, notification or DB is used.
// Row-lock intent is asserted; this suite is NOT native PostgreSQL concurrency proof.
const posDb = new MemoryPrisma()
globalThis.__buduPrisma = posDb
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/chaowai_memory_only'
process.env.PAYMENT_MODE = 'mock'
const { default: express } = await import('express')
const { createOnlineCheckout } = await import('../server/online-checkout.js')
const { createOnlinePaymentService } = await import('../server/online-payment-service.js')
const { createOnlinePaymentFinalizer } = await import('../server/online-payment-finalizer.js')
const { createOnlineCheckoutRouter } = await import('../server/online-checkout-api.js')
const { createCustomerSession } = await import('../server/customer-auth.js')
const { signProductionGatewayRequest, gatewayBodyHash } = await import('../server/production-cloudbase-gateway.js')
const { PaymentService } = await import('../server/payments/payment-service.js')
const { ExternalSettlementService } = await import('../server/settlements/external-settlement-service.js')
const { posRouter } = await import('../server/pos.js')
const { assertNewRedemptionAccess } = await import('../server/sweet-card-availability.js')
const { listCustomerSweetCardStores, getCustomerSweetCard } = await import('../server/sweet-card-claim.js')
const { redeemSweetCard } = await import('../server/sweet-card.js')
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = () => crypto.randomUUID()
const newStoreKey = 'store-0123456789abcdef0123'
const closed = error => error.status === 409 && error.code === 'STORE_CLOSED'
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const paymentConfig = { appId: 'wx0123456789abcdef', mchId: '1111111111', platformKeyId: 'SYNTHETIC',
  platformPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), apiV3Key: '1'.repeat(32),
  merchantPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  notifyUrl: 'https://buducandy.cn/api/online-checkout/wechat/notify' }
function signed(body, statusCode = 200) {
  const rawBody = Buffer.from(JSON.stringify(body)), timestamp = String(Math.floor(Date.now() / 1000)), nonce = uuid()
  return { statusCode, rawBody, headers: { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
    'wechatpay-serial': paymentConfig.platformKeyId,
    'wechatpay-signature': crypto.sign('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), rawBody, Buffer.from('\n')]), keys.privateKey).toString('base64') } }
}
class OnlineMemory {
  constructor() {
    this.users = new Map([['customer', { id: 'customer', role: 'customer', status: 'active' }], ['other', { id: 'other', role: 'customer', status: 'active' }]])
    this.stores = new Map(['chaowai', 'tongying', 'guanshe', 'xidan', newStoreKey].map(key => [key, { key, name: key === 'chaowai' ? '朝外店' : key, active: true }]))
    this.quotes = new Map(); this.settlements = new Map(); this.tenders = new Map(); this.sessions = new Map()
    this.writes = []; this.locks = []; this.storeReads = 0; this.beforeStoreRead = null; this.beforeStoreLock = null
    const model = (map, kind) => ({
      findUnique: async ({ where }) => {
        const row = [...map.values()].find(r => Object.entries(where).every(([k, v]) => r[k] === v))
        return row || null
      },
      create: async ({ data }) => { this.writes.push(kind + '.create'); const row = { createdAt: new Date(), version: 1, ...(kind === 'tender' ? { status: 'PENDING' } : {}), ...structuredClone(data) }; map.set(row.id, row); return row },
      update: async ({ where, data }) => { this.writes.push(kind + '.update'); return applyData(map.get(where.id), data) },
    })
    this.user = model(this.users, 'user')
    this.store = {
      findUnique: async ({ where }) => { this.storeReads++; this.beforeStoreRead?.(this.storeReads); return this.stores.get(where.key) || null },
      findMany: async ({ where = {}, select } = {}) => [...this.stores.values()].filter(s => (where.active === undefined || where.active === s.active)
        && (!where.key?.in || where.key.in.includes(s.key))).map(s => select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, s[k]])) : s),
    }
    this.onlineCheckoutQuote = model(this.quotes, 'quote')
    this.onlineSettlement = model(this.settlements, 'settlement')
    this.onlineSettlement.findUnique = async ({ where, include }) => {
      const s = [...this.settlements.values()].find(r => Object.entries(where).every(([k, v]) => r[k] === v))
      return s ? { ...s, ...(include?.quote ? { quote: this.quotes.get(s.quoteId) } : {}), tenders: [...this.tenders.values()].filter(t => t.settlementId === s.id), compensations: [], refunds: [] } : null
    }
    this.onlineTender = model(this.tenders, 'tender')
    this.onlineTender.updateMany = async ({ where, data }) => { this.writes.push('tender.updateMany'); const rows = [...this.tenders.values()].filter(t => matches(t, where)); rows.forEach(t => applyData(t, data)); return { count: rows.length } }
    this.onlineTender.findUnique = async ({ where }) => [...this.tenders.values()].find(t => Object.entries(where).every(([k, v]) => t[k] === v)) || null
    this.onlineOutbox = { create: async ({ data }) => { this.writes.push('outbox.create'); return data } }
    this.onlineProductPolicy = { findUnique: async () => ({ productId: 'product', enabled: true, product: { id: 'product', isActive: true } }) }
    this.sweetCardCategoryPolicy = { findUnique: async () => null }
    this.identity = { id: 'identity', userId: 'customer', provider: 'WECHAT_MINIPROGRAM', appId: paymentConfig.appId, openId: 'synthetic-open-id' }
    this.identities = [this.identity, { ...this.identity, id: 'other-identity', userId: 'other', openId: 'other-synthetic-open-id' }]
    this.weChatAuthIdentity = {
      findMany: async ({ where }) => this.identities.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)),
      findUnique: async ({ where }) => this.identities.find(row => where.id ? row.id === where.id : Object.entries(where.provider_appId_openId || {}).every(([key, value]) => row[key] === value)) || null,
    }
    this.sweetCardClaim = { findMany: async () => [] }
    this.customerSession = model(this.sessions, 'session')
    this.customerSession.findUnique = async ({ where }) => {
      const row = [...this.sessions.values()].find(r => r.tokenHash === where.tokenHash)
      return row ? { ...row, user: this.users.get(row.userId) } : null
    }
  }
  async $executeRaw() { return 1 }
  async $queryRawUnsafe(sql, key) {
    if (!/^SELECT .* FROM "Store" WHERE key = \$1 FOR SHARE$/.test(sql)) throw Error('SYNTHETIC_SQL_UNEXPECTED')
    this.locks.push(key); this.beforeStoreLock?.(); const s = this.stores.get(key); return s ? [{ ...s }] : []
  }
  async $transaction(fn) {
    const old = structuredClone({ quotes: this.quotes, settlements: this.settlements, tenders: this.tenders })
    try { return await fn(this) } catch (error) {
      for (const name of ['quotes', 'settlements', 'tenders']) { this[name].clear(); for (const [id, row] of old[name]) this[name].set(id, row) }
      throw error
    }
  }
  facts() { return structuredClone({ quotes: [...this.quotes.values()], settlements: [...this.settlements.values()], tenders: [...this.tenders.values()] }) }
}
function onlineFixture() {
  const db = new OnlineMemory(), env = { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '1', SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST: 'customer,other' }
  let catalogCalls = 0
  const service = createOnlineCheckout(db, { env, wechat: paymentConfig, resolveCatalog: async ({ intent }) => {
    catalogCalls++; return { lines: intent.lines.map(line => ({ ...line, name: '合成商品', unitPriceCents: '100', discountCents: '0' })), shippingCents: '0' }
  } })
  const input = extras => ({ requestKey: uuid(), lines: [{ productId: 'product', skuId: 'sku', quantity: 1 }], fulfillment: 'PICKUP', storeRef: 'chaowai', desiredSweetCardCents: '0', ...extras })
  const quote = extras => service.quote('customer', input(extras))
  return { db, env, service, input, quote, catalogCalls: () => catalogCalls }
}
async function pending(f, extras) { const q = await f.quote(extras), requestKey = uuid(), s = await f.service.submit('customer', { quoteId: q.id, requestKey }); return { q, s, requestKey } }
function payment(f, request) { return createOnlinePaymentService(f.db, paymentConfig, { env: f.env, request }) }

test('新在线自提报价：闭店409，未查目录、未写报价；身份拒绝先于门店信息', async () => {
  const f = onlineFixture(); f.db.stores.get('chaowai').active = false
  const before = f.db.facts(); await assert.rejects(f.quote(), closed); assert.equal(f.catalogCalls(), 0); assert.deepEqual(f.db.facts(), before)
  f.db.users.get('customer').status = 'disabled'; const reads = f.db.storeReads
  await assert.rejects(f.quote(), { status: 401 }); assert.equal(f.db.storeReads, reads)
})
test('原营业店与新增门店可新报价/提交；DELIVERY附带朝外不误判为自提', async () => {
  const f = onlineFixture(); f.db.stores.get('chaowai').active = false
  for (const storeRef of ['tongying', 'guanshe', 'xidan', newStoreKey]) { const q = await f.quote({ storeRef }); assert.equal((await f.service.submit('customer', { quoteId: q.id, requestKey: uuid() })).status, 'PENDING') }
  const q = await f.quote({ fulfillment: 'DELIVERY', addressRef: 'synthetic-address', storeRef: 'chaowai' })
  assert.equal((await f.service.submit('customer', { quoteId: q.id, requestKey: uuid() })).status, 'PENDING')
})
test('关停前报价关停后重新quote/plan/submit，均用保存归属拒绝且保留历史', async () => {
  const f = onlineFixture(), input = f.input(), q = await f.service.quote('customer', input)
  f.db.stores.get('chaowai').active = false; const before = f.db.facts()
  await assert.rejects(f.service.quote('customer', input), closed)
  await assert.rejects(f.service.plan('customer', { quoteId: q.id, requestKey: uuid(), storeRef: 'tongying' }), closed)
  await assert.rejects(f.service.submit('customer', { quoteId: q.id, requestKey: uuid(), storeRef: 'tongying' }), closed)
  assert.deepEqual(f.db.facts(), before)
})
test('R1-01 同键PENDING与PAID恢复原身份状态，不受闭店影响且零新增写入', async () => {
  const f = onlineFixture(), { q, s, requestKey } = await pending(f)
  f.db.stores.get('chaowai').active = false; const before = f.db.facts()
  const writes = f.db.writes.length
  assert.equal((await f.service.submit('customer', { quoteId: q.id, requestKey, storeRef: 'tongying' })).id, s.id)
  assert.equal((await f.service.plan('customer', { quoteId: q.id, requestKey })).settlementId, s.id)
  assert.deepEqual(f.db.facts(), before); assert.equal(f.db.writes.length, writes)
  f.db.settlements.get(s.id).status = 'PAID'
  assert.equal((await f.service.submit('customer', { quoteId: q.id, requestKey })).status, 'PAID')
  assert.equal((await f.service.plan('customer', { quoteId: q.id, requestKey })).settlementId, s.id)
})
test('非所有者旧报价提交/计划不泄露闭店信息', async () => {
  const f = onlineFixture(), q = await f.quote(); f.db.stores.get('chaowai').active = false
  const reads = f.db.storeReads
  for (const action of ['plan', 'submit']) await assert.rejects(f.service[action]('other', { quoteId: q.id, requestKey: uuid() }), error => error.status === 409 && error.code !== 'STORE_CLOSED')
  assert.equal(f.db.storeReads, reads)
})
test('报价后事务内再次核对，可拒绝报价目录查验期间停用，无新增记录', async () => {
  const f = onlineFixture(); f.db.beforeStoreLock = () => { f.db.stores.get('chaowai').active = false }
  await assert.rejects(f.quote(), closed); assert.equal(f.db.quotes.size, 0); assert.deepEqual(f.db.locks, ['chaowai'])
})
test('R1-03 已有朝外待付prepare只查原微信，不返回旧prepay新参数、不取消/改账', async () => {
  const f = onlineFixture(), { s } = await pending(f); f.db.stores.get('chaowai').active = false
  f.db.tenders.values().next().value.prepayId = 'previous-prepay'
  const before = f.db.facts(); let requests = 0
  await assert.rejects(payment(f, async method => { requests++; assert.equal(method, 'GET'); return signed({ code: 'ORDER_NOT_EXIST' }, 404) }).prepare(s.id, 'customer'), closed)
  assert.equal(requests, 1); assert.deepEqual(f.db.facts(), before)
})
test('prepare先验证用户与归属；已完成付款结果在闭店后继续可读', async () => {
  const f = onlineFixture(), { s } = await pending(f); f.db.stores.get('chaowai').active = false
  const reads = f.db.storeReads, p = payment(f, async () => { throw Error('NOT_EXPECTED') })
  await assert.rejects(p.prepare(s.id, 'other'), { status: 404 }); assert.equal(f.db.storeReads, reads)
  f.db.settlements.get(s.id).status = 'PAID'; assert.deepEqual(await p.prepare(s.id, 'customer'), { settlementId: s.id, status: 'PAID' })
})
test('prepare原营业店与新增门店真实合成签名验证/参数生成；新支付不走客户端storeRef', async () => {
  for (const storeRef of ['tongying', 'guanshe', 'xidan', newStoreKey]) {
    const f = onlineFixture(), { s } = await pending(f, { storeRef }), calls = []
    const result = await payment(f, async method => { calls.push(method); return method === 'GET' ? signed({ code: 'ORDER_NOT_EXIST' }, 404) : signed({ prepay_id: 'synthetic-prepay' }) }).prepare(s.id, 'customer')
    assert.equal(result.paymentParameters.package, 'prepay_id=synthetic-prepay'); assert.deepEqual(calls, ['GET', 'POST']); assert.ok(f.db.locks.includes(storeRef))
  }
})
test('prepare查单后与新dispatch标记前再次停用：不发新支付、不改原结算', async () => {
  const f = onlineFixture(), { s } = await pending(f), before = f.db.facts(), calls = []
  const p = payment(f, async method => { calls.push(method); f.db.stores.get('chaowai').active = false; return signed({ code: 'ORDER_NOT_EXIST' }, 404) })
  await assert.rejects(p.prepare(s.id, 'customer'), closed); assert.deepEqual(calls, ['GET']); assert.deepEqual(f.db.facts(), before)
})
test('外部请求已获准后关停：保留原支付尝试/凭证，但不交付新参数、不取消改账', async () => {
  const f = onlineFixture(), { s } = await pending(f), calls = []
  const p = payment(f, async method => { calls.push(method); if (method === 'GET') return signed({ code: 'ORDER_NOT_EXIST' }, 404); f.db.stores.get('chaowai').active = false; return signed({ prepay_id: 'admitted-before-closure' }) })
  await assert.rejects(p.prepare(s.id, 'customer'), closed); assert.deepEqual(calls, ['GET', 'POST']); assert.equal(f.db.settlements.get(s.id).status, 'PENDING')
  const wx = [...f.db.tenders.values()][0]; assert.ok(wx.prepayRequestedAt); assert.equal(wx.prepayId, 'admitted-before-closure')
})
test('闭店后recover已有待付查单继续；无新prepay；非法签名照常拒绝', async () => {
  const f = onlineFixture(), { s } = await pending(f); f.db.stores.get('chaowai').active = false
  const calls = [], p = payment(f, async method => { calls.push(method); return signed({ code: 'ORDER_NOT_EXIST' }, 404) })
  assert.deepEqual(await p.recover(s.id), { settlementId: s.id, status: 'PENDING' }); assert.deepEqual(calls, ['GET'])
  const bad = payment(f, async () => ({ ...signed({ code: 'ORDER_NOT_EXIST' }, 404), rawBody: Buffer.from('{"tampered":true}') }))
  await assert.rejects(bad.recover(s.id), { status: 401 })
})
test('闭店后合法微信付款结果仍结算一次；非法结果不能借闭店绕过验签', async () => {
  const f = onlineFixture(), { s } = await pending(f); f.db.stores.get('chaowai').active = false
  const tender = [...f.db.tenders.values()][0], response = { appid: paymentConfig.appId, mchid: paymentConfig.mchId, trade_type: 'JSAPI', out_trade_no: tender.merchantTradeNo,
    trade_state: 'SUCCESS', transaction_id: 'synthetic-trade', amount: { total: 100, currency: 'CNY' }, payer: { openid: f.db.identity.openId }, success_time: new Date().toISOString() }
  const finalize = createOnlinePaymentFinalizer(f.db, paymentConfig), proof = { ...signed(response), source: 'QUERY' }
  assert.equal((await finalize(proof)).status, 'PAID'); const before = f.db.facts()
  assert.equal((await finalize(proof)).status, 'PAID'); assert.deepEqual(f.db.facts(), before)
  await assert.rejects(finalize({ ...proof, rawBody: Buffer.from('{}') }), { status: 401 })
})

function posFixture({ active = false, key = 'chaowai' } = {}) {
  const db = new MemoryPrisma(); db.stores[0] = { key, name: key === 'chaowai' ? '朝外店' : '合成新增门店', active }; db.orders[0].storeId = key
  return { db, service: new PaymentService(db) }
}
test('POS新Payment按保存order.storeId拒绝；伪造营业storeId不能绕过、无支付/账变', async () => {
  const { db, service } = posFixture(), before = structuredClone(db.orders)
  await assert.rejects(service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'closed-pos-payment', storeId: 'tongying' }), closed)
  assert.equal(db.payments.length, 0); assert.equal(db.paymentLogs.length, 0); assert.deepEqual(db.orders, before)
})
test('POS已发起支付的query/replay与有效回调保留；无效签名仍拒绝；新请求再拒绝', async () => {
  const { db, service } = posFixture({ active: true }), old = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'original-pending', scenario: 'pending' })
  db.stores[0].active = false
  assert.equal((await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'original-pending' })).reused, true)
  assert.equal((await service.queryPayment(old.payment.id)).payment.status, 'pending')
  await assert.rejects(service.handleCallback('mock', { paymentNo: old.payment.paymentNo, signature: 'invalid' }), { status: 401 })
  await service.handleCallback('mock', { signature: 'mock-valid', eventId: 'synthetic-paid-event', paymentNo: old.payment.paymentNo, merchantTradeNo: old.payment.merchantTradeNo, status: 'success', providerTradeNo: 'synthetic-paid-trade' })
  const before = structuredClone(db.orders); await service.handleCallback('mock', { signature: 'mock-valid', eventId: 'synthetic-paid-event', paymentNo: old.payment.paymentNo, merchantTradeNo: old.payment.merchantTradeNo, status: 'success', providerTradeNo: 'synthetic-paid-trade' })
  assert.deepEqual(db.orders, before); assert.equal(db.orders[0].paymentStatus, 'paid')
})
test('POS闭店新退款只允许持久developer，原结果重放保持原权限及门店身份', async () => {
  const { db, service } = posFixture({ active: true })
  db.orders[0].items = [{ id: 'original-item', productId: 'synthetic-product', productNameSnapshot: '合成商品', skuSnapshot: 'SYNTHETIC', unitPrice: 7200n, actualAmount: 7200n, lineAmount: 7200n, discountAmount: 0n, costPriceSnapshot: 0n, quantity: 1 }]
  await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'before-close-success', scenario: 'success' })
  db.stores[0].active = false
  const before = structuredClone({ orders: db.orders, payments: db.payments, refunds: db.refunds })
  for (const role of ['staff', 'admin', 'finance']) {
    db.users.push({ id: role, role, status: 'active' })
    await assert.rejects(service.createRefund({ orderId: 'order-1', requestKey: 'after-close-refund', reason: '隔离合成退款', actorId: role, role: 'developer', storeId: 'tongying' }), { status: 403 })
    assert.deepEqual({ orders: db.orders, payments: db.payments, refunds: db.refunds }, before)
  }
  db.users.push({ id: 'developer', role: 'developer', status: 'active' })
  const first = await service.createRefund({ orderId: 'order-1', requestKey: 'after-close-refund', reason: '隔离合成退款', actorId: 'developer' })
  const again = await service.createRefund({ orderId: 'order-1', requestKey: 'after-close-refund', reason: '隔离合成退款' })
  assert.equal(first.refund.status, 'completed'); assert.equal(first.refund.id, again.refund.id); assert.equal(db.refunds.length, 1)
  assert.equal(db.orders[0].storeId, 'chaowai'); assert.equal(db.orders[0].status, 'refunded'); assert.equal(first.refund.refundAmount, 7200n)
})
test('POS营业店仍可申请支付；事务内Store锁意图存在；闭店不改旧失败付款', async () => {
  const { db, service } = posFixture({ active: true })
  await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'failed-existing-charge', scenario: 'failed' })
  db.stores[0].active = false; const before = structuredClone({ orders: db.orders, payments: db.payments })
  await assert.rejects(service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'fresh-closed-charge' }), closed)
  assert.deepEqual({ orders: db.orders, payments: db.payments }, before); assert.ok(db.storeLocks.includes('chaowai'))
})

test('新增门店 POS 支付沿用原行为；停用拒绝新支付，重启恢复同一归属', async () => {
  const { db, service } = posFixture({ active: true, key: newStoreKey })
  await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'new-store-initial-attempt', scenario: 'failed' })
  db.stores[0].active = false
  const facts = structuredClone({ orders: db.orders, payments: db.payments })
  await assert.rejects(service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'new-store-stopped' }), closed)
  assert.deepEqual({ orders: db.orders, payments: db.payments }, facts)
  db.stores[0].active = true
  const result = await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'new-store-reopened' })
  assert.equal(result.payment.status, 'success')
  assert.equal(db.orders[0].storeId, newStoreKey)
  assert.ok(db.storeLocks.includes(newStoreKey))
})

test('甜意卡营业集合字段保留storeRef/name；朝外历史店名查询不active过滤', async () => {
  const calls = [], stores = ['chaowai', 'tongying', 'guanshe', 'xidan'].map(key => ({ key, name: key === 'chaowai' ? '朝外店' : key, active: key !== 'chaowai' }))
  const db = { store: { findMany: async options => { calls.push(options); return stores.filter(s => options.where.active === undefined || s.active === options.where.active).filter(s => !options.where.key?.in || options.where.key.in.includes(s.key)) } } }
  assert.deepEqual(await listCustomerSweetCardStores({ db }), stores.slice(1).map(s => ({ storeRef: s.key, name: s.name })))
  assert.equal(calls[0].where.active, true); assert.equal(calls[0].where.operationType, 'DIRECT'); assert.equal(calls[0].where.sweetCardPolicy.eligible, true)
  const walletRef = 'synthetic-wallet-0001', claim = { id: walletRef, userId: 'customer', sourceCarrier: 'ELECTRONIC', claimedAt: new Date('2026-10-01T00:00:00Z'), account: { publicCardNo: 'SC-SYNTHETIC-001', initialAmountCents: 10000n, balanceCents: 9900n, status: 'ACTIVE', validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'REQUIRED', binding: { userId: 'customer' }, ledger: [{ type: 'REDEEM', amountCents: -100n, createdAt: new Date('2026-10-12T00:00:00Z'), redemption: { storeIdSnapshot: 'chaowai' } }] } }
  db.sweetCardClaim = { findFirst: async ({ where }) => where.id === walletRef && where.userId === 'customer' ? claim : null }
  const before = structuredClone(claim), history = await getCustomerSweetCard({ userId: 'customer', walletRef, db })
  assert.equal(history.balanceCents, '9900'); assert.equal(history.history[0].storeName, '朝外店'); assert.equal(calls[1].where.active, undefined); assert.deepEqual(claim, before)
  await assert.rejects(getCustomerSweetCard({ userId: 'other', walletRef, db }), { status: 404 })
})
test('甜意卡新核销统一闭店错误；非门店用户先拒绝不泄露门店状态', async () => {
  process.env.SWEET_CARD_ENABLED = '1'; process.env.XIDAN_SWEET_CARD_COMMERCIAL = '1'
  let storeReads = 0
  const user = { id: 'staff', role: 'staff', status: 'active', storeKeys: ['chaowai'], permissions: { modules: { 'store-pos': true } } }
  const tx = { user: { findUnique: async () => user }, store: { findUnique: async () => { storeReads++; return { key: 'chaowai', name: '朝外店', active: false, operationType: 'DIRECT' } } } }
  await assert.rejects(assertNewRedemptionAccess(tx, 'chaowai', 'staff'), closed)
  user.storeKeys = []; const before = storeReads; await assert.rejects(assertNewRedemptionAccess(tx, 'chaowai', 'staff'), { status: 403 }); assert.equal(storeReads, before)
})

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}
test('实际POS新单路由：身份先拒绝；开发者也不得新单；409 code且历史可读', async t => {
  posDb.stores = [{ key: 'chaowai', name: '朝外店', active: false }, ...['tongying', 'guanshe', 'xidan', newStoreKey].map(key => ({ key, name: key, active: true }))]
  posDb.orders[0].storeId = 'chaowai'
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = req.get('x-synthetic-user') === 'other' ? { id: 'other-cashier', role: 'staff', status: 'active', storeKeys: ['chaowai'], permissions: { modules: { 'store-pos': true } } } : req.get('x-synthetic-denied') ? { id: 'staff', role: 'staff', status: 'active', storeKeys: [] } : { id: 'user-1', username: '合成开发者', role: 'developer', status: 'active', storeKeys: [] }; next() }); app.use('/api', posRouter)
  const origin = await listen(t, app), body = { storeId: 'chaowai', checkoutKey: 'synthetic-new-order', items: [{ productId: 'product', quantity: 1 }], businessDate: '2026-10-01' }
  const send = denied => fetch(origin + '/api/pos/orders', { method: 'POST', headers: { 'content-type': 'application/json', ...(denied ? { 'x-synthetic-denied': '1' } : {}) }, body: JSON.stringify(body) })
  assert.equal((await send(true)).status, 403); const r = await send(false); assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: '朝外店已停止营业，请选择其他门店。', code: 'STORE_CLOSED' })
  for (const path of ['/pos/orders/order-1/payments', '/pos/orders/order-1/complete']) {
    const payload = { channel: 'cash', paymentMethod: 'cash', requestKey: 'synthetic-closed-pos-payment', storeId: 'tongying' }
    const response = await fetch(origin + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-user': 'other' }, body: JSON.stringify(payload) })
    assert.equal(response.status, 403); assert.equal((await response.json()).code, undefined)
    const owned = await fetch(origin + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    assert.equal(owned.status, 409); assert.equal((await owned.json()).code, 'STORE_CLOSED'); assert.equal(posDb.payments.length, 0)
  }
  const history = await fetch(origin + '/api/pos/orders/order-1'); assert.equal(history.status, 200); const historic = (await history.json()).order; assert.equal(historic.storeId, 'chaowai'); assert.match(historic.storeName, /朝外/); assert.equal(posDb.orders.length, 1)
  posDb.inventoryItem = { findMany: async () => [{ id: 'product', name: '合成商品', sku: 'SYNTHETIC', isActive: true, salePriceCents: 100n, costPriceCents: 0n }] }
  posDb.inventoryItemCostHistory = { findMany: async () => [{ id: 'synthetic-cost', inventoryItemId: 'product', costPriceCents: 0n }] }
  posDb.order.create = async ({ data, include }) => { const row = { version: 1, createdAt: new Date(), updatedAt: new Date(), discountAmount: 0n, sweetCardAmount: 0n, ...data, items: data.items.create }; posDb.orders.push(row); return posDb.order.findUnique({ where: { id: row.id }, include }) }
  for (const storeId of ['tongying', 'guanshe', 'xidan', newStoreKey]) {
    const r = await fetch(origin + '/api/pos/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, storeId, checkoutKey: 'synthetic-' + storeId }) }); assert.equal(r.status, 201, storeId); assert.equal((await r.json()).order.storeId, storeId)
  }
  assert.equal(posDb.orders.length, 5)
})
test('甜意卡已核销幂等在闭店后只返回既有事实，权限未扩张', async () => {
  process.env.SWEET_CARD_ENABLED = '1'; posDb.stores = [{ key: 'chaowai', name: '朝外店', active: false }]; posDb.orders[0].storeId = 'chaowai'
  const replay = { id: 'synthetic-redemption', orderId: 'order-1', requestKey: 'previous-redemption', amountCents: 100n }, user = { id: 'staff', role: 'staff', status: 'active', storeKeys: ['chaowai'], permissions: { modules: { 'store-pos': true } } }
  posDb.sweetCardRedemption = { findUnique: async () => replay }; posDb.user = { findUnique: async () => user }
  const before = structuredClone(posDb.orders), result = await redeemSweetCard({ orderId: 'order-1', requestKey: 'previous-redemption', actor: { id: 'staff' } })
  assert.equal(result.reused, true); assert.deepEqual(result.redemption, replay); assert.deepEqual(posDb.orders, before)
  user.storeKeys = []; await assert.rejects(redeemSweetCard({ orderId: 'order-1', requestKey: 'previous-redemption', actor: { id: 'staff' } }), { status: 403 })
})
test('平台外部新订单事务闭店保护；历史结算幂等结果不按active隐藏', async () => {
  const { db } = posFixture(), service = new ExternalSettlementService(db), input = { storeId: 'chaowai', actorId: 'staff', actorName: '合成员工', requestKey: 'synthetic-external-new', orderSource: 'MEITUAN', items: [{ productId: 'product', quantity: 1 }] }
  const before = structuredClone(db.orders); await assert.rejects(service.createExternalOrder(input), closed); assert.deepEqual(db.orders, before); assert.equal(db.externalSettlements.length, 0)
  const existing = { id: 'synthetic-settlement', orderId: 'order-1', order: { ...db.orders[0], storeId: 'chaowai', cartHash: 'saved', orderSource: 'MEITUAN', settlementAuthority: 'EXTERNAL' }, status: 'CONFIRMED' }
  assert.deepEqual(await service.replayResult(existing, { storeId: 'chaowai', cartHash: 'saved', dimensions: { orderSource: 'MEITUAN' }, confirm: true, actorId: 'staff' }), { orderId: 'order-1', settlementId: 'synthetic-settlement', reused: true })
})
test('实际online签名会话路由：quote/plan/submit/prepare闭店统一409，status结果链保留', async t => {
  const f = onlineFixture(), { q, s, requestKey } = await pending(f), unused = await f.quote(), gateway = { enabled: true, mode: 'production', appId: paymentConfig.appId, cloudBaseEnvId: 'synthetic-env', gatewaySecret: 'synthetic-gateway-secret-'.repeat(2), markerKey: 'synthetic-marker-'.repeat(2) }
  const session = await createCustomerSession({ userId: 'customer', markerKey: gateway.markerKey, db: f.db }); f.db.stores.get('chaowai').active = false
  const paymentService = payment(f, async method => { assert.equal(method, 'GET'); return signed({ code: 'ORDER_NOT_EXIST' }, 404) })
  const app = express(); app.use(express.json()); const mount = '/api/v2/customer/online-checkout'; app.use(mount, createOnlineCheckoutRouter({ db: f.db, gatewayConfig: gateway, paymentService, wechat: paymentConfig, env: f.env }))
  const origin = await listen(t, app)
  async function send(action, extra = {}, caller = { rawToken: session.rawToken, openId: f.db.identity.openId }) {
    const body = { sessionHash: crypto.createHash('sha256').update(caller.rawToken).digest('hex'), openId: caller.openId, settlementId: s.id, quoteId: q.id, requestKey: uuid(), ...extra }
    const timestamp = String(Date.now()), nonce = uuid(), path = mount + '/' + action, fields = { timestamp, nonce, method: 'POST', requestPath: path, bodyHash: gatewayBodyHash(body), environment: gateway.cloudBaseEnvId, appId: gateway.appId }
    return fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.rawToken}`, 'x-budu-gateway-timestamp': timestamp, 'x-budu-gateway-nonce': nonce, 'x-budu-gateway-environment': gateway.cloudBaseEnvId, 'x-budu-gateway-appid': gateway.appId, 'x-budu-gateway-signature': signProductionGatewayRequest(fields, gateway.gatewaySecret) }, body: JSON.stringify(body) })
  }
  for (const action of ['quote', 'plan-order', 'submit', 'prepare']) { const r = await send(action, action === 'quote' ? { intent: f.input(), catalog: { commerceRef: 'ocd-' + 'a'.repeat(64), expiresAt: new Date(Date.now() + 600000).toISOString() } } : { quoteId: unused.id, storeRef: 'tongying' }); assert.equal(r.status, 409, action); const result = await r.json(); assert.equal(result.code, 'STORE_CLOSED'); assert.equal(result.error, 'STORE_CLOSED'); assert.match(result.message, /朝外店已停止营业/) }
  const recoveryFacts = f.db.facts(), recoveryWrites = f.db.writes.length
  for (const action of ['plan-order', 'submit']) {
    const response = await send(action, { requestKey }); assert.equal(response.status, 200)
    const body = await response.json(); assert.equal(body.result.settlementId, s.id)
    if (action === 'submit') assert.equal(body.result.status, 'PENDING')
  }
  assert.deepEqual(f.db.facts(), recoveryFacts); assert.equal(f.db.writes.length, recoveryWrites)
  const otherSession = await createCustomerSession({ userId: 'other', markerKey: gateway.markerKey, db: f.db }), reads = f.db.storeReads
  for (const action of ['plan-order', 'submit', 'prepare']) {
    const response = await send(action, { storeRef: 'tongying' }, { rawToken: otherSession.rawToken, openId: 'other-synthetic-open-id' })
    assert.equal(response.status, action === 'prepare' ? 404 : 409); const body = await response.json(); assert.notEqual(body.code, 'STORE_CLOSED'); assert.notEqual(body.error, 'STORE_CLOSED')
  }
  assert.equal(f.db.storeReads, reads)
  const cap = await send('capabilities'); assert.equal(cap.status, 200); const c = await cap.json(); assert.deepEqual(c.result.stores.map(s => s.key), ['tongying', 'guanshe', 'xidan', newStoreKey]); assert.ok(c.result.stores.every(s => typeof s.name === 'string'))
  const state = await send('status'); assert.equal(state.status, 200); assert.equal((await state.json()).result.status, 'PENDING')
})

test('实际POS闭店人工善后：新退款/作废/关支付仅真实developer，旧结果与营业店权限保留', async t => {
  const { paymentService } = await import('../server/payments/index.js')
  posDb.stores = [{ key: 'chaowai', name: '朝外店', active: false }, { key: 'tongying', name: '通盈店', active: true }]
  posDb.users = ['developer', 'admin', 'finance', 'staff'].map(role => ({ id: role, role, username: 'synthetic-' + role, status: 'active', storeKeys: ['chaowai', 'tongying'], permissions: { modules: { 'store-pos': true } } }))
  posDb.user = { findUnique: async ({ where }) => posDb.users.find(user => user.id === where.id) || null }
  posDb.sweetCardRedemption = { findUnique: async () => null }
  // This multi-order fixture needs conjunctive orderId + OR semantics; the
  // legacy memory helper's early OR return is intentionally left untouched.
  const originalFindFirst = posDb.payment.findFirst
  posDb.payment.findFirst = async ({ where }) => posDb.payments.find(row => (!where.orderId || row.orderId === where.orderId) && matches(row, where)) || null
  t.after(() => { posDb.payment.findFirst = originalFindFirst })
  const app = express(); app.use(express.json()); app.use((req, res, next) => { const user = posDb.users.find(user => user.id === req.get('x-synthetic-actor')); req.user = user ? { ...user } : null; next() }); app.use('/api', posRouter)
  const origin = await listen(t, app), provider = paymentService.provider('mock'), originalClose = provider.closePayment
  let closeCalls = 0
  provider.closePayment = async function (...args) { closeCalls++; return originalClose.apply(this, args) }
  t.after(() => { provider.closePayment = originalClose })
  const post = async (path, actor, body) => { const response = await fetch(origin + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-actor': actor }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  const addOrder = (storeId = 'chaowai') => {
    const row = { ...new MemoryPrisma().orders[0], id: uuid(), orderNo: uuid(), checkoutKey: uuid(), cashierId: 'staff', storeId,
      items: [{ id: uuid(), productId: 'synthetic-product', productNameSnapshot: '合成商品', skuSnapshot: 'SYNTHETIC', unitPrice: 7200n, actualAmount: 7200n, lineAmount: 7200n, discountAmount: 0n, costPriceSnapshot: 0n, quantity: 1 }] }
    posDb.orders.push(row); return row
  }
  const seedPayment = async (order, scenario) => {
    posDb.stores.find(store => store.key === order.storeId).active = true
    const result = await paymentService.createPayment({ orderId: order.id, channel: 'cash', requestKey: uuid(), scenario })
    if (order.storeId === 'chaowai') posDb.stores[0].active = false
    return result.payment
  }
  const cancelOrder = addOrder(), paidOrder = addOrder(), pendingOrder = addOrder()
  const paid = await seedPayment(paidOrder, 'success'), pending = await seedPayment(pendingOrder, 'pending')
  const before = structuredClone({ orders: posDb.orders, payments: posDb.payments, refunds: posDb.refunds })
  const refundBody = { requestKey: uuid(), reason: '合成退款', actorId: 'developer', role: 'developer', storeId: 'tongying' }
  for (const actor of ['admin', 'finance', 'staff']) {
    assert.equal((await post(`/pos/orders/${paidOrder.id}/refunds`, actor, refundBody)).status, 403)
    assert.equal((await post(`/pos/orders/${cancelOrder.id}/cancel`, actor, { reason: '合成作废', actorId: 'developer' })).status, 403)
    assert.equal((await post(`/pos/payments/${pending.id}/close`, actor, { actorId: 'developer' })).status, 403)
  }
  assert.equal(closeCalls, 0); assert.deepEqual({ orders: posDb.orders, payments: posDb.payments, refunds: posDb.refunds }, before)
  // Query/result processing remains legal under its original cashier authority.
  assert.equal((await post(`/pos/payments/${pending.id}/query`, 'staff', {})).status, 200)
  const refund = await post(`/pos/orders/${paidOrder.id}/refunds`, 'developer', refundBody)
  assert.equal(refund.status, 201); assert.equal(refund.body.refund.status, 'completed')
  const refundedCount = posDb.refunds.length
  assert.equal((await post(`/pos/orders/${paidOrder.id}/refunds`, 'staff', refundBody)).body.refund.id, refund.body.refund.id); assert.equal(posDb.refunds.length, refundedCount)
  assert.equal((await post(`/pos/orders/${cancelOrder.id}/cancel`, 'developer', { reason: '合成作废' })).status, 200)
  assert.equal((await post(`/pos/orders/${cancelOrder.id}/cancel`, 'admin', {})).status, 200)
  assert.equal((await post(`/pos/payments/${pending.id}/close`, 'developer', {})).status, 200); assert.equal(closeCalls, 1)
  assert.equal((await post(`/pos/payments/${pending.id}/close`, 'staff', {})).status, 200); assert.equal(closeCalls, 1)
  const successOrder = addOrder(), succeeded = await seedPayment(successOrder, 'success')
  assert.equal((await post(`/pos/payments/${succeeded.id}/close`, 'staff', {})).status, 409); assert.equal(closeCalls, 1)
  const activeOrder = addOrder('tongying')
  assert.equal((await post(`/pos/orders/${activeOrder.id}/cancel`, 'staff', { reason: '合成作废' })).status, 200)
})


// R1: each persisted identity field is required, even when a caller knows a key.
test('R1-01 过期报价仍恢复真实旧结算；停开支付开关后仍可找回既有身份', async () => {
  const f = onlineFixture(), { q, s, requestKey } = await pending(f)
  f.db.stores.get('chaowai').active = false; f.env.SWEET_CARD_ONLINE_PAYMENT_ENABLED = '0'
  f.db.quotes.get(q.id).expiresAt = new Date(0)
  const before = f.db.facts(), writes = f.db.writes.length
  for (const status of ['PENDING','PAID','CANCELLED','EXPIRED','CLOSING']) {
    f.db.settlements.get(s.id).status = status
    assert.equal((await f.service.plan('customer', { quoteId: q.id, requestKey })).settlementId, s.id)
    assert.equal((await f.service.submit('customer', { quoteId: q.id, requestKey })).status, status)
  }
  f.db.settlements.get(s.id).status = before.settlements[0].status
  assert.deepEqual(f.db.facts(), before); assert.equal(f.db.writes.length, writes)
})
test('R1-01 身份/指纹/namespace关联任一冲突均拒绝，无新交易与闭店状态泄露', async () => {
  for (const [target, field, value] of [
    ['settlement','id','forged'], ['settlement','userId','other'], ['settlement','quoteId','different'],
    ['settlement','requestKey','forged-key'], ['settlement','requestFingerprint','forged'],
    ['settlement','namespace','different'], ['settlement','externalOrderId','different'],
    ['quote','userId','other'], ['snapshot','namespace','different'],
  ]) {
    const f = onlineFixture(), { q, s, requestKey } = await pending(f)
    f.db.stores.get('chaowai').active = false
    const row = target === 'settlement' ? f.db.settlements.get(s.id) : target === 'quote' ? f.db.quotes.get(q.id) : f.db.quotes.get(q.id).snapshot
    row[field] = value
    const before = f.db.facts(), writes = f.db.writes.length, reads = f.db.storeReads
    for (const action of ['plan','submit']) await assert.rejects(f.service[action]('customer',{quoteId:q.id,requestKey}), e => e.status === 409 && e.code !== 'STORE_CLOSED', `${target}.${field} ${action}`)
    assert.deepEqual(f.db.facts(), before); assert.equal(f.db.writes.length, writes); assert.equal(f.db.storeReads, reads)
  }
})
test('R1-01 换key不能把已有报价当成无交易；不存在结算才返回闭店拒绝', async () => {
  const f = onlineFixture(), { q } = await pending(f), unused = await f.quote()
  f.db.stores.get('chaowai').active = false
  const before = f.db.facts(), writes = f.db.writes.length
  for (const action of ['plan','submit']) {
    await assert.rejects(f.service[action]('customer',{quoteId:q.id,requestKey:uuid()}), e => e.status === 409 && e.code !== 'STORE_CLOSED')
    await assert.rejects(f.service[action]('customer',{quoteId:unused.id,requestKey:uuid()}), closed)
  }
  assert.deepEqual(f.db.facts(),before); assert.equal(f.db.writes.length,writes)
})
test('R1-01 过期且无结算的正常店新交易继续拒绝，跨用户旧结算无法查询', async () => {
  const f = onlineFixture(), {q,s,requestKey} = await pending(f), unused = await f.quote({storeRef:'guanshe'})
  f.db.quotes.get(unused.id).expiresAt = new Date(0); f.db.stores.get('chaowai').active = false
  const before=f.db.facts(),writes=f.db.writes.length
  for(const action of ['plan','submit']) {
    await assert.rejects(f.service[action]('customer',{quoteId:unused.id,requestKey:uuid()}), e=>e.status===409 && e.code==='ONLINE_QUOTE_EXPIRED')
    await assert.rejects(f.service[action]('other',{quoteId:q.id,requestKey}), e=>e.status===409 && e.code!=='STORE_CLOSED')
  }
  const p=payment(f,async()=>assert.fail('provider cannot be called by another user'))
  await assert.rejects(p.prepare(s.id,'other'),{status:404});assert.deepEqual(f.db.facts(),before);assert.equal(f.db.writes.length,writes)
})
function successResult(f, s, overrides = {}) {
  const tender = [...f.db.tenders.values()].find(t=>t.settlementId===s.id)
  return { appid: paymentConfig.appId, mchid: paymentConfig.mchId, trade_type:'JSAPI',out_trade_no:tender.merchantTradeNo,
    trade_state:'SUCCESS',transaction_id:'synthetic-r1-success',amount:{total:100,currency:'CNY'},payer:{openid:f.db.identity.openId},success_time:new Date().toISOString(),...overrides }
}
test('R1-03 闭店前已发起且微信SUCCESS：prepare真实验签并落既有收款事实一次，零prepay/close', async () => {
  const f=onlineFixture(),{s}=await pending(f);f.db.stores.get('chaowai').active=false
  const tender=[...f.db.tenders.values()][0];tender.prepayRequestedAt=new Date();tender.prepayId='old-prepay'
  const calls=[],body=successResult(f,s),p=payment(f,async(method,path)=>{calls.push({method,path});return signed(body)})
  assert.deepEqual(await p.prepare(s.id,'customer'),{settlementId:s.id,status:'PAID'})
  assert.deepEqual(calls.map(c=>c.method),['GET']);assert(calls[0].path.includes(tender.merchantTradeNo))
  assert.equal(f.db.settlements.size,1);assert.equal(f.db.tenders.size,1);assert.equal(f.db.settlements.get(s.id).version,2)
  assert.equal(f.db.writes.filter(x=>x==='outbox.create').length,2) // initial PENDING + one PAID
  const after=f.db.facts(),writes=f.db.writes.length
  assert.deepEqual(await p.prepare(s.id,'customer'),{settlementId:s.id,status:'PAID'})
  assert.deepEqual(f.db.facts(),after);assert.equal(f.db.writes.length,writes);assert.equal(calls.length,1)
})
test('R1-03 关闭门店的假签名/金额/商户/app/付款人/交易号拒绝，不记账不发新支付', async () => {
  for(const variant of ['signature','amount','mch','app','payer','trade']) {
    const f=onlineFixture(),{s}=await pending(f);f.db.stores.get('chaowai').active=false
    const body=successResult(f,s)
    if(variant==='amount')body.amount.total=101
    if(variant==='mch')body.mchid='2222222222'
    if(variant==='app')body.appid='wx1111111111111111'
    if(variant==='payer')body.payer.openid='other-synthetic-open-id'
    if(variant==='trade')body.out_trade_no='another-original-trade'
    let reply=signed(body);if(variant==='signature')reply.rawBody=Buffer.from('{}')
    const before=f.db.facts(),writes=f.db.writes.length,calls=[]
    await assert.rejects(payment(f,async method=>{calls.push(method);return reply}).prepare(s.id,'customer'),e=>[401,409].includes(e.status),variant)
    assert.deepEqual(calls,['GET']);assert.deepEqual(f.db.facts(),before);assert.equal(f.db.writes.length,writes)
  }
})
test('R1-03 闭店NOTPAY不交付缓存prepay，USERPAYING只保留PENDING；DELIVERY照常', async () => {
  for(const state of ['NOTPAY','USERPAYING']) {
    const f=onlineFixture(),{s}=await pending(f);f.db.stores.get('chaowai').active=false
    const tender=[...f.db.tenders.values()][0];tender.prepayId='old-prepay';tender.prepayRequestedAt=new Date()
    const before=f.db.facts(),writes=f.db.writes.length,calls=[]
    const work=()=>payment(f,async method=>{calls.push(method);return signed(successResult(f,s,{trade_state:state}))}).prepare(s.id,'customer')
    if(state==='NOTPAY')await assert.rejects(work,closed);else assert.deepEqual(await work(),{settlementId:s.id,status:'PENDING'})
    assert.deepEqual(calls,['GET']);assert.deepEqual(f.db.facts(),before);assert.equal(f.db.writes.length,writes)
  }
  const f=onlineFixture(),{s}=await pending(f,{fulfillment:'DELIVERY',addressRef:'synthetic-address',storeRef:'chaowai'});f.db.stores.get('chaowai').active=false
  const calls=[],r=await payment(f,async method=>{calls.push(method);return method==='GET'?signed({code:'ORDER_NOT_EXIST'},404):signed({prepay_id:'synthetic-delivery'})}).prepare(s.id,'customer')
  assert.equal(r.paymentParameters.package,'prepay_id=synthetic-delivery');assert.deepEqual(calls,['GET','POST'])
})

// The reviewed dynamic-store WorkBuddy candidate stays OUTSIDE this OS build.
// Opt in with its path; the exact hash binds this cross-app regression to it.
const wbPath=process.env.CHAOWAI_R1_WB_CLIENT_PATH
for(const [exists,conflict] of [[true,false],[false,false],[true,true]]) test(`R1-01 WorkBuddy真实客户端+实际签名OS路由：${conflict?'不同key冲突保留待核实引用':exists?'既有PENDING保留查单/取消':'权威无结算才解锁选店'}`, {skip:!wbPath},async t=>{
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(wbPath)).digest('hex'),'200be819d8cce89018a33a4f45725c69361cc5d2cd7a69c83113ca1c74ce6d30')
  const {createOnlineCheckoutClient}=createRequire(import.meta.url)(wbPath)
  const f=onlineFixture(),q=await f.quote(),requestKey=uuid()
  const s=exists?await f.service.submit('customer',{quoteId:q.id,requestKey}):null
  f.db.stores.get('chaowai').active=false
  const gateway={enabled:true,mode:'production',appId:paymentConfig.appId,cloudBaseEnvId:'synthetic-r1-env',gatewaySecret:'synthetic-r1-gateway-'.repeat(3),markerKey:'synthetic-r1-marker-'.repeat(3)}
  const session=await createCustomerSession({userId:'customer',markerKey:gateway.markerKey,db:f.db}),providerCalls=[]
  const paymentService=payment(f,async(method,path)=>{providerCalls.push({method,path});assert.equal(method,'GET');return signed({code:'ORDER_NOT_EXIST'},404)})
  const app=express(),mount='/api/v2/customer/online-checkout';app.use(express.json());app.use(mount,createOnlineCheckoutRouter({db:f.db,gatewayConfig:gateway,paymentService,wechat:paymentConfig,env:f.env}))
  const origin=await listen(t,app),calls=[],responses=[]
  async function send(action,extra){
    const body={sessionHash:crypto.createHash('sha256').update(session.rawToken).digest('hex'),openId:f.db.identity.openId,...extra}
    const timestamp=String(Date.now()),nonce=uuid(),path=mount+'/'+action,fields={timestamp,nonce,method:'POST',requestPath:path,bodyHash:gatewayBodyHash(body),environment:gateway.cloudBaseEnvId,appId:gateway.appId}
    const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${session.rawToken}`,'x-budu-gateway-timestamp':timestamp,'x-budu-gateway-nonce':nonce,'x-budu-gateway-environment':gateway.cloudBaseEnvId,'x-budu-gateway-appid':gateway.appId,'x-budu-gateway-signature':signProductionGatewayRequest(fields,gateway.gatewaySecret)},body:JSON.stringify(body)})
    const result=await response.json();responses.push({action,status:response.status,code:result.code})
    if(!response.ok)throw Object.assign(Error(result.message||result.error),{code:result.code||result.error})
    return result.result
  }
  let saved={schemaVersion:1,userId:'customer',quoteId:q.id,quoteRequestKey:q.requestKey,submitKey:conflict?uuid():requestKey,settlementId:null,intentFingerprint:'synthetic-r1-draft'},removes=0
  const updates=[],pendingStore={read:()=>saved,write:(_,v)=>{saved=v},remove:()=>{removes++;saved=null}}
  const client=createOnlineCheckoutClient({pendingStore,onChange:p=>updates.push(p),wait:async()=>{},requestPayment:async()=>assert.fail('No new WeChat payment'),call:async(action,body)=>{
    calls.push(action)
    if(action==='onlineSubmit'){await send('plan-order',body);return send('submit',body)}
    return send({onlinePrepare:'prepare',onlineStatus:'status',onlineCancel:'cancel'}[action],body)
  }})
  assert.equal(client.bindIdentity('customer'),true)
  const before=f.db.facts(),writes=f.db.writes.length
  await client.check()
  assert.deepEqual(f.db.facts(),before);assert.equal(f.db.writes.length,writes)
  if(conflict){
    assert(saved);assert.equal(saved.settlementId,null);assert.equal(removes,0);assert(!updates.some(p=>p.onlineLocked===false));assert.deepEqual(providerCalls,[]);assert.equal(f.db.settlements.size,1)
    assert(responses.every(r=>r.status===409&&r.code!=='STORE_CLOSED'))
  }else if(exists){
    assert.equal(saved.settlementId,s.id);assert.equal(removes,0);assert(updates.some(p=>p.onlinePaymentCreated===true))
    assert(!updates.some(p=>p.onlineLocked===false));await client.check();assert(calls.includes('onlineStatus'));assert.equal(saved.settlementId,s.id)
    await client.cancel();assert(calls.includes('onlineCancel'));assert.equal(f.db.settlements.get(s.id).status,'CANCELLED');assert.equal(saved.settlementId,s.id)
    assert(providerCalls.every(c=>c.method==='GET'));assert.equal(f.db.settlements.size,1)
  }else{
    assert.equal(saved,null);assert.equal(removes,1);assert(updates.some(p=>p.onlineLocked===false&&p.onlineState==='IDLE'))
    assert.equal(f.db.settlements.size,0);assert.deepEqual(providerCalls,[]);assert.deepEqual(calls,['onlineSubmit','onlineSubmit'])
    assert(responses.every(r=>r.status===409&&r.code==='STORE_CLOSED'))
  }
  client.dispose()
})

test('R1-03 已有provider CLOSED仅复用原可信结果，不额外发起关闭/退款/支付',async()=>{
  const f=onlineFixture(),{s}=await pending(f);f.db.stores.get('chaowai').active=false
  const tender=[...f.db.tenders.values()][0];tender.prepayId='preexisting';tender.prepayRequestedAt=new Date()
  const calls=[],result=await payment(f,async method=>{calls.push(method);return signed(successResult(f,s,{trade_state:'CLOSED'}))}).prepare(s.id,'customer')
  assert.deepEqual(calls,['GET']);assert.deepEqual(result,{settlementId:s.id,status:'CANCELLED'});assert.equal(f.db.settlements.size,1)
})
