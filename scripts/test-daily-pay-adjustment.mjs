import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDailyPayOverride } from '../src/utils/dailyPayAdjustment.js'

test('未调整时最终工资等于自动工资', () => {
  assert.deepEqual(applyDailyPayOverride(352, null), {
    automaticPay: 352,
    pay: 352,
    salaryAdjustment: 0,
    payAdjustment: null,
  })
})

test('人工调整覆盖当天最终工资并保留快照差额', () => {
  const result = applyDailyPayOverride(352, {
    id: 'dpa-1',
    autoPayCentsSnapshot: 35200,
    adjustedPayCents: 38050,
    reason: '临时加班',
  })
  assert.equal(result.automaticPay, 352)
  assert.equal(result.pay, 380.5)
  assert.equal(result.salaryAdjustment, 28.5)
  assert.equal(result.payAdjustment.autoPaySnapshot, 352)
  assert.equal(result.payAdjustment.recordedDifference, 28.5)
})

test('规则变化后仍以人工设定最终工资为准，实时差额按当前自动工资计算', () => {
  const result = applyDailyPayOverride(360, {
    autoPayCentsSnapshot: 35200,
    adjustedPayCents: 38050,
  })
  assert.equal(result.pay, 380.5)
  assert.equal(result.salaryAdjustment, 20.5)
  assert.equal(result.payAdjustment.recordedDifference, 28.5)
})

test('允许开发者明确将当日工资调整为零', () => {
  const result = applyDailyPayOverride(200, {
    autoPayCentsSnapshot: 20000,
    adjustedPayCents: 0,
  })
  assert.equal(result.pay, 0)
  assert.equal(result.salaryAdjustment, -200)
})
