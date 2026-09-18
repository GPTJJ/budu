import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOrderPaidNotice, formatBeijingNotificationTime, toCentsText } from '../server/online-order-notice-format.js'

const SETTLEMENT = {
  id: 'os-' + 'a'.repeat(64),
  externalOrderId: 'os-' + 'a'.repeat(64),
  namespace: 'cloudbase-miniprogram',
  totalCents: 13800n,
  createdAt: new Date('2026-09-18T13:05:00.000Z'),
}

const snapshot = (overrides = {}) => ({
  fulfillment: 'DELIVERY',
  commerceIntent: { storeRef: 'sanlitun' },
  lines: [
    { name: '92%生巧克力', quantity: 1 },
    { name: 'NO.1树莓', quantity: 4 },
  ],
  ...overrides,
})

test('NOTICE-01 the merchant sees everything needed to act on a new order', () => {
  const notice = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot(), storeName: '三里屯通盈中心' })
  assert.match(notice.title, /新成交订单/)
  assert.match(notice.title, /138\.00/)
  for (const expected of ['小程序', '三里屯通盈中心', '快递配送', 'os-' + 'a'.repeat(64), '92%生巧克力×1', 'NO.1树莓×4', '¥138.00']) {
    assert.ok(notice.content.includes(expected), `内容缺少：${expected}`)
  }
  // 下单时间按北京时间渲染（2026-09-18T13:05Z = 21:05 +08:00）。
  assert.match(notice.content, /21:05/)
})

test('NOTICE-02 the notice carries no recipient PII', () => {
  const notice = buildOrderPaidNotice({
    settlement: { ...SETTLEMENT, recipient: { contact: '13800000000', address: '朝阳区某路 1 号' } },
    snapshot: snapshot(),
    storeName: '三里屯通盈中心',
  })
  const text = `${notice.title}\n${notice.content}`
  for (const forbidden of ['13800000000', '朝阳区', 'contact', 'address', 'openid', 'OPENID']) {
    assert.equal(text.includes(forbidden), false, `通知不应包含：${forbidden}`)
  }
})

test('NOTICE-03 pickup and delivery are labelled distinctly, and an unknown store degrades honestly', () => {
  const pickup = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot({ fulfillment: 'PICKUP' }) })
  assert.ok(pickup.content.includes('门店自提'))
  assert.equal(pickup.content.includes('快递配送'), false)

  const delivery = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot({ fulfillment: 'DELIVERY' }) })
  assert.ok(delivery.content.includes('快递配送'))

  const unknown = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot() })
  assert.ok(unknown.content.includes('未知门店'))
})

test('NOTICE-04 the item summary is bounded, never a dump of the whole cart', () => {
  const lines = Array.from({ length: 7 }, (_, i) => ({ name: `商品${i + 1}`, quantity: i + 1 }))
  const notice = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot({ lines }) })
  assert.ok(notice.content.includes('商品1×1'))
  assert.ok(notice.content.includes('商品3×3'))
  assert.equal(notice.content.includes('商品4×4'), false, '第四条起不应展开')
  assert.ok(notice.content.includes('等 7 件'))

  const empty = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot({ lines: [] }) })
  assert.ok(empty.content.includes('（商品明细待同步）'))
})

test('NOTICE-05 an over-long product name is truncated rather than pasted whole', () => {
  const notice = buildOrderPaidNotice({ settlement: SETTLEMENT, snapshot: snapshot({ lines: [{ name: '长'.repeat(200), quantity: 1 }] }) })
  assert.equal(notice.content.includes('长'.repeat(41)), false)
  assert.ok(notice.content.includes('长'.repeat(40)))
})

test('NOTICE-06 money is rendered from cents without float drift', () => {
  assert.equal(toCentsText(0n), '0.00')
  assert.equal(toCentsText(5n), '0.05')
  assert.equal(toCentsText(100n), '1.00')
  assert.equal(toCentsText(13800n), '138.00')
  assert.equal(toCentsText('13800'), '138.00')
  assert.equal(toCentsText(999999999n), '9999999.99')
  assert.equal(buildOrderPaidNotice({ settlement: { ...SETTLEMENT, totalCents: 5n }, snapshot: snapshot() }).title.includes('¥0.05'), true)
})

test('NOTICE-07 an unparseable order time renders empty instead of "Invalid Date"', () => {
  assert.equal(formatBeijingNotificationTime('not-a-date'), '')
  assert.equal(formatBeijingNotificationTime(null), '')
  const notice = buildOrderPaidNotice({ settlement: { ...SETTLEMENT, createdAt: 'nope' }, snapshot: snapshot() })
  assert.equal(notice.content.includes('Invalid Date'), false)
})
