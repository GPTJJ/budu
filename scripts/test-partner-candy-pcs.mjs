import assert from 'node:assert/strict'
import test from 'node:test'
import { PARTNER_CANDY_CATEGORY_IDS, isPartnerCandy } from '../shared/partnerProductUnits.js'
import { productData } from '../server/products.js'
import { isCatalogueEligible, quotePartnerCatalogueItem } from '../server/partner-replenishment-catalogue.js'
import { planPartnerCatalogueInitialization, initializationReceiptAction } from './helpers/partner-catalogue-initialization.mjs'

const base = { updatedAt: new Date('2026-09-20T00:00:00Z'), id: 'a', name: '任意名称', sku: 'CANDY-A', category: 'product', productCategoryId: PARTNER_CANDY_CATEGORY_IDS[0], isActive: false, unit: '份', salePriceCents: '500', partnerSupplyEnabled: true, partnerReplenishmentEnabled: false, partnerOrderUnit: null, partnerMinOrderBaseQty: null, partnerOrderStepBaseQty: null }

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

test('initializer reuses canonical SKU helper, does not alter existing SKU/other products, uses native units only for noncandy', () => {
  const source = [{ ...base, sku: null }, { ...base, id: 'b', sku: null, productCategoryId: 'choc' }, { ...base, id: 'existing', sku: 'BUDU-12Y-77', partnerSupplyEnabled: false }]
  const before = structuredClone(source)
  const plan = planPartnerCatalogueInitialization(source)
  assert.deepEqual(source, before)
  assert.deepEqual(plan.rows.map(r => r.after.sku), ['BUDU-12Y-78', 'BUDU-12Y-79'])
  assert.deepEqual(plan.rows.map(r => r.after.partnerOrderUnit), ['PCS', 'NATIVE'])
  assert.equal(new Set([...source.filter(p => p.sku).map(p => p.sku), ...plan.rows.map(r => r.after.sku)]).size, 3)
  assert.equal(plan.rows.some(r => r.id === 'existing'), false)
})

test('one-time completion never reapplies or reopens manual OFF; interrupted receipt blocks', () => {
  assert.equal(initializationReceiptAction(null), 'APPLY')
  const manuallyDisabled = { ...base, partnerReplenishmentEnabled: false }
  const receipt = { status: 'COMPLETE' }
  if (initializationReceiptAction(receipt) === 'APPLY') manuallyDisabled.partnerReplenishmentEnabled = true
  assert.equal(manuallyDisabled.partnerReplenishmentEnabled, false)
  assert.throws(() => initializationReceiptAction({ status: 'STARTED' }), /RECONCILIATION/)
})
