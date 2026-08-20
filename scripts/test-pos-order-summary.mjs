import assert from 'node:assert/strict'
import test from 'node:test'
import { composeOrderSummary } from '../server/pos.js'

test('订单汇总按已收款金额扣除已完成退款', () => {
  const summary = composeOrderSummary(
    5,
    { _count: { _all: 3 }, _sum: { payableAmount: 35_000n, discountAmount: 2_500n } },
    { _sum: { refundAmount: 7_200n } },
    { _sum: { quantity: 9 } },
    { _sum: { quantity: 2 } },
  )
  assert.deepEqual(summary, {
    recordCount: 5,
    paidOrderCount: 3,
    collectedAmount: '27800',
    grossAmount: '35000',
    refundAmount: '7200',
    discountAmount: '2500',
    itemQuantity: 7,
    averageAmount: '9266',
  })
})

test('空订单汇总不会除零或产生负数', () => {
  const summary = composeOrderSummary(0, {}, { _sum: { refundAmount: 100n } }, {}, {})
  assert.equal(summary.collectedAmount, '0')
  assert.equal(summary.averageAmount, '0')
  assert.equal(summary.itemQuantity, 0)
})
