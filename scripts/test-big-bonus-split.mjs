import test from 'node:test'
import assert from 'node:assert/strict'
import { splitBonusCents } from '../server/v2.js'

// 大单奖「共同值班平分」：订单金额与奖金都要均分，尾差给前面的人，
// 合计必须严格等于原金额（奖金合计 = round(订单金额 × 5%)）。
test('大单奖平分：两人整单', () => {
  assert.deepEqual(splitBonusCents(179400, 2), [89700, 89700])
  assert.deepEqual(splitBonusCents(8970, 2), [4485, 4485])
})

test('大单奖平分：除不尽时尾差给前面的人，合计不变', () => {
  assert.deepEqual(splitBonusCents(100, 3), [34, 33, 33])
  assert.deepEqual(splitBonusCents(8970, 4), [2243, 2243, 2242, 2242])
  const shares = splitBonusCents(179400, 7)
  assert.equal(shares.reduce((a, b) => a + b, 0), 179400)
})

test('大单奖平分：非法输入拒绝', () => {
  assert.throws(() => splitBonusCents(0, 2))
  assert.throws(() => splitBonusCents(100, 0))
  assert.throws(() => splitBonusCents(100, 11))
})
