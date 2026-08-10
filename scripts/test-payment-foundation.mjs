import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentService } from '../server/payments/payment-service.js'
import { MockPaymentProvider } from '../server/payments/providers/mock.js'
import { canTransitionOrder, canTransitionOrderPayment } from '../server/order-state.js'

function matches(row, where = {}) {
  if (where.OR) return where.OR.some((part) => matches(row, part))
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('in' in expected) return expected.in.includes(actual)
      if ('notIn' in expected) return !expected.notIn.includes(actual)
      if ('not' in expected) return actual !== expected.not
    }
    return actual === expected
  })
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment
    else row[key] = value
  }
  row.updatedAt = new Date()
  return row
}

class MemoryPrisma {
  constructor() {
    this.orders = [{
      id: 'order-1', orderNo: 'POS-1', storeId: 'store-1', cashierId: 'user-1', cashierNameSnapshot: '员工1',
      subtotal: 7200n, discountAmount: 0n, payableAmount: 7200n, status: 'pending_payment', paymentStatus: 'unpaid',
      paymentMethod: null, paymentMode: 'mock', checkoutKey: 'checkout-1', cartHash: 'hash', version: 1,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    }]
    this.payments = []
    this.payment = {
      findUnique: async ({ where, include }) => {
        const row = this.payments.find((item) => matches(item, where))
        if (!row) return null
        return include?.order ? { ...row, order: this.orders.find((order) => order.id === row.orderId) } : row
      },
      findFirst: async ({ where }) => this.payments.find((item) => matches(item, where)) || null,
      create: async ({ data }) => {
        const duplicate = this.payments.some((item) => item.requestKey === data.requestKey || item.paymentNo === data.paymentNo || item.merchantTradeNo === data.merchantTradeNo)
        const active = this.payments.some((item) => item.orderId === data.orderId && ['created', 'pending', 'success'].includes(item.status))
        if (duplicate || active) { const error = new Error('unique'); error.code = 'P2002'; throw error }
        const row = {
          providerTradeNo: null, failureCode: '', failureMessage: '', providerMetadata: {}, callbackCount: 0,
          lastCallbackId: '', lastCallbackAt: null, requestedAt: new Date(), paidAt: null, failedAt: null, closedAt: null,
          createdAt: new Date(), updatedAt: new Date(), ...data,
        }
        this.payments.push(row)
        return row
      },
      update: async ({ where, data }) => applyData(this.payments.find((item) => matches(item, where)), data),
      updateMany: async ({ where, data }) => {
        const rows = this.payments.filter((item) => matches(item, where))
        rows.forEach((row) => applyData(row, data))
        return { count: rows.length }
      },
    }
    this.order = {
      findUnique: async ({ where, include }) => {
        const row = this.orders.find((item) => matches(item, where))
        if (!row) return null
        return include ? {
          ...row,
          store: { key: row.storeId, name: '测试门店' },
          items: [],
          payments: [...this.payments].filter((payment) => payment.orderId === row.id).reverse(),
        } : row
      },
      updateMany: async ({ where, data }) => {
        const rows = this.orders.filter((item) => matches(item, where))
        rows.forEach((row) => applyData(row, data))
        return { count: rows.length }
      },
    }
  }

  async $transaction(handler) { return handler(this) }
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
