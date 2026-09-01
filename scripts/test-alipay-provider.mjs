import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { AlipayProvider } from '../server/payments/providers/alipay.js'
import { AlipayOpenApiClient } from '../server/payments/alipay-client.js'
import { PaymentService, sanitizePayload } from '../server/payments/payment-service.js'
import { MemoryPrisma } from './helpers/memory-prisma.mjs'
import { PaymentReconciler } from '../server/payments/payment-reconciler.js'

const config = {
  enabled: true, configured: true, protocol: 'openapi_v3_barcode', appId: '2026000000000001', sellerId: '2088000000000001',
  endpoint: 'https://openapi-sandbox.dl.alipaydev.com', notifyUrl: 'https://candidate.example/api/payments/alipay/callback',
  enabledStores: ['store-1'], requestTimeoutMs: 1000, privateKey: 'test-only', alipayPublicKey: 'test-only',
}
const payment = () => ({
  id: 'pay-a1', paymentNo: 'PAY-A1', merchantTradeNo: 'BUDUPAYA1', requestKey: 'alipay-request-1',
  amount: 7200n, currency: 'CNY', channel: 'alipay', provider: 'alipay', status: 'created',
})

class FakeClient {
  constructor(responses = [], verified = true) { this.responses = [...responses]; this.calls = []; this.verified = verified }
  async request(path, body, requestId) {
    this.calls.push({ path, body, requestId })
    const next = this.responses.shift()
    if (next instanceof Error) throw next
    return next
  }
  verifyNotification() { return this.verified }
}

test('付款码支付使用 V3 trade/pay 且成功金额交叉核对', async () => {
  const client = new FakeClient([{ out_trade_no: 'BUDUPAYA1', trade_no: 'ALI-T-1', total_amount: '72.00', seller_id: config.sellerId }])
  const provider = new AlipayProvider({ config, client })
  const result = await provider.createPayment(payment(), { authCode: '287634438256643948' })
  assert.equal(client.calls[0].path, '/v3/alipay/trade/pay')
  assert.equal(client.calls[0].body.scene, 'bar_code')
  assert.equal(client.calls[0].body.total_amount, '72.00')
  assert.equal(result.callbacks[0].status, 'success')
  assert.equal(result.callbacks[0].amount, 7200n)
})

test('创建超时、未知响应和金额不匹配都绝不判成功', async () => {
  for (const response of [new Error('timeout'), { code: '20000' }, { trade_no: 'ALI-T-2' }, { trade_no: 'ALI-T-2', total_amount: '71.00' }]) {
    const provider = new AlipayProvider({ config, client: new FakeClient([response]) })
    const result = await provider.createPayment(payment(), { authCode: '287634438256643948' })
    assert.equal(result.callbacks[0].status, 'pending')
  }
})

test('主动查询只接受支付宝明确终态，撤销前先查询避免错撤已成功交易', async () => {
  const paidClient = new FakeClient([{ out_trade_no: 'BUDUPAYA1', trade_no: 'ALI-T-3', total_amount: '72.00', trade_status: 'TRADE_SUCCESS' }])
  const paid = await new AlipayProvider({ config, client: paidClient }).closePayment(payment())
  assert.equal(paid.callback.status, 'success')
  assert.equal(paidClient.calls.length, 1)

  const pendingClient = new FakeClient([
    { out_trade_no: 'BUDUPAYA1', total_amount: '72.00', trade_status: 'WAIT_BUYER_PAY' },
    { out_trade_no: 'BUDUPAYA1', retry_flag: 'N' },
  ])
  const closed = await new AlipayProvider({ config, client: pendingClient }).closePayment(payment())
  assert.equal(closed.callback.status, 'closed')
  assert.equal(pendingClient.calls[1].path, '/v3/alipay/trade/cancel')
})

test('回调必须 RSA2 验签并绑定 app/seller/金额/交易状态', async () => {
  const payload = {
    sign_type: 'RSA2', app_id: config.appId, seller_id: config.sellerId, out_trade_no: 'BUDUPAYA1', trade_no: 'ALI-T-4',
    trade_status: 'TRADE_SUCCESS', total_amount: '72.00', notify_id: 'notify-1', sign: 'test-signature',
  }
  const provider = new AlipayProvider({ config, client: new FakeClient([], true) })
  const verified = await provider.verifyCallback(payload)
  assert.equal(verified.status, 'success')
  assert.equal(verified.amount, 7200n)
  await assert.rejects(() => new AlipayProvider({ config, client: new FakeClient([], false) }).verifyCallback(payload), /验签失败/)
  await assert.rejects(() => provider.verifyCallback({ ...payload, seller_id: '2088000000000002' }), /Seller ID/)
})

test('官方 SDK 对合成 RSA2 通知执行真实密码学验签，篡改金额后拒绝', () => {
  const appKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const platformKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const realConfig = {
    ...config,
    privateKey: appKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    alipayPublicKey: platformKeys.publicKey.export({ type: 'spki', format: 'pem' }),
  }
  const payload = {
    app_id: config.appId, seller_id: config.sellerId, out_trade_no: 'BUDUPAYA1', trade_no: 'ALI-CRYPTO-1',
    trade_status: 'TRADE_SUCCESS', total_amount: '72.00', notify_id: 'notify-crypto-1', sign_type: 'RSA2',
  }
  const content = Object.keys(payload).sort().map((key) => `${key}=${payload[key]}`).join('&')
  payload.sign = crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(platformKeys.privateKey, 'base64')
  const client = new AlipayOpenApiClient(realConfig)
  assert.equal(client.verifyNotification(payload), true)
  assert.equal(client.verifyNotification({ ...payload, total_amount: '71.00' }), false)
})

test('支付宝客户端绝对时限把永久挂起请求收敛为歧义错误', async () => {
  const client = new AlipayOpenApiClient({ ...config, requestTimeoutMs: -1990 }, { sdk: { curl: async () => new Promise(() => {}), checkNotifySignV2: () => false } })
  await assert.rejects(() => client.request('/v3/alipay/trade/query', {}, 'deadline-test'), (error) => error.code === 'ABSOLUTE_DEADLINE' && error.ambiguous === true)
})

test('支付状态权威拒绝金额不符的已验签成功事件，重复事件只完成一次', async () => {
  const db = new MemoryPrisma()
  const client = new FakeClient([new Error('candidate timeout')], true)
  const provider = new AlipayProvider({ config, client })
  const service = new PaymentService(db, new Map([['alipay', provider]]))
  const previous = process.env.PAYMENT_MODE
  process.env.PAYMENT_MODE = 'live'
  try {
    const created = await service.createPayment({ orderId: 'order-1', channel: 'alipay', requestKey: 'alipay-service-1', authCode: '287634438256643948' })
    assert.equal(created.payment.status, 'pending')
    const bad = { eventId: 'ali-event-bad', merchantTradeNo: created.payment.merchantTradeNo, status: 'success', providerTradeNo: 'ALI-T-5', amount: 7100n, currency: 'CNY' }
    await assert.rejects(() => service.applyProviderResult('alipay', bad), /金额不匹配/)
    assert.equal(db.orders[0].status, 'pending_payment')
    const good = { ...bad, eventId: 'ali-event-good', amount: 7200n }
    await service.applyProviderResult('alipay', good)
    await service.applyProviderResult('alipay', good)
    assert.equal(db.orders[0].status, 'completed')
    assert.equal(db.payments[0].status, 'success')
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_MODE
    else process.env.PAYMENT_MODE = previous
  }
})

test('日志脱敏覆盖支付宝签名和买家身份字段', () => {
  const safe = sanitizePayload({ sign: 'signature', buyer_id: 'buyer', buyer_logon_id: 'buyer@example.com', out_trade_no: 'T-1' })
  assert.deepEqual(safe, { sign: '[REDACTED]', buyer_id: '[REDACTED]', buyer_logon_id: '[REDACTED]', out_trade_no: 'T-1' })
})

test('进程在创建响应落库前中断后由支付宝核对器恢复，不创建第二笔 Payment', async () => {
  const db = new MemoryPrisma()
  const provider = new AlipayProvider({
    config,
    client: new FakeClient([
      new Error('connection reset after request'),
      { out_trade_no: '', trade_no: 'unused' },
      { out_trade_no: '', trade_no: 'unused' },
    ]),
  })
  // Provider 查询的精确响应需要在 Payment 创建后才知道商户单号，使用动态客户端。
  provider._client.request = async (path, body) => {
    if (path === '/v3/alipay/trade/pay') throw new Error('connection reset after request')
    return { out_trade_no: body.out_trade_no, trade_no: 'ALI-RECOVERED', total_amount: '72.00', trade_status: 'TRADE_SUCCESS' }
  }
  const service = new PaymentService(db, new Map([['alipay', provider]]))
  const previous = process.env.PAYMENT_MODE
  process.env.PAYMENT_MODE = 'live'
  try {
    const pending = await service.createPayment({ orderId: 'order-1', channel: 'alipay', requestKey: 'alipay-crash-recovery-1', authCode: '287634438256643948' })
    assert.equal(pending.payment.status, 'pending')
    assert.equal(pending.payment.networkAttemptStartedAt instanceof Date, true)
    assert.equal(pending.payment.reconciliationRequired, true)
    const reconciler = new PaymentReconciler({ service, providerName: 'alipay', instanceId: 'alipay-test', reverseAfterMs: 60000 })
    await reconciler.tick()
    assert.equal(db.payments.length, 1)
    assert.equal(db.payments[0].status, 'success')
    assert.equal(db.orders[0].status, 'completed')
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_MODE
    else process.env.PAYMENT_MODE = previous
  }
})

test('支付宝退款受理保持 pending，仅 refund/query 明确成功后推进订单', async () => {
  const db = new MemoryPrisma()
  db.orders = [{
    id: 'order-refund-a', orderNo: 'POS-ALI-R1', storeId: 'store-1', cashierId: 'user-1', cashierNameSnapshot: '员工1',
    subtotal: 7200n, discountAmount: 0n, payableAmount: 7200n, discountPercent: 100,
    status: 'completed', paymentStatus: 'paid', paymentMethod: 'alipay', paymentMode: 'alipay',
    settlementAuthority: 'PAYMENT', version: 1,
    createdAt: new Date(), updatedAt: new Date(), completedAt: new Date(),
    items: [{ id: 'oi-a1', productId: 'p-a1', productNameSnapshot: '测试商品', skuSnapshot: 'SKU-A1', unitPrice: 7200n, actualAmount: 7200n, quantity: 1, isGift: false }],
  }]
  db.payments = [{
    ...payment(), id: 'pay-refund-a', orderId: 'order-refund-a', status: 'success', providerTradeNo: 'ALI-PAID-1',
    networkAttemptStartedAt: new Date(), reconciliationRequired: false, requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  }]
  const client = new FakeClient([
    { out_trade_no: 'BUDUPAYA1', trade_no: 'ALI-PAID-1', total_amount: '72.00', refund_fee: '72.00', fund_change: 'Y' },
    { out_trade_no: 'BUDUPAYA1', trade_no: 'ALI-PAID-1', total_amount: '72.00', refund_amount: '72.00', refund_status: 'REFUND_SUCCESS' },
  ])
  const service = new PaymentService(db, new Map([['alipay', new AlipayProvider({ config, client })]]))
  const requested = await service.createRefund({ orderId: 'order-refund-a', requestKey: 'alipay-refund-request-1', operator: 'developer' })
  assert.equal(requested.refund.status, 'pending')
  assert.equal(db.orders[0].status, 'completed')
  const confirmed = await service.createRefund({ orderId: 'order-refund-a', requestKey: 'alipay-refund-request-1', operator: 'developer' })
  assert.equal(confirmed.refund.status, 'completed')
  assert.equal(db.orders[0].status, 'refunded')
  assert.equal(db.refunds.length, 1)
  assert.equal(client.calls[0].body.out_request_no, db.refunds[0].refundNo)
  assert.equal(client.calls[1].body.out_request_no, db.refunds[0].refundNo)
})

test('支付宝重复点击沿用原 Payment，pending 时禁止切换现金渠道', async () => {
  const db = new MemoryPrisma()
  const client = new FakeClient([new Error('ambiguous')])
  const provider = new AlipayProvider({ config, client })
  const service = new PaymentService(db, new Map([['alipay', provider], ['cash', { assertAvailable() {} }]]))
  const previous = process.env.PAYMENT_MODE
  process.env.PAYMENT_MODE = 'live'
  try {
    const input = { orderId: 'order-1', channel: 'alipay', requestKey: 'alipay-duplicate-click-1', authCode: '287634438256643948' }
    const first = await service.createPayment(input)
    const sameKey = await service.createPayment(input)
    const newKey = await service.createPayment({ ...input, requestKey: 'alipay-duplicate-click-2' })
    assert.equal(first.payment.id, sameKey.payment.id)
    assert.equal(first.payment.id, newKey.payment.id)
    assert.equal(db.payments.length, 1)
    assert.equal(client.calls.length, 1)
    await assert.rejects(() => service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'alipay-switch-cash-1' }), /其他渠道/)
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_MODE
    else process.env.PAYMENT_MODE = previous
  }
})

test('callback 与主动查询并发成功只完成订单一次', async () => {
  const db = new MemoryPrisma()
  db.orders[0].paymentStatus = 'pending'
  db.payments.push({
    ...payment(), orderId: 'order-1', status: 'pending', callbackCount: 0, lastCallbackId: '', lastCallbackAt: null,
    reconciliationRequired: true, networkAttemptStartedAt: new Date(), providerTradeNo: null,
    requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  })
  const service = new PaymentService(db, new Map([['alipay', new AlipayProvider({ config, client: new FakeClient() })]]))
  const base = { merchantTradeNo: 'BUDUPAYA1', status: 'success', providerTradeNo: 'ALI-RACE-1', amount: 7200n, currency: 'CNY' }
  await Promise.all([
    service.applyProviderResult('alipay', { ...base, eventId: 'alipay-query-race' }),
    service.applyProviderResult('alipay', { ...base, eventId: 'alipay-callback-race' }),
  ])
  assert.equal(db.payments[0].status, 'success')
  assert.equal(db.orders[0].status, 'completed')
  assert.equal(db.orders[0].version, 3)
})
