import test from 'node:test'
import assert from 'node:assert/strict'
import { posDailyMetrics } from '../src/utils/posDaily.js'

test('POS 赠送金额计入折前营业额与优惠金额', () => {
  assert.deepEqual(posDailyMetrics({
    incCents: '5000',
    originalSalesCents: '6500',
    discountCents: '1500',
    refundCents: '0',
    ord: 1,
  }), { inc: 50, rev: 65, dis: 15, ord: 1 })
})

test('旧版汇总缺少折前金额时可由收入、优惠和退款回推', () => {
  assert.deepEqual(posDailyMetrics({
    incCents: '4500',
    discountCents: '1500',
    refundCents: '500',
    ord: 1,
  }), { inc: 45, rev: 65, dis: 15, ord: 1 })
})

