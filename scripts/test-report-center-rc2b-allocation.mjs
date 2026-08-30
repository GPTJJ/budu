import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateManualExternalRefund } from '../server/refunds/refund-allocation.js'

function item(id, actualAmount, quantity = 1, extra = {}) {
  return {
    id,
    productNameSnapshot: id,
    quantity,
    actualAmount: BigInt(actualAmount),
    lineAmount: BigInt(actualAmount),
    discountAmount: 0n,
    isGift: false,
    ...extra,
  }
}

function order(items, refunds = []) { return { items, refunds } }

test('BigInt largest-remainder allocation is exact and deterministic', () => {
  const input = order([item('b', 100), item('a', 100), item('c', 100)])
  const result = allocateManualExternalRefund(input, [
    { orderItemId: 'b', quantity: 1 },
    { orderItemId: 'a', quantity: 1 },
    { orderItemId: 'c', quantity: 1 },
  ], 100n)
  assert.deepEqual(result.map((row) => [row.orderItemId, row.amountCents]), [['a', 34n], ['b', 33n], ['c', 33n]])
  assert.equal(result.reduce((sum, row) => sum + row.amountCents, 0n), 100n)
})

test('allocation uses BigInt above Number safe range', () => {
  const huge = 9_007_199_254_740_993n
  const result = allocateManualExternalRefund(order([item('a', huge), item('b', huge + 2n)]), [
    { orderItemId: 'a', quantity: 1 }, { orderItemId: 'b', quantity: 1 },
  ], huge)
  assert.equal(result.reduce((sum, row) => sum + row.amountCents, 0n), huge)
})

test('pending and completed refund items reserve quantity and amount', () => {
  const input = order([item('a', 300, 3)], [{ status: 'completed', items: [{ orderItemId: 'a', quantity: 1, amountCents: 100n }] }])
  assert.deepEqual(allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 2 }], 200n), [
    { orderItemId: 'a', quantity: 2, amountCents: 200n },
  ])
  assert.throws(() => allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 3 }], 200n), /可退数量不足/)
})

test('failed refund releases quantity and amount', () => {
  const input = order([item('a', 300, 3)], [{ status: 'failed', items: [{ orderItemId: 'a', quantity: 3, amountCents: 300n }] }])
  assert.deepEqual(allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 3 }], 300n), [
    { orderItemId: 'a', quantity: 3, amountCents: 300n },
  ])
})

test('amount cannot exceed selected quantity capacity', () => {
  const input = order([item('a', 101, 2)])
  assert.throws(() => allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 1 }], 51n), /超过所选商品/)
  assert.equal(allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 1 }], 50n)[0].amountCents, 50n)
})

test('gift lines cannot carry monetary refund allocation', () => {
  assert.throws(() => allocateManualExternalRefund(order([item('gift', 0, 1, { isGift: true })]), [
    { orderItemId: 'gift', quantity: 1 },
  ], 1n), /赠送商品没有可退收入金额/)
})

test('duplicate, foreign and malformed selections fail closed', () => {
  const input = order([item('a', 100)])
  assert.throws(() => allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 1 }, { orderItemId: 'a', quantity: 1 }], 50n), /不能重复/)
  assert.throws(() => allocateManualExternalRefund(input, [{ orderItemId: 'foreign', quantity: 1 }], 50n), /不存在于该订单/)
  assert.throws(() => allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 0 }], 50n), /数量不正确/)
})

test('refund amount must be positive and every cent is conserved', () => {
  const input = order([item('a', 1), item('b', 2)])
  assert.throws(() => allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 1 }], 0n), /必须大于 0/)
  const result = allocateManualExternalRefund(input, [{ orderItemId: 'a', quantity: 1 }, { orderItemId: 'b', quantity: 1 }], 2n)
  assert.equal(result.reduce((sum, row) => sum + row.amountCents, 0n), 2n)
})
