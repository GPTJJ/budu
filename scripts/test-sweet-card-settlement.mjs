import assert from 'node:assert/strict'
import test from 'node:test'
import { SettlementCoordinator } from '../server/settlements/settlement-coordinator.js'
import { prepareSweetCardRefund } from '../server/sweet-card-refunds.js'

test('mixed tender settles only when Sweet Card plus Payment equals payable', async () => {
  const coordinator = new SettlementCoordinator()
  coordinator.completeOrder = async (_tx, order, options) => ({ order, options })
  const tx = { payment: { findUnique: async () => ({ id: 'p', status: 'success', amount: 18000n, orderId: 'o', channel: 'wechat', provider: 'wechat_pay', order: { id: 'o', payableAmount: 68000n, sweetCardAmount: 50000n, settlementAuthority: 'PAYMENT' } }) }, externalSettlement: { count: async () => 0 } }
  const result = await coordinator.settlePayment(tx, { paymentId: 'p' })
  assert.equal(result.options.paymentMethod, 'sweet-card+wechat')
  tx.payment.findUnique = async () => ({ id: 'p', status: 'success', amount: 17999n, orderId: 'o', channel: 'wechat', order: { id: 'o', payableAmount: 68000n, sweetCardAmount: 50000n, settlementAuthority: 'PAYMENT' } })
  await assert.rejects(() => coordinator.settlePayment(tx, { paymentId: 'p' }), /支付组成/)
})

test('pure Sweet Card settlement rejects any parallel Payment fact', async () => {
  const coordinator = new SettlementCoordinator()
  coordinator.completeOrder = async (_tx, order, options) => ({ order, options })
  const tx = { order: { findUnique: async () => ({ id: 'o', payableAmount: 20000n, sweetCardAmount: 20000n, settlementAuthority: 'PAYMENT', sweetCardRedemption: { amountCents: 20000n } }) }, payment: { count: async () => 0 } }
  assert.equal((await coordinator.settleSweetCard(tx, { orderId: 'o' })).options.paymentMethod, 'sweet-card')
  tx.payment.count = async () => 1
  await assert.rejects(() => coordinator.settleSweetCard(tx, { orderId: 'o' }), /存在外部 Payment/)
})

function refundTx({ redeemed = 30000n, priorQuantity = 0, priorSweet = 0n, refundQuantity = 5 } = {}) {
  const state = { update: null, created: null }
  return { state,
    sweetCardRedemption: { findUnique: async () => ({ id: 'r', accountId: 'a', items: [{ id: 'ri', orderItemId: 'oi', redeemedAmountCents: redeemed }] }) },
    refundItem: { findMany: async (query) => query.where.refundId ? [{ id: 'fi', orderItemId: 'oi', quantity: refundQuantity }] : Array.from({ length: priorQuantity }, () => ({ quantity: 1 })) },
    sweetCardRefundItem: { aggregate: async () => ({ _sum: { amountCents: priorSweet } }) },
    sweetCardRefund: { create: async ({ data }) => { state.created = data; return data } },
    refund: { update: async ({ data }) => { state.update = data } },
  }
}

test('full mixed refund restores original Sweet Card portion and sends only provider remainder', async () => {
  const tx = refundTx({ refundQuantity: 5 })
  const result = await prepareSweetCardRefund(tx, { refund: { id: 'f', refundAmount: 50000n, requestKey: 'refund-key' }, order: { id: 'o', items: [{ id: 'oi', quantity: 5 }] } })
  assert.deepEqual(result, { providerRefundAmount: 20000n, sweetCardRefundAmount: 30000n })
  assert.equal(tx.state.created.amountCents, 30000n)
})

test('partial refund restoration is cumulative integer deterministic', async () => {
  const tx = refundTx({ redeemed: 30001n, priorQuantity: 1, priorSweet: 6000n, refundQuantity: 2 })
  const result = await prepareSweetCardRefund(tx, { refund: { id: 'f', refundAmount: 20000n, requestKey: 'refund-key' }, order: { id: 'o', items: [{ id: 'oi', quantity: 5 }] } })
  assert.equal(result.sweetCardRefundAmount, 12000n)
  assert.equal(result.providerRefundAmount, 8000n)
})
