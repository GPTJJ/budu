import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { PaymentService } from '../server/payments/payment-service.js'
import { PaymentProvider } from '../server/payments/providers/base.js'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'

class PgCandidateAlipay extends PaymentProvider {
  constructor() {
    super('alipay', { supportsQuery: true, supportsCancel: true, supportsRefund: true, supportsRefundQuery: true, ambiguousResultRecovery: true })
    this.releaseRefund = null
  }
  assertAvailable() {}
  async createPayment(payment) {
    return { callbacks: [{ eventId: 'pg-create-pending', paymentNo: payment.paymentNo, merchantTradeNo: payment.merchantTradeNo, status: 'pending' }] }
  }
  async queryPayment(payment) {
    return { callback: { eventId: 'pg-query-success', paymentNo: payment.paymentNo, merchantTradeNo: payment.merchantTradeNo, providerTradeNo: 'ALI-PG-1', status: 'success', amount: payment.amount, currency: 'CNY' } }
  }
  async closePayment(payment) {
    return { callback: { eventId: 'pg-close', paymentNo: payment.paymentNo, merchantTradeNo: payment.merchantTradeNo, status: 'closed' } }
  }
  async refundPayment() {
    return new Promise((resolve) => { this.releaseRefund = () => resolve({ status: 'pending' }) })
  }
  async queryRefund() { return { status: 'pending' } }
}

test('真实 PostgreSQL：支付宝支付幂等、单成功约束与并发退款 guard', async () => {
  const databaseUrl = await createDisposablePgSchema('alipay_candidate')
  const schema = new URL(databaseUrl).searchParams.get('schema')
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const previousMode = process.env.PAYMENT_MODE
  process.env.PAYMENT_MODE = 'live'
  try {
    await prisma.store.create({ data: { key: 'store-1', name: '支付宝候选隔离门店', salesDataSource: 'pos' } })
    await prisma.inventoryItem.create({ data: { id: 'product-a1', name: '支付宝候选商品', sku: 'ALI-CANDIDATE-1', salePriceCents: 7200n, costPriceCents: 2000n, isActive: true } })
    await prisma.order.create({
      data: {
        id: 'order-pay-a1', orderNo: 'POS-ALI-PG-1', storeId: 'store-1', cashierId: 'cashier-1', cashierNameSnapshot: '测试收银员',
        subtotal: 7200n, payableAmount: 7200n, status: 'pending_payment', paymentStatus: 'unpaid', checkoutKey: 'checkout-alipay-pg-1', cartHash: 'cart-alipay-pg-1',
        items: { create: { id: 'oi-a1', productId: 'product-a1', productNameSnapshot: '支付宝候选商品', skuSnapshot: 'ALI-CANDIDATE-1', unitPrice: 7200n, costPriceSnapshot: 2000n, quantity: 1, lineAmount: 7200n, actualAmount: 7200n } },
      },
    })
    const provider = new PgCandidateAlipay()
    const service = new PaymentService(prisma, new Map([['alipay', provider]]))
    const [a, b] = await Promise.all([
      service.createPayment({ orderId: 'order-pay-a1', channel: 'alipay', requestKey: 'alipay-pg-idempotency-1', authCode: '287634438256643948' }),
      service.createPayment({ orderId: 'order-pay-a1', channel: 'alipay', requestKey: 'alipay-pg-idempotency-1', authCode: '287634438256643948' }),
    ])
    assert.equal(a.payment.id, b.payment.id)
    assert.equal(await prisma.payment.count({ where: { orderId: 'order-pay-a1' } }), 1)
    const paid = await service.queryPayment(a.payment.id)
    assert.equal(paid.order.status, 'completed')
    assert.equal(paid.payment.amount, paid.order.payableAmount)
    const auditRows = await prisma.paymentLog.findMany({ where: { paymentId: paid.payment.id }, include: { payment: { select: { provider: true } } } })
    assert.equal(auditRows.some((row) => row.event === 'payment.success'), true)
    assert.equal(auditRows.every((row) => row.payment.provider === 'alipay'), true)

    const firstRefund = service.createRefund({ orderId: 'order-pay-a1', requestKey: 'alipay-pg-refund-a', operator: 'developer' })
    while (await prisma.refund.count({ where: { orderId: 'order-pay-a1' } }) === 0) await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(() => service.createRefund({ orderId: 'order-pay-a1', requestKey: 'alipay-pg-refund-b', operator: 'developer' }), /退款处理中/)
    assert.equal(await prisma.refund.count({ where: { orderId: 'order-pay-a1' } }), 1)
    provider.releaseRefund()
    const pending = await firstRefund
    assert.equal(pending.refund.status, 'pending')
  } finally {
    if (previousMode === undefined) delete process.env.PAYMENT_MODE
    else process.env.PAYMENT_MODE = previousMode
    await prisma.$disconnect()
    if (schema) {
      const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
      try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`) } finally { await admin.$disconnect() }
    }
  }
})
