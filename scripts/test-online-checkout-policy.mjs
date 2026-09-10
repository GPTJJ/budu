import test from 'node:test'
import assert from 'node:assert/strict'
import { cents, availableBalance, onlinePaymentAllowed, quoteOnlineCheckout, allocateOnlineRefund, refundMerchandiseByQuantity } from '../server/online-checkout-policy.js'

const line = (id, price, eligible = true, quantity = 1, discount = 0) => ({ productId: id, skuId: `${id}:sku`, name: id, unitPriceCents: price, quantity, onlineEligible: eligible, discountCents: discount })
const empty = () => ({ eligibleCents: 0, ineligibleCents: 0, shippingCents: 0, sweetCardCents: 0, wechatCents: 0 })

test('rejects lossy/coerced/negative/noncanonical monetary input', () => {
  for (const value of [null, undefined, true, {}, '', '01', ' 1', '1.0', '1e2', -1, -1n, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cents(value))
  }
  assert.equal(cents('123'), 123n)
  assert.equal(cents('2000000000'), 2_000_000_000n)
  assert.throws(() => cents('2000000001'), /AMOUNT_LIMIT/)
  assert.throws(() => cents('9'.repeat(100_000)), /AMOUNT_INVALID/)
})

test('holds reduce available amount; inconsistent holds do not clamp silently', () => {
  assert.equal(availableBalance(100, 90), 10n)
  assert.throws(() => availableBalance(100, 101), /RECONCILIATION_REQUIRED/)
})

test('online rollout is independent, closed by default and empty allowlist is closed', () => {
  assert.equal(onlinePaymentAllowed('user', {}), false)
  assert.equal(onlinePaymentAllowed('user', { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '1' }), false)
  assert.equal(onlinePaymentAllowed('user', { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '1', SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST: 'user2' }), false)
  assert.equal(onlinePaymentAllowed('user', { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '1', SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST: ' user ,user2' }), true)
  assert.equal(onlinePaymentAllowed('', { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '1', SWEET_CARD_ONLINE_PAYMENT_PUBLIC: '1' }), false)
  assert.equal(onlinePaymentAllowed('user', { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '1', SWEET_CARD_ONLINE_PAYMENT_PUBLIC: '1' }), true)
  assert.equal(onlinePaymentAllowed('user', { SWEET_CARD_ONLINE_PAYMENT_ENABLED: '0', SWEET_CARD_ONLINE_PAYMENT_PUBLIC: '1' }), false)
})

test('merchandise only: shipping and blacklisted goods remain WeChat funded', () => {
  const result = quoteOnlineCheckout({ lines: [line('a', 26800), line('b', 500, false)], shippingCents: 1200, availableCents: 99999, desiredSweetCardCents: 99999 })
  assert.equal(result.sweetCardCents, '26800')
  assert.equal(result.wechatCents, '1700')
  assert.equal(result.totalCents, '28500')
})

test('discounted eligible subtotal caps card funding; immutable snapshot is copied', () => {
  const source = line('a', 100, true, 2, 30)
  const result = quoteOnlineCheckout({ lines: [source], shippingCents: 0, availableCents: 200, desiredSweetCardCents: 200 })
  source.unitPriceCents = 500
  assert.equal(result.sweetCardCents, '170')
  assert.equal(result.wechatCents, '0')
  assert.equal(result.lines[0].unitPriceCents, '100')
})

test('WeChat-only does not require card funds; desired use is clamped to authority', () => {
  assert.equal(quoteOnlineCheckout({ lines: [line('a', 100)], shippingCents: 10 }).wechatCents, '110')
  assert.equal(quoteOnlineCheckout({ lines: [line('a', 100)], shippingCents: 0, availableCents: 80, desiredSweetCardCents: 10 }).sweetCardCents, '10')
})

test('rejects missing eligibility/SKU, duplicates, invalid quantity and excessive discounts', () => {
  for (const lines of [[], [line('a', 100), line('a', 100)], [{ ...line('a', 100), onlineEligible: undefined }], [{ ...line('a', 100), skuId: '' }], [line('a', 100, true, 0)], [line('a', 100, true, 1, 101)]]) {
    assert.throws(() => quoteOnlineCheckout({ lines, shippingCents: 0 }))
  }
})

test('aggregate gross and discount remain bounded even when net amount is tiny', () => {
  assert.throws(() => quoteOnlineCheckout({ lines: [line('a', 2_000_000_000, true, 1, 1_999_999_999), line('b', 2_000_000_000, true, 1, 1_999_999_999)], shippingCents: 0 }), /AMOUNT_LIMIT/)
})

test('partial refunds follow original tender, shipping and ineligible refund are WX only', () => {
  const original = { eligibleMerchandiseCents: 10000, merchandiseCents: 12000, shippingCents: 1500, sweetCardCents: 4000, wechatCents: 9500 }
  const result = allocateOnlineRefund({ original, occupied: empty(), requested: { eligibleCents: 2500, ineligibleCents: 500, shippingCents: 1500 } })
  assert.equal(result.sweetCardCents, '1000')
  assert.equal(result.wechatCents, '3500')
})

test('every one-cent split completes exactly; no stranded cent for all small ratios', () => {
  for (let goods = 1; goods <= 70; goods++) for (let card = 0; card <= goods; card++) {
    const original = { eligibleMerchandiseCents: goods, merchandiseCents: goods, shippingCents: 3, sweetCardCents: card, wechatCents: goods + 3 - card }
    const occupied = empty()
    for (let i = 0; i < goods; i++) {
      const result = allocateOnlineRefund({ original, occupied, requested: { eligibleCents: 1, ineligibleCents: 0, shippingCents: 0 } })
      occupied.eligibleCents++
      occupied.sweetCardCents += Number(result.sweetCardCents)
      occupied.wechatCents += Number(result.wechatCents)
      assert.equal(Number(result.sweetCardCents) + Number(result.wechatCents), 1)
    }
    assert.equal(occupied.sweetCardCents, card)
    const freight = allocateOnlineRefund({ original, occupied, requested: { eligibleCents: 0, ineligibleCents: 0, shippingCents: 3 } })
    assert.equal(freight.sweetCardCents, '0')
    assert.equal(freight.wechatCents, '3')
  }
})

test('pending allocations occupy capacity; corrupt original and prior allocations rejected', () => {
  const original = { eligibleMerchandiseCents: 100, merchandiseCents: 100, shippingCents: 0, sweetCardCents: 40, wechatCents: 60 }
  const occupied = { eligibleCents: 90, ineligibleCents: 0, shippingCents: 0, sweetCardCents: 36, wechatCents: 54 }
  assert.throws(() => allocateOnlineRefund({ original, occupied, requested: { eligibleCents: 11, ineligibleCents: 0, shippingCents: 0 } }), /EXCEEDS_REMAINING/)
  assert.throws(() => allocateOnlineRefund({ original, occupied: { ...occupied, sweetCardCents: 35 }, requested: { eligibleCents: 1, ineligibleCents: 0, shippingCents: 0 } }), /RECONCILIATION_REQUIRED/)
  assert.throws(() => allocateOnlineRefund({ original: { ...original, wechatCents: 61 }, occupied: empty(), requested: { eligibleCents: 1, ineligibleCents: 0, shippingCents: 0 } }), /TENDER_INVALID/)
})

test('zero eligible merchandise has no divide-by-zero and cannot refund card value', () => {
  const result = allocateOnlineRefund({ original: { eligibleMerchandiseCents: 0, merchandiseCents: 10, shippingCents: 3, sweetCardCents: 0, wechatCents: 13 }, occupied: empty(), requested: { eligibleCents: 0, ineligibleCents: 10, shippingCents: 3 } })
  assert.equal(result.sweetCardCents, '0')
  assert.equal(result.wechatCents, '13')
})

test('interleaved partial refunds preserve exact original sources', () => {
  const original = { eligibleMerchandiseCents: 97, merchandiseCents: 121, shippingCents: 13, sweetCardCents: 53, wechatCents: 81 }
  const occupied = empty()
  for (const [eligibleCents, ineligibleCents, shippingCents] of [[13, 4, 5], [0, 20, 0], [73, 0, 8], [11, 0, 0]]) {
    const result = allocateOnlineRefund({ original, occupied, requested: { eligibleCents, ineligibleCents, shippingCents } })
    for (const field of Object.keys(occupied)) occupied[field] += Number(result[field])
  }
  assert.equal(occupied.sweetCardCents, 53)
  assert.equal(occupied.wechatCents, 81)
  assert.throws(() => allocateOnlineRefund({ original, occupied: { ...occupied, wechatCents: 80 }, requested: { eligibleCents: 1, ineligibleCents: 0, shippingCents: 0 } }), /RECONCILIATION_REQUIRED/)
})

test('discounted quantities use cumulative net rounding before tender allocation', () => {
  const quote = quoteOnlineCheckout({ lines: [line('a', 10, true, 3, 1)], shippingCents: 0 })
  const amounts = []
  for (let previous = 0; previous < 3; previous++) {
    const part = refundMerchandiseByQuantity({ lines: quote.lines, occupied: [{ productId: 'a', skuId: 'a:sku', quantity: previous }], requested: [{ productId: 'a', skuId: 'a:sku', quantity: 1, amountCents: '999' }] })
    amounts.push(Number(part.eligibleCents))
  }
  assert.deepEqual(amounts, [9, 10, 10])
  assert.equal(amounts.reduce((a, b) => a + b), 29)
})

test('refund quantity intent cannot change eligibility or exceed occupied capacity', () => {
  const quote = quoteOnlineCheckout({ lines: [line('a', 10, false, 2)], shippingCents: 0 })
  const requested = [{ productId: 'a', skuId: 'a:sku', quantity: 1, onlineEligible: true }]
  const result = refundMerchandiseByQuantity({ lines: quote.lines, requested })
  assert.equal(result.eligibleCents, '0')
  assert.equal(result.ineligibleCents, '10')
  assert.throws(() => refundMerchandiseByQuantity({ lines: quote.lines, requested: [...requested, ...requested] }), /QUANTITY_INVALID/)
  assert.throws(() => refundMerchandiseByQuantity({ lines: quote.lines, occupied: [{ productId: 'a', skuId: 'a:sku', quantity: 2 }], requested }), /EXCEEDS_REMAINING/)
})
