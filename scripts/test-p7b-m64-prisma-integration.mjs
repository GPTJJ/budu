import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { PaymentService } from '../server/payments/payment-service.js'
import { PaymentProvider } from '../server/payments/providers/base.js'
import { SettlementCoordinator } from '../server/settlements/settlement-coordinator.js'

const DATABASE_URL = process.env.P7B_TEST_DATABASE_URL
if (!DATABASE_URL) throw new Error('P7B_TEST_DATABASE_URL must point to a disposable, fully migrated PostgreSQL database')

class CompletedProvider extends PaymentProvider {
  constructor() {
    super('cash', { supportsRefund: true })
  }
  async refundPayment(_payment, input) {
    return { status: 'completed', providerRefundNo: `TEST-${input.refundNo}` }
  }
}

async function seedSweetOrder(prisma, id, { payable = 100n, sweet = payable } = {}) {
  const coordinator = new SettlementCoordinator()
  return prisma.$transaction(async (tx) => {
    await tx.order.create({
      data: {
        id,
        orderNo: `NO-${id}`,
        storeId: 'p7b-store',
        cashierId: 'p7b-principal',
        subtotal: payable,
        payableAmount: payable,
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        checkoutKey: `checkout-${id}`,
        cartHash: `hash-${id}`,
        items: {
          create: {
            id: `oi-${id}`,
            productId: 'p7b-product',
            productNameSnapshot: 'P7B product',
            skuSnapshot: 'P7B-SKU',
            unitPrice: payable,
            costPriceSnapshot: 0n,
            quantity: 1,
            lineAmount: payable,
            actualAmount: payable,
          },
        },
      },
    })
    await tx.sweetCardAccount.create({
      data: {
        id: `sca-${id}`,
        publicCardNo: `CARD-${id}`,
        initialAmountCents: payable,
        balanceCents: payable - sweet,
        validityType: 'ONE_YEAR',
        status: sweet === payable ? 'EXHAUSTED' : 'ACTIVE',
        carrierType: 'ELECTRONIC',
        bindingMode: 'NONE',
      },
    })
    await tx.sweetCardCredential.create({
      data: {
        id: `scc-${id}`,
        accountId: `sca-${id}`,
        publicTokenId: `TOKEN-${id}`,
        tokenHash: `HASH-${id}`,
        tokenCiphertext: `CIPHER-${id}`,
        tokenIv: `IV-${id}`,
        tokenTag: `TAG-${id}`,
        status: 'ACTIVE',
        carrierType: 'ELECTRONIC',
      },
    })
    await tx.sweetCardRedemption.create({
      data: {
        id: `scr-${id}`,
        redemptionNo: `RN-${id}`,
        orderId: id,
        accountId: `sca-${id}`,
        credentialId: `scc-${id}`,
        amountCents: sweet,
        eligibleSubtotalCents: payable,
        ineligibleSubtotalCents: 0n,
        requestKey: `redemption-request-${id}`,
        storeIdSnapshot: 'p7b-store',
        redeemedById: 'p7b-principal',
      },
    })
    await tx.orderItem.update({
      where: { id: `oi-${id}` },
      data: { sweetCardEligibleSnapshot: true, sweetCardRedeemedAmount: sweet },
    })
    await tx.sweetCardRedemptionItem.create({
      data: {
        id: `sri-${id}`,
        redemptionId: `scr-${id}`,
        orderItemId: `oi-${id}`,
        productId: 'p7b-product',
        eligibleSnapshot: true,
        eligibleAmountCents: payable,
        redeemedAmountCents: sweet,
      },
    })
    await tx.sweetCardLedger.create({
      data: {
        id: `scl-redeem-${id}`,
        accountId: `sca-${id}`,
        type: 'REDEEM',
        amountCents: -sweet,
        balanceAfterCents: payable - sweet,
        orderId: id,
        redemptionId: `scr-${id}`,
        requestKey: `ledger-redeem-${id}`,
      },
    })
    await tx.order.update({
      where: { id },
      data: { sweetCardAmount: sweet, paymentStatus: 'pending' },
    })
    if (sweet === payable) {
      return coordinator.settleSweetCard(tx, { orderId: id })
    }
    const payment = await tx.payment.create({
      data: {
        id: `pay-${id}`,
        paymentNo: `PN-${id}`,
        orderId: id,
        channel: 'cash',
        amount: payable - sweet,
        status: 'success',
        merchantTradeNo: `MT-${id}`,
        provider: 'cash',
        requestKey: `payment-request-${id}`,
      },
    })
    return coordinator.settlePayment(tx, { paymentId: payment.id })
  })
}

test('M64 real Prisma path: pure/mixed refund and late failure preserve rail authority', async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  try {
    await prisma.store.create({ data: { key: 'p7b-store', name: 'P7B isolated store' } })
    await prisma.inventoryItem.create({ data: { id: 'p7b-product', name: 'P7B isolated product', salePriceCents: 100n, isActive: true } })

    await seedSweetOrder(prisma, 'pure', { payable: 100n, sweet: 100n })
    const pureService = new PaymentService(prisma, new Map())
    const pure = await pureService.createRefund({ orderId: 'pure', requestKey: 'refund-request-pure', operator: 'p7b' })
    assert.equal(pure.refund.paymentId, null)
    assert.equal(pure.refund.providerRefundAmount, 0n)
    assert.equal(pure.refund.sweetCardRefundAmount, 100n)
    assert.equal(pure.refund.status, 'completed')
    assert.equal(await prisma.payment.count({ where: { orderId: 'pure' } }), 0)
    assert.equal(await prisma.sweetCardRefund.count({ where: { refundId: pure.refund.id } }), 1)
    assert.equal(await prisma.sweetCardLedger.count({ where: { refundId: pure.refund.id, type: 'REFUND' } }), 1)
    assert.equal((await prisma.sweetCardAccount.findUnique({ where: { id: 'sca-pure' } })).balanceCents, 100n)
    const replay = await pureService.createRefund({ orderId: 'pure', requestKey: 'refund-request-pure', operator: 'p7b' })
    assert.equal(replay.refund.id, pure.refund.id)
    assert.equal(await prisma.sweetCardLedger.count({ where: { refundId: pure.refund.id, type: 'REFUND' } }), 1)

    await seedSweetOrder(prisma, 'mixed', { payable: 100n, sweet: 30n })
    const mixedService = new PaymentService(prisma, new Map([['cash', new CompletedProvider()]]))
    const mixed = await mixedService.createRefund({ orderId: 'mixed', requestKey: 'refund-request-mixed', operator: 'p7b' })
    assert.equal(mixed.refund.paymentId, 'pay-mixed')
    assert.equal(mixed.refund.providerRefundAmount, 70n)
    assert.equal(mixed.refund.sweetCardRefundAmount, 30n)
    assert.equal(mixed.refund.status, 'completed')
    assert.equal((await prisma.payment.findUnique({ where: { id: 'pay-mixed' } })).status, 'refunded')
    assert.equal((await prisma.sweetCardAccount.findUnique({ where: { id: 'sca-mixed' } })).balanceCents, 100n)

    await seedSweetOrder(prisma, 'late-failure', { payable: 100n, sweet: 100n })
    const failingService = new PaymentService(prisma, new Map(), {
      async applyCompletedRefund() {
        throw new Error('P7B_FORCED_LATE_REFUND_FAILURE')
      },
    })
    await assert.rejects(
      () => failingService.createRefund({ orderId: 'late-failure', requestKey: 'refund-request-late-failure', operator: 'p7b' }),
      /P7B_FORCED_LATE_REFUND_FAILURE/,
    )
    const failedRefund = await prisma.refund.findUnique({ where: { requestKey: 'refund-request-late-failure' } })
    assert.equal(failedRefund.status, 'pending')
    assert.equal(await prisma.sweetCardLedger.count({ where: { refundId: failedRefund.id, type: 'REFUND' } }), 0)
    assert.equal((await prisma.sweetCardAccount.findUnique({ where: { id: 'sca-late-failure' } })).balanceCents, 0n)
    assert.equal((await prisma.order.findUnique({ where: { id: 'late-failure' } })).status, 'completed')
  } finally {
    await prisma.$disconnect()
  }
})
