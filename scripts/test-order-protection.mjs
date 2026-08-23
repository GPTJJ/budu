// 订单删除/取消保护回归（O / Q 不变量）
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertOrderDeletable, assertOrderCancelable } from '../server/pos-core.js'
import { PaymentService } from '../server/payments/payment-service.js'
import { MemoryPrisma } from './helpers/memory-prisma.mjs'

const order = (overrides = {}) => ({
  id: 'order-1',
  status: 'draft',
  payments: [],
  ...overrides,
})

test('O：存在支付记录的订单禁止删除（不级联清除支付历史）', () => {
  assert.throws(() => assertOrderDeletable(order({ payments: [{ id: 'pay-1' }] })), (error) => error.status === 409)
  assert.throws(() => assertOrderDeletable(order({ status: 'completed', payments: [] })), (error) => error.status === 409)
  assert.throws(() => assertOrderDeletable(order({ status: 'paid', payments: [] })), (error) => error.status === 409)
  assert.throws(() => assertOrderDeletable(order({ status: 'pending_payment', payments: [] })), (error) => error.status === 409)
  assert.throws(() => assertOrderDeletable(order({ status: 'refunded', payments: [] })), (error) => error.status === 409)
  // 无支付记录的草稿订单可删除
  assert.doesNotThrow(() => assertOrderDeletable(order({ status: 'draft', payments: [] })))
})

test('O：未解决微信支付订单禁止取消；终态后可取消', () => {
  const unresolved = { id: 'pay-1', provider: 'wechat_pay', status: 'pending', reconciliationRequired: true }
  assert.throws(() => assertOrderCancelable(order({ status: 'pending_payment' }), unresolved), (error) => error.status === 409)
  assert.throws(() => assertOrderCancelable(order({ status: 'pending_payment' }), { id: 'pay-1', provider: 'wechat_pay', status: 'created' }), (error) => error.status === 409)
  // 明确终态（closed/failed）或不存在未决支付 → 允许取消流程继续
  assert.doesNotThrow(() => assertOrderCancelable(order({ status: 'pending_payment' }), null))
  assert.doesNotThrow(() => assertOrderCancelable(order({ status: 'cancelled' }), unresolved)) // 已取消幂等
})

test('Q：unresolvedWechatPayment 只命中未决微信支付，终态不命中', async () => {
  const db = new MemoryPrisma()
  db.payments.push({
    id: 'pay-pending', orderId: 'order-1', provider: 'wechat_pay', status: 'pending', reconciliationRequired: true,
    paymentNo: 'PAY-P', merchantTradeNo: 'MT-P', requestKey: 'rk-pending-1', amount: 100n, channel: 'wechat',
    requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), providerMetadata: {},
  })
  db.payments.push({
    id: 'pay-closed', orderId: 'order-1', provider: 'wechat_pay', status: 'closed', reconciliationRequired: false,
    paymentNo: 'PAY-C', merchantTradeNo: 'MT-C', requestKey: 'rk-closed-1', amount: 100n, channel: 'wechat',
    requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), providerMetadata: {},
  })
  const service = new PaymentService(db)
  const hit = await service.unresolvedWechatPayment('order-1')
  assert.equal(hit?.id, 'pay-pending')
})

test('Q：未决微信支付存在时，同一订单不可发起其他渠道支付（409 冲突）', async () => {
  const db = new MemoryPrisma()
  db.payments.push({
    id: 'pay-wechat', orderId: 'order-1', provider: 'wechat_pay', status: 'pending', reconciliationRequired: true,
    paymentNo: 'PAY-W', merchantTradeNo: 'MT-W', requestKey: 'rk-wechat-1', amount: 7200n, channel: 'wechat',
    requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), providerMetadata: {},
  })
  const service = new PaymentService(db)
  await assert.rejects(
    () => service.createPayment({ orderId: 'order-1', channel: 'cash', requestKey: 'rk-cash-conflict-1' }),
    (error) => error.status === 409,
  )
})
