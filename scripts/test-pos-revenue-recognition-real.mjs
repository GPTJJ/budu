import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { buildRecognizedRevenueWhere } from '../server/pos-core.js'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'

const orderData = (id, status, paymentStatus, payableAmount) => ({
  id,
  orderNo: `POS-REVENUE-${id}`,
  storeId: 'chaowai',
  cashierId: 'cashier-1',
  cashierNameSnapshot: '测试收银员',
  subtotal: payableAmount,
  payableAmount,
  businessDate: new Date('2026-08-24T00:00:00.000Z'),
  status,
  paymentStatus,
  checkoutKey: `checkout-${id}`,
  cartHash: `hash-${id}`,
})

const paymentData = (id, status, amount) => ({
  id: `payment-${id}`,
  paymentNo: `PAY-REVENUE-${id}`,
  channel: 'cash',
  amount,
  status,
  merchantTradeNo: `merchant-${id}`,
  provider: 'cash',
  requestKey: `request-${id}`,
})

test('真实 PostgreSQL：营收排除待支付、失败和退款订单', async () => {
  const databaseUrl = await createDisposablePgSchema('pos_revenue')
  const schema = new URL(databaseUrl).searchParams.get('schema')
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    await prisma.store.create({ data: { key: 'chaowai', name: '北京朝外店', salesDataSource: 'pos' } })

    await prisma.order.create({
      data: {
        ...orderData('clean', 'completed', 'paid', 19_800n),
        payments: { create: paymentData('clean', 'success', 19_800n) },
      },
    })
    await prisma.order.create({ data: orderData('pending', 'pending_payment', 'unpaid', 2_500n) })
    await prisma.order.create({
      data: {
        ...orderData('failed', 'pending_payment', 'failed', 3_000n),
        payments: { create: paymentData('failed', 'failed', 3_000n) },
      },
    })
    await prisma.order.create({
      data: {
        ...orderData('refunded', 'refunded', 'refunded', 5_000n),
        payments: { create: paymentData('refunded', 'success', 5_000n) },
      },
    })
    await prisma.refund.create({
      data: {
        id: 'refund-1',
        refundNo: 'RF-REVENUE-1',
        orderId: 'refunded',
        paymentId: 'payment-refunded',
        refundAmount: 5_000n,
        status: 'completed',
        requestKey: 'refund-request-1',
      },
    })

    const recognized = await prisma.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId: 'chaowai' }),
      orderBy: { id: 'asc' },
    })
    assert.deepEqual(recognized.map((order) => order.id), ['clean'])
    assert.equal(recognized.reduce((sum, order) => sum + order.payableAmount, 0n), 19_800n)

    // 覆盖日汇总/商品销量/退款指标使用的嵌套 relation filter 形态。
    assert.deepEqual(await prisma.orderItem.findMany({
      where: { order: { is: buildRecognizedRevenueWhere({ storeId: 'chaowai' }) } },
    }), [])
    assert.equal((await prisma.refund.aggregate({
      where: { status: 'completed', order: { is: { storeId: 'chaowai', status: { not: 'cancelled' } } } },
      _sum: { refundAmount: true },
    }))._sum.refundAmount, 5_000n)
  } finally {
    await prisma.$disconnect()
    if (schema) {
      const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
      } finally {
        await admin.$disconnect()
      }
    }
  }
})
