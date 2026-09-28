import assert from 'node:assert/strict'
import test from 'node:test'
import { PARTNER_CANDY_CATEGORY_IDS, isPartnerCandy } from '../shared/partnerProductUnits.js'
import { productData } from '../server/products.js'
import { isCatalogueEligible, quotePartnerCatalogueItem } from '../server/partner-replenishment-catalogue.js'

const base = { updatedAt: new Date('2026-09-20T00:00:00Z'), id: 'a', name: '任意名称', sku: 'CANDY-A', category: 'product', productCategoryId: PARTNER_CANDY_CATEGORY_IDS[0], isActive: false, unit: '份', salePriceCents: '500', partnerReplenishmentEnabled: false, partnerOrderUnit: null, partnerMinOrderBaseQty: null, partnerOrderStepBaseQty: null }

test('classification uses category identity, never product name or six-gram weight', () => {
  assert.equal(isPartnerCandy(base), true)
  assert.equal(isPartnerCandy({ ...base, productCategoryId: 'other', name: '糖果', transferPieceWeightGrams: 6 }), false)
})

test('product manager cannot configure candy as KG or NATIVE; PCS retains existing price', () => {
  for (const partnerOrderUnit of ['KG', 'NATIVE']) assert.throws(() => productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit, partnerKgBasePriceCents: '18000' }), /仅支持单颗 PCS/)
  const pcs = productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS' })
  assert.equal(pcs.salePriceCents, 500n)
  assert.equal(pcs.unit, '份')
  assert.equal(pcs.partnerMinOrderBaseQty, 1)
  assert.equal(isCatalogueEligible({ ...base, ...pcs }), true)
  assert.equal(isCatalogueEligible({ ...base, ...pcs, partnerOrderUnit: 'KG', partnerKgBasePriceCents: 18000n }), false)
})

test('candy PCS quote accepts integer pieces and KG is rejected even with stale KG configuration', async () => {
  let product = { ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS' }
  const db = { partner: { findUnique: async () => ({ status: 'ACTIVE', defaultDiscountBps: 6500 }) }, inventoryItem: { findUnique: async () => product } }
  const principal = { partnerId: 'p' }
  const q = await quotePartnerCatalogueItem({ db, principal, body: { productId: 'a', orderUnit: 'PCS', quantityPieces: 23 } })
  assert.equal(q.finalAmountCents, '7475')
  product = { ...product, partnerOrderUnit: 'KG', partnerKgBasePriceCents: 18000n }
  await assert.rejects(quotePartnerCatalogueItem({ db, principal, body: { productId: 'a', orderUnit: 'KG', quantityGrams: 600 } }), e => e.code === 'PARTNER_CANDY_PCS_ONLY')
})
