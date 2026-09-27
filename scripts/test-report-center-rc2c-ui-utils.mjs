import assert from 'node:assert/strict'
import test from 'node:test'
import { entryModeLabel, isExternalOrder, orderSourceLabel, parseYuanToCents, settlementLabel } from '../src/utils/reportCenterPos.js'

test('平台金额输入使用精确十进制分字符串', () => {
  assert.equal(parseYuanToCents('30.25'), '3025')
  assert.equal(parseYuanToCents('1.2'), '120')
  assert.equal(parseYuanToCents('999999999.99'), '99999999999')
  assert.equal(parseYuanToCents('1000000000.00'), null)
  assert.equal(parseYuanToCents('0'), null)
  assert.equal(parseYuanToCents('1.001'), null)
  assert.equal(parseYuanToCents('1e3'), null)
})

test('订单展示只按结算权威和冻结枚举投影', () => {
  const external = { orderSource: 'MEITUAN', entryMode: 'MANUAL_POS', settlementAuthority: 'EXTERNAL' }
  assert.equal(isExternalOrder(external), true)
  assert.equal(orderSourceLabel(external.orderSource), '美团外卖')
  assert.equal(settlementLabel(external), '平台结算')
  assert.equal(entryModeLabel(external.entryMode), 'BUDU POS 人工记录')
  assert.equal(orderSourceLabel('STORE_POS'), '店内')
})
