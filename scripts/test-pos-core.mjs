import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOrderSnapshot, hashCart, normalizeCartItems, normalizeSku, parseCents } from '../server/pos-core.js'
import { cartTotalCents, changeCartQuantity, formatCents, yuanToCents } from '../src/utils/pos.js'

const product = {
  id: 'product-1',
  productId: 'product-1',
  name: '卡皮巴拉布丁',
  sku: 'BUDU-001',
  unit: '份',
  isActive: true,
  salePriceCents: 7200n,
  costPriceCents: 2350n,
}

test('SKU 去除空白并统一大写', () => {
  assert.equal(normalizeSku(' budu - 001 '), 'BUDU-001')
})

test('金额严格按分处理并正确显示', () => {
  assert.equal(parseCents('7200'), 7200n)
  assert.equal(yuanToCents('72.00'), '7200')
  assert.equal(formatCents(7200n), '¥72.00')
  assert.throws(() => yuanToCents('1.999'), /两位小数/)
})

test('连续快速点击不会丢失购物车数量', () => {
  let cart = {}
  for (let i = 0; i < 100; i += 1) cart = changeCartQuantity(cart, product.productId, 1)
  assert.equal(cart[product.productId], 100)
  cart = changeCartQuantity(cart, product.productId, -1)
  assert.equal(cart[product.productId], 99)
  assert.equal(cartTotalCents(cart, [{ ...product, salePriceCents: '7200' }]), 712800n)
})

test('服务端合并重复商品并拒绝客户端伪造价格', () => {
  assert.deepEqual(normalizeCartItems([
    { productId: 'product-1', quantity: 2 },
    { productId: 'product-1', quantity: 3 },
  ]), [{ productId: 'product-1', quantity: 5, gift: false }])
  assert.throws(() => normalizeCartItems([{ productId: 'product-1', quantity: 1, unitPrice: 1 }]), /服务器计算/)
})

test('购物车哈希与传入顺序无关，支持结算幂等', () => {
  const a = normalizeCartItems([{ productId: 'b', quantity: 1 }, { productId: 'a', quantity: 2 }])
  const b = normalizeCartItems([{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }])
  assert.equal(hashCart(a), hashCart(b))
})

test('订单金额与商品快照在创建后保持不变', () => {
  const snapshot = buildOrderSnapshot([product], [{ productId: product.id, quantity: 3 }])
  assert.equal(snapshot.subtotal, 21600n)
  assert.equal(snapshot.payableAmount, 21600n)
  assert.equal(snapshot.discountAmount, 0n)
  assert.equal(snapshot.lines[0].unitPrice, 7200n)
  assert.equal(snapshot.lines[0].costPriceSnapshot, 2350n)
  product.salePriceCents = 9999n
  product.costPriceCents = 999n
  assert.equal(snapshot.lines[0].unitPrice, 7200n)
  assert.equal(snapshot.lines[0].costPriceSnapshot, 2350n)
})

test('非法数量、下架商品和缺失商品被拒绝', () => {
  assert.throws(() => normalizeCartItems([{ productId: 'product-1', quantity: 0 }]), /1-999/)
  assert.throws(() => buildOrderSnapshot([{ ...product, isActive: false }], [{ productId: product.id, quantity: 1 }]), /未上架/)
  assert.throws(() => buildOrderSnapshot([], [{ productId: 'missing', quantity: 1 }]), /不存在/)
})

test('赠送与折扣由服务端统一计算并写入快照', () => {
  const fresh = { ...product, salePriceCents: 7200n, costPriceCents: 2350n }
  const gift = buildOrderSnapshot([fresh], [{ productId: fresh.id, quantity: 2, gift: true }], { discountPercent: 90, remark: '试吃' })
  assert.equal(gift.subtotal, 0n)
  assert.equal(gift.payableAmount, 0n)
  assert.equal(gift.discountAmount, 0n)
  assert.equal(gift.lines[0].isGift, true)
  assert.equal(gift.lines[0].lineAmount, 0n)
  assert.equal(gift.remark, '试吃')

  const discounted = buildOrderSnapshot([fresh], [{ productId: fresh.id, quantity: 2 }], { discountPercent: 85 })
  assert.equal(discounted.subtotal, 14400n)
  assert.equal(discounted.payableAmount, 12240n)
  assert.equal(discounted.discountAmount, 2160n)
  assert.equal(discounted.discountPercent, 85)
  assert.throws(() => buildOrderSnapshot([product], [{ productId: product.id, quantity: 1 }], { discountPercent: 101 }), /折扣/)
  assert.throws(() => buildOrderSnapshot([product], [{ productId: product.id, quantity: 1 }], { discountPercent: 0 }), /折扣/)
})

test('赠送状态计入归一化与购物车哈希', () => {
  assert.deepEqual(normalizeCartItems([
    { productId: 'product-1', quantity: 1, gift: true },
    { productId: 'product-1', quantity: 2, gift: false },
  ]), [{ productId: 'product-1', quantity: 3, gift: true }])
  const a = hashCart({ items: [{ productId: 'product-1', quantity: 1, gift: true }], discountPercent: 90, remark: 'x' })
  const b = hashCart({ items: [{ productId: 'product-1', quantity: 1, gift: false }], discountPercent: 90, remark: 'x' })
  const c = hashCart({ items: [{ productId: 'product-1', quantity: 1, gift: true }], discountPercent: 100, remark: 'x' })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})
