import test from 'node:test'
import assert from 'node:assert/strict'
import { productData } from '../server/products.js'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'
import { canOverrideProductSku, validateProductSkuOverride } from '../server/product-sku-authority.js'

const administrator = { id: 'admin-1', role: 'admin', status: 'active' }

test('only active advanced administrators can override before product creation', () => {
  assert.equal(canOverrideProductSku(administrator), true)
  for (const role of ['finance', 'manager', 'staff', 'partner']) {
    assert.throws(() => validateProductSkuOverride('BD-000010', 'BD', { role, status: 'active' }, 'reviewed'), /只有高级管理员/)
  }
  assert.throws(() => validateProductSkuOverride('BD-000010', 'BD', { ...administrator, status: 'disabled' }, 'reviewed'), /只有高级管理员/)
  assert.throws(() => validateProductSkuOverride('TP-000010', 'BD', administrator, 'reviewed'), /格式/)
  assert.throws(() => validateProductSkuOverride('BD-000000', 'BD', administrator, 'reviewed'), /000001/)
  assert.throws(() => validateProductSkuOverride('BD-000010', 'BD', administrator, ''), /原因/)
  assert.deepEqual(validateProductSkuOverride('bd-000010', 'BD', administrator, 'reviewed'), { sku: 'BD-000010', serial: 10 })
})

test('canonical SKU alone permits a new product to be transfer eligible', () => {
  const row = productData({ name: '新品', sku: 'BD-000001', isActive: true, transferEnabled: true,
    salePriceCents: '500', costPriceCents: '100', unit: '颗' })
  assert.equal(row.transferCode, null)
  assert.equal(row.transferEnabled, true)
  assert.equal(row.sku, 'BD-000001')
})

test('migration mapping is deterministic by createdAt then stable ID, independent per prefix', () => {
  const rows = [
    { id: 'z', name: '自有B', category: 'product', sku: 'old-b', createdAt: '2026-01-01T00:00:00Z', isActive: false, transferCode: 'OLD-B', productCategoryName: '太妃糖12口味' },
    { id: 'tp', name: '森醒成品', category: 'product', sku: 'THIRD', createdAt: '2025-01-01T00:00:00Z', isActive: true, productCategoryName: 'pos-森醒' },
    { id: 'a', name: '自有A', category: 'product', sku: null, createdAt: '2026-01-01T00:00:00Z', isActive: true, productCategoryName: '冰淇淋' },
  ]
  const options = { actorUserId: 'migration-actor', reason: 'SKU Authority 1.0', snapshotId: 'synthetic', expectedCount: 3 }
  const first = buildProductSkuPlan(rows, options)
  assert.deepEqual(first, buildProductSkuPlan([...rows].reverse(), options))
  assert.deepEqual(first.mapping.map(({ id, newSku }) => [id, newSku]), [
    ['a', 'BD-000001'], ['z', 'BD-000002'], ['tp', 'TP-000001'],
  ])
  assert.deepEqual(first.counts, { total: 3, BD: 2, TP: 1, missingOldSku: 1, aliases: 2 })
  assert.equal(first.mapping[1].transferCodeAfter, 'OLD-B')
  assert.equal(first.mapping[1].oldSku, 'old-b')
  assert.equal(first.mapping[1].alias, 'OLD-B')
  assert.throws(() => buildProductSkuPlan(rows, { ...options, expectedCount: 178 }), /商品数漂移/)
  assert.throws(() => buildProductSkuPlan([{ ...rows[0], productCategoryName: 'pos-森醒', brand: 'budu' }], { ...options, expectedCount: 1 }), /冲突/)
})
