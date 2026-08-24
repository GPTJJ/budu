import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOrderWhere, composeOrderSummary } from '../server/pos.js'

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

test('订单列表默认隐藏已作废，显式筛选仍可审计查看', () => {
  const developer = { role: 'developer', status: 'active', storeKeys: [] }
  assert.deepEqual(buildOrderWhere(developer, {}).status, { not: 'cancelled' })
  assert.equal(buildOrderWhere(developer, { status: 'cancelled' }).status, 'cancelled')
})
