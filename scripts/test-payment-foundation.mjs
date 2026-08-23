import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentService, paymentMode, sanitizePayload } from '../server/payments/payment-service.js'
import { CashPaymentProvider } from '../server/payments/providers/cash.js'
import { MockPaymentProvider } from '../server/payments/providers/mock.js'
import { RefundReconciler, refundReconcilerEnvConfig } from '../server/payments/refund-reconciler.js'
import { canTransitionOrder, canTransitionOrderPayment } from '../server/order-state.js'

import { MemoryPrisma } from './helpers/memory-prisma.mjs'


async function withMode(mode, fn) {
  const previous = process.env.PAYMENT_MODE
  process.env.PAYMENT_MODE = mode
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_MODE
    else process.env.PAYMENT_MODE = previous
  }
}

test('正式订单与订单支付状态机只允许后端定义的转换', () => {
  assert.equal(canTransitionOrder('draft', 'pending_payment'), true)
  assert.equal(canTransitionOrder('pending_payment', 'paid'), true)
  assert.equal(canTransitionOrder('paid', 'completed'), true)
  assert.equal(canTransitionOrder('completed', 'refunded'), true)
  assert.equal(canTransitionOrder('completed', 'pending_payment'), false)
  assert.equal(canTransitionOrderPayment('failed', 'paid'), true)
  assert.equal(canTransitionOrderPayment('paid', 'failed'), false)
})

test('重复支付请求和重复成功回调只完成一次订单', async () => {
  const db = new MemoryPrisma()
  const service = new PaymentService(db)
  const first = await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-success-1', scenario: 'duplicate_callback' })
  assert.equal(first.payment.status, 'success')
  assert.equal(first.payment.callbackCount, 2)
  assert.equal(first.order.status, 'completed')
  assert.equal(first.order.paymentStatus, 'paid')
  assert.equal(first.order.version, 4)
  const replay = await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-success-1', scenario: 'success' })
  assert.equal(replay.reused, true)
  assert.equal(db.payments.length, 1)
  assert.equal(db.orders[0].version, 4)
})

test('失败和超时不会完成订单，失败后可创建新支付', async () => {
  const db = new MemoryPrisma()
  const service = new PaymentService(db)
  const failed = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'request-failed-1', scenario: 'failed' })
  assert.equal(failed.payment.status, 'failed')
  assert.equal(failed.order.status, 'pending_payment')
  assert.equal(failed.order.paymentStatus, 'failed')
  const failedVersion = failed.order.version
  await service.handleCallback('mock', {
    signature: 'mock-valid',
    eventId: failed.payment.lastCallbackId,
    paymentNo: failed.payment.paymentNo,
    merchantTradeNo: failed.payment.merchantTradeNo,
    status: 'failed',
    failureCode: 'MOCK_FAILED',
    failureMessage: '模拟支付失败',
  })
  assert.equal(db.orders[0].version, failedVersion)
  assert.equal(db.payments[0].callbackCount, 2)
  const retried = await service.createPayment({ orderId: 'order-1', channel: 'alipay', requestKey: 'request-retry-2', scenario: 'success' })
  assert.equal(retried.order.status, 'completed')
  assert.equal(db.payments.length, 2)

  const timeoutDb = new MemoryPrisma()
  const timeoutService = new PaymentService(timeoutDb)
  const timeout = await timeoutService.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-timeout-1', scenario: 'timeout' })
  assert.equal(timeout.payment.status, 'timeout')
  assert.equal(timeout.order.paymentStatus, 'failed')
})

test('处理中支付可查询、关闭，关闭后允许重新支付', async () => {
  const db = new MemoryPrisma()
  const service = new PaymentService(db)
  const pending = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'request-pending-1', scenario: 'pending' })
  assert.equal(pending.payment.status, 'pending')
  assert.equal(pending.order.paymentStatus, 'pending')
  await assert.rejects(
    () => service.createPayment({ orderId: 'order-1', channel: 'alipay', requestKey: 'request-other-channel', scenario: 'success' }),
    /其他渠道/,
  )
  assert.equal(db.payments.length, 1)
  const queried = await service.queryPayment(pending.payment.id)
  assert.equal(queried.payment.status, 'pending')
  const closed = await service.closePayment(pending.payment.id)
  assert.equal(closed.payment.status, 'closed')
  assert.equal(closed.order.paymentStatus, 'unpaid')
  const queriedClosed = await service.queryPayment(pending.payment.id)
  assert.equal(queriedClosed.payment.status, 'closed')
  assert.equal(queriedClosed.order.paymentStatus, 'unpaid')
  const next = await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-after-close', scenario: 'success' })
  assert.equal(next.order.status, 'completed')
})

test('延迟回调最终成功，Mock 验签拒绝非法通知', async () => {
  const db = new MemoryPrisma()
  const service = new PaymentService(db)
  const pending = await service.createPayment({ orderId: 'order-1', channel: 'alipay', requestKey: 'request-delayed-1', scenario: 'delayed_success', callbackDelayMs: 20 })
  assert.equal(pending.payment.status, 'pending')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const done = await service.result(pending.payment.id)
  assert.equal(done.payment.status, 'success')
  assert.equal(done.order.status, 'completed')
  await assert.rejects(() => new MockPaymentProvider().verifyCallback({ paymentNo: 'x' }), /验签失败/)
})

test('扫码付款码只传给 Provider 内存，不进入支付持久化字段', async () => {
  const db = new MemoryPrisma()
  let receivedAuthCode = ''
  class CapturingMockProvider extends MockPaymentProvider {
    async createPayment(payment, options) {
      receivedAuthCode = options.authCode
      return super.createPayment(payment, options)
    }
  }
  const service = new PaymentService(db, new Map([['mock', new CapturingMockProvider()]]))
  const authCode = '134567890123456789'
  const result = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'request-camera-code', scenario: 'success', authCode })
  assert.equal(receivedAuthCode, authCode)
  assert.equal(result.payment.providerMetadata.authCodeReceived, true)
  assert.equal(JSON.stringify(result.payment, (_, value) => typeof value === 'bigint' ? value.toString() : value).includes(authCode), false)
})

test('PAYMENT_MODE 控制 Provider 选择，live 模式现金走 CashProvider', async () => {
  const service = new PaymentService({})
  await withMode('mock', () => {
    assert.equal(paymentMode(), 'mock')
    assert.equal(service.resolveProvider('wechat'), 'mock')
    assert.equal(service.resolveProvider('alipay'), 'mock')
    assert.equal(service.resolveProvider('cash'), 'mock')
  })
  await withMode('live', () => {
    assert.equal(paymentMode(), 'live')
    assert.equal(service.resolveProvider('cash'), 'cash')
    assert.equal(service.resolveProvider('wechat'), 'wechat_pay')
    assert.equal(service.resolveProvider('alipay'), 'alipay')
  })
})

test('live 模式现金支付立即完成，并写入审计日志', async () => {
  await withMode('live', async () => {
    const db = new MemoryPrisma()
    const service = new PaymentService(db)
    const result = await service.createPayment({
      orderId: 'order-1',
      channel: 'cash',
      requestKey: 'request-cash-live-1',
      paymentMethod: 'cashier-confirm',
    })
    assert.equal(result.payment.provider, 'cash')
    assert.equal(result.payment.status, 'success')
    assert.equal(result.payment.paymentMethod, 'cashier-confirm')
    assert.equal(result.order.status, 'completed')
    assert.equal(result.order.paymentStatus, 'paid')
    assert.equal(db.paymentLogs.some((log) => log.event === 'payment.created'), true)
    assert.equal(db.paymentLogs.some((log) => log.event === 'payment.success'), true)
    assert.equal(db.paymentLogs.every((log) => log.storeKey === 'store-1' && log.cashierId === 'user-1'), true)
  })
})

test('Provider 抛错时支付标记 failed、订单回到 failed，可重新支付', async () => {
  await withMode('live', async () => {
    const db = new MemoryPrisma()
    class ExplodingCash extends CashPaymentProvider {
      async createPayment() { throw new Error('POS 终端离线') }
    }
    const service = new PaymentService(db, new Map([['cash', new ExplodingCash()]]))
    await assert.rejects(
      () => service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-explode-1' }),
      /POS 终端离线/,
    )
    const payment = db.payments.find((row) => row.requestKey === 'request-explode-1')
    assert.equal(payment.status, 'failed')
    assert.equal(payment.failureCode, 'PROVIDER_ERROR')
    assert.equal(db.orders[0].paymentStatus, 'failed')
    assert.equal(db.paymentLogs.some((log) => log.event === 'payment.failed'), true)

    const retryService = new PaymentService(db)
    const retried = await retryService.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-explode-retry' })
    assert.equal(retried.order.status, 'completed')
  })
})

test('原始回调落库且敏感字段被脱敏', () => {
  assert.deepEqual(sanitizePayload({ authCode: '134567890123456789', secret: 's3cret', merchantTradeNo: 'MT-1' }), {
    authCode: '[REDACTED]',
    secret: '[REDACTED]',
    merchantTradeNo: 'MT-1',
  })
  assert.equal(sanitizePayload('x'.repeat(30000))?.truncated, true)
})

function refundDb() {
  const db = new MemoryPrisma()
  db.orders = [{
    id: 'refund-order', orderNo: 'POS-R1', storeId: 'store-1', cashierId: 'user-1', cashierNameSnapshot: '员工1',
    subtotal: 18200n, discountAmount: 0n, payableAmount: 18200n, status: 'completed', paymentStatus: 'paid',
    paymentMethod: 'cash', paymentMode: 'cash', checkoutKey: 'ck-r1', cartHash: 'h', version: 1,
    createdAt: new Date(), updatedAt: new Date(), completedAt: new Date(),
    items: [
      { id: 'oi-1', orderId: 'refund-order', productId: 'p-1', productNameSnapshot: '卡皮巴拉布丁', skuSnapshot: 'SKU-1', unitPrice: 7200n, costPriceSnapshot: 2350n, quantity: 2, lineAmount: 14400n },
      { id: 'oi-2', orderId: 'refund-order', productId: 'p-2', productNameSnapshot: '草莓奶油蛋糕', skuSnapshot: 'SKU-2', unitPrice: 3800n, costPriceSnapshot: 1200n, quantity: 1, lineAmount: 3800n },
    ],
  }]
  db.payments = [{
    id: 'pay-r1', paymentNo: 'PAY-R1', orderId: 'refund-order', channel: 'cash', paymentMethod: '', amount: 18200n,
    currency: 'CNY', status: 'success', merchantTradeNo: 'MT-R1', providerTradeNo: 'CASH-R1', provider: 'cash',
    requestKey: 'rk-r1', failureCode: '', failureMessage: '', providerMetadata: {}, callbackCount: 0,
    lastCallbackId: '', lastCallbackAt: null, requestedAt: new Date(), paidAt: new Date(), failedAt: null, closedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  }]
  return db
}

test('整单退款：金额为剩余应付、订单变 refunded、商品明细全部记录', async () => {
  const db = refundDb()
  const service = new PaymentService(db)
  const result = await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-req-full-1', operator: 'dev' })
  assert.equal(result.refund.status, 'completed')
  assert.equal(result.refund.refundAmount, 18200n)
  assert.equal(result.refund.items.length, 2)
  assert.equal(db.orders[0].status, 'refunded')
  assert.equal(db.orders[0].paymentStatus, 'refunded')
  assert.equal(db.payments[0].status, 'refunded')
  assert.equal(db.paymentLogs.some((log) => log.event === 'refund.completed'), true)
})

test('部分退款：按商品退指定数量，第二次补足后订单变 refunded', async () => {
  const db = refundDb()
  const service = new PaymentService(db)
  const first = await service.createRefund({
    orderId: 'refund-order',
    requestKey: 'refund-req-partial-1',
    items: [{ orderItemId: 'oi-1', quantity: 1 }],
    reason: '退一个布丁',
  })
  assert.equal(first.refund.refundAmount, 7200n)
  assert.equal(first.refund.items[0].quantity, 1)
  assert.equal(db.orders[0].status, 'partially_refunded')
  assert.equal(db.orders[0].paymentStatus, 'partially_refunded')

  const second = await service.createRefund({
    orderId: 'refund-order',
    requestKey: 'refund-req-partial-2',
    items: [{ orderItemId: 'oi-1', quantity: 1 }, { orderItemId: 'oi-2', quantity: 1 }],
  })
  assert.equal(second.refund.refundAmount, 11000n)
  assert.equal(db.orders[0].status, 'refunded')
  assert.equal(db.refunds.length, 2)
})

test('退款幂等：相同 requestKey 只创建一条退款；超量退款被拒绝', async () => {
  const db = refundDb()
  const service = new PaymentService(db)
  const first = await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-req-same-1', items: [{ orderItemId: 'oi-1', quantity: 1 }] })
  const replay = await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-req-same-1', items: [{ orderItemId: 'oi-1', quantity: 1 }] })
  assert.equal(db.refunds.length, 1)
  assert.equal(first.refund.id, replay.refund.id)
  await assert.rejects(
    () => service.createRefund({ orderId: 'refund-order', requestKey: 'refund-req-over-1', items: [{ orderItemId: 'oi-1', quantity: 3 }] }),
    /可退数量不足/,
  )
})

test('折扣订单分次退款按行实付金额分摊，累计不多退也不少退', async () => {
  const db = refundDb()
  db.orders[0].subtotal = 303n
  db.orders[0].discountAmount = 45n
  db.orders[0].payableAmount = 258n
  db.orders[0].discountPercent = 85
  db.orders[0].items = [{
    ...db.orders[0].items[0],
    quantity: 3,
    unitPrice: 101n,
    lineAmount: 303n,
    discountAmount: 45n,
    actualAmount: 258n,
  }]
  db.payments[0].amount = 258n
  const service = new PaymentService(db)
  const first = await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-discount-1', items: [{ orderItemId: 'oi-1', quantity: 1 }] })
  const second = await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-discount-2', items: [{ orderItemId: 'oi-1', quantity: 2 }] })
  assert.equal(first.refund.refundAmount, 86n)
  assert.equal(second.refund.refundAmount, 172n)
  assert.equal(first.refund.refundAmount + second.refund.refundAmount, 258n)
  assert.equal(db.orders[0].status, 'refunded')
})

test('未支付订单不可退款', async () => {
  const db = new MemoryPrisma()
  const service = new PaymentService(db)
  await assert.rejects(
    () => service.createRefund({ orderId: 'order-1', requestKey: 'refund-req-pending-1' }),
    /当前订单状态不可退款/,
  )
})

test('sanitizePayload 同时脱敏 authCode 与 auth_code', () => {
  const cleaned = sanitizePayload({ authCode: '130123456789012345', auth_code: '130123456789012345', other: { nestedAuthCode: 'x' } })
  assert.equal(cleaned.authCode, '[REDACTED]')
  assert.equal(cleaned.auth_code, '[REDACTED]')
  assert.equal(cleaned.other.nestedAuthCode, 'x')
})

test('微信退款先 pending，查询 SUCCESS 后才更新订单状态', async () => {
  const db = refundDb()
  db.payments[0].provider = 'wechat_pay'
  const calls = []
  const wechat = {
    async refundPayment(payment, options) {
      calls.push({ type: 'apply', payment, options })
      return { status: 'pending', providerRefundNo: 'WXRF-PENDING' }
    },
    async queryRefund(payment, options) {
      calls.push({ type: 'query', payment, options })
      return { status: 'completed', providerRefundNo: 'WXRF-PENDING' }
    },
  }
  const service = new PaymentService(db, new Map([['wechat_pay', wechat]]))
  const requested = await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-wechat-1', operator: 'tester' })
  assert.equal(requested.refund.status, 'pending')
  assert.equal(db.orders[0].status, 'completed', '受理时不得提前标记订单已退款')
  assert.equal(calls[0].options.totalAmount, 18200n)
  await assert.rejects(
    () => service.createRefund({ orderId: 'refund-order', requestKey: 'refund-wechat-2', operator: 'tester' }),
    /已有退款处理中/,
  )

  const completed = await service.reconcileRefund(requested.refund.id)
  assert.equal(completed.refund.status, 'completed')
  assert.equal(db.orders[0].status, 'refunded')
  assert.equal(db.payments[0].status, 'refunded')
  assert.equal(calls[1].type, 'query')
})

test('同一真实微信订单的多次退款强制间隔一分钟', async () => {
  const db = refundDb()
  db.payments[0].provider = 'wechat_pay'
  const provider = {
    refundPayment: async () => ({ status: 'completed', providerRefundNo: `WXRF-${db.refunds.length + 1}` }),
  }
  const service = new PaymentService(db, new Map([['wechat_pay', provider]]))
  await service.createRefund({ orderId: 'refund-order', requestKey: 'refund-wechat-gap-1', items: [{ orderItemId: 'oi-1', quantity: 1 }] })
  await assert.rejects(
    () => service.createRefund({ orderId: 'refund-order', requestKey: 'refund-wechat-gap-2', items: [{ orderItemId: 'oi-1', quantity: 1 }] }),
    /需间隔 1 分钟/,
  )
})

test('Provider 返回核对提示时 PaymentService 持久化 reconciliation 字段', async () => {
  const db = new MemoryPrisma()
  const capturing = new (class extends MockPaymentProvider {
    async createPayment(payment, options) {
      const base = await super.createPayment(payment, { ...options, scenario: 'pending' })
      return { ...base, reconciliation: { providerStatus: 'USERPAYING', reconciliationRequired: true } }
    }
  })()
  const service = new PaymentService(db, new Map([['mock', capturing], ['cash', new CashPaymentProvider()]]))
  const result = await service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'request-reconciliation-1' })
  assert.equal(result.payment.status, 'pending')
  assert.equal(result.payment.reconciliationRequired, true)
  assert.equal(result.payment.providerStatus, 'USERPAYING')
  assert.equal(db.payments.find((item) => item.id === result.payment.id).queryAttempts, 0)
})

test('微信退款核对器只扫描 pending 微信退款，并限制轮询间隔', async () => {
  const queried = []
  const whereSeen = []
  const service = {
    prisma: { refund: { findMany: async (query) => {
      whereSeen.push(query.where)
      return [{ id: 'refund-pending-1', refundNo: 'RF-PENDING-1' }]
    } } },
    reconcileRefund: async (id) => queried.push(id),
  }
  const reconciler = new RefundReconciler({ service, intervalMs: 5000 })
  await reconciler.tick()
  assert.deepEqual(whereSeen[0], { status: 'pending', payment: { provider: 'wechat_pay' } })
  assert.deepEqual(queried, ['refund-pending-1'])
  assert.equal(refundReconcilerEnvConfig({ WECHAT_REFUND_QUERY_INTERVAL_MS: '1000' }).intervalMs, 30000)
  assert.equal(refundReconcilerEnvConfig({ WECHAT_REFUND_QUERY_INTERVAL_MS: '45000' }).intervalMs, 45000)
})
