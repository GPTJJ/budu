import assert from 'node:assert/strict'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import {
  calculatePartnerAmountCents,
  validatePartnerQuantity,
} from '../server/partner-replenishment-pricing.js'
import {
  listPartnerCatalogue,
  quotePartnerCatalogueItem,
} from '../server/partner-replenishment-catalogue.js'
import { appendPartnerKgPriceAudit, buildPartnerKgPriceAuditData, productData } from '../server/products.js'

const now = new Date('2026-09-06T00:00:00.000Z')
const products = [
  { id: 'kg', name: 'KG 糖', sku: 'KG-1', spec: '散装', unit: 'kg', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'KG', partnerKgBasePriceCents: 18000n, partnerMinOrderBaseQty: 500, partnerOrderStepBaseQty: 250, updatedAt: now, sortOrder: 1, stockQty: 999 },
  { id: 'pcs', name: '颗糖', sku: 'PCS-1', spec: '6g', unit: '颗', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1, updatedAt: now, sortOrder: 2, stockQty: 999 },
  { id: 'inactive', name: '停用', sku: 'OFF-1', spec: '', unit: '份', category: 'product', isActive: false, salePriceCents: 500n, partnerReplenishmentEnabled: false, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1, updatedAt: now, sortOrder: 3 },
  { id: 'kg-missing', name: '缺KG价', sku: 'KG-X', spec: '', unit: 'kg', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'KG', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 1000, partnerOrderStepBaseQty: 500, updatedAt: now, sortOrder: 4 },
  { id: 'pcs-missing', name: '缺颗价', sku: 'PCS-X', spec: '', unit: '颗', category: 'product', isActive: true, salePriceCents: null, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1, updatedAt: now, sortOrder: 5 },
]
const partners = {
  a: { id: 'a', status: 'ACTIVE', defaultDiscountBps: 6500 },
  b: { id: 'b', status: 'ACTIVE', defaultDiscountBps: 8000 },
  paused: { id: 'paused', status: 'PAUSED', defaultDiscountBps: 6500 },
  terminated: { id: 'terminated', status: 'TERMINATED', defaultDiscountBps: 6500 },
}

function fakeDb() {
  return {
    partner: { findUnique: async ({ where }) => partners[where.id] || null },
    inventoryItem: {
      findMany: async () => products.filter((row) => row.category === 'product' && row.isActive && row.partnerReplenishmentEnabled).sort((a, b) => a.sortOrder - b.sortOrder),
      findUnique: async ({ where }) => products.find((row) => row.id === where.id) || null,
    },
  }
}

const principal = (partnerId) => ({ type: 'PARTNER', partnerId })
const quote = (partnerId, body) => quotePartnerCatalogueItem({ db: fakeDb(), principal: principal(partnerId), body })

test('KG and PCS golden vectors use the one authoritative pricing service', () => {
  for (const [grams, cents] of [[500, 5850], [1000, 11700], [1250, 14625], [1500, 17550], [1750, 20475], [2000, 23400], [2350, 27495]]) {
    assert.equal(calculatePartnerAmountCents({ orderUnit: 'KG', quantityBase: grams, basePriceCents: 18000, discountBps: 6500 }), BigInt(cents))
  }
  assert.equal(calculatePartnerAmountCents({ orderUnit: 'PCS', quantityBase: 1, basePriceCents: 500, discountBps: 6500 }), 325n)
  assert.equal(calculatePartnerAmountCents({ orderUnit: 'PCS', quantityBase: 20, basePriceCents: 500, discountBps: 6500 }), 6500n)
  assert.equal(calculatePartnerAmountCents({ orderUnit: 'KG', quantityBase: 500, basePriceCents: 101, discountBps: 3333 }), 17n)
})

test('quantity authority enforces only positive safe integer base units', () => {
  assert.equal(validatePartnerQuantity({ quantityBase: 1500, minimumBase: 1000, stepBase: 500 }), 1500)
  assert.equal(validatePartnerQuantity({ quantityBase: 1200, minimumBase: 1000, stepBase: 500 }), 1200)
  assert.equal(validatePartnerQuantity({ quantityBase: 500, minimumBase: 1000, stepBase: 500 }), 500)
  for (const invalid of [1.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validatePartnerQuantity({ quantityBase: invalid, minimumBase: 1, stepBase: 1 }))
  }
})

test('shared catalogue is product-authority filtered and never leaks inventory or cost', async () => {
  const [a, b] = await Promise.all([
    listPartnerCatalogue({ db: fakeDb(), principal: principal('a') }),
    listPartnerCatalogue({ db: fakeDb(), principal: principal('b') }),
  ])
  assert.deepEqual(a.map((row) => row.productId), ['kg', 'pcs'])
  assert.deepEqual(b.map((row) => row.productId), ['kg', 'pcs'])
  assert.equal(a[0].referencePriceCents, '11700')
  assert.equal(b[0].referencePriceCents, '14400')
  for (const row of a) {
    assert.equal('stockQty' in row, false)
    assert.equal('availableQty' in row, false)
    assert.equal('costPriceCents' in row, false)
  }
})

test('quote binds Partner discount and product prices server-side', async () => {
  const kgQuote = await quote('a', { productId: 'kg', orderUnit: 'KG', quantityGrams: 1500 })
  assert.equal(kgQuote.basePriceCents, '18000')
  assert.equal(kgQuote.discountBps, 6500)
  assert.equal(kgQuote.finalAmountCents, '17550')
  const pcsQuote = await quote('a', { productId: 'pcs', orderUnit: 'PCS', quantityPieces: 20 })
  assert.equal(pcsQuote.basePriceCents, '500')
  assert.equal(pcsQuote.finalAmountCents, '6500')
  products[0].partnerKgBasePriceCents = 19500n
  assert.equal((await quote('a', { productId: 'kg', orderUnit: 'KG', quantityGrams: 1000 })).finalAmountCents, '12675')
  assert.equal((await quote('a', { productId: 'pcs', orderUnit: 'PCS', quantityPieces: 1 })).finalAmountCents, '325')
  assert.equal(products[0].salePriceCents, 500n)
  products[0].partnerKgBasePriceCents = 18000n
})

test('quote rejects unit, authority, tenant, lifecycle and incomplete products without MOQ/step rules', async () => {
  await assert.rejects(() => quote('a', { productId: 'kg', orderUnit: 'PCS', quantityPieces: 1 }), /单位/)
  await assert.rejects(() => quote('a', { productId: 'pcs', orderUnit: 'KG', quantityGrams: 1000 }), /单位/)
  assert.equal((await quote('a', { productId: 'kg', orderUnit: 'KG', quantityGrams: 250 })).quantityGrams, 250)
  assert.equal((await quote('a', { productId: 'kg', orderUnit: 'KG', quantityGrams: 600 })).quantityGrams, 600)
  for (const forged of [{ partnerId: 'b' }, { discountBps: 100 }, { kgBasePriceCents: 1 }, { piecePriceCents: 1 }, { finalAmountCents: 1 }]) {
    await assert.rejects(() => quote('a', { productId: 'kg', orderUnit: 'KG', quantityGrams: 1000, ...forged }), /服务器决定/)
  }
  await assert.rejects(() => quote('paused', { productId: 'kg', orderUnit: 'KG', quantityGrams: 1000 }), /暂停/)
  await assert.rejects(() => quote('terminated', { productId: 'kg', orderUnit: 'KG', quantityGrams: 1000 }), /停止合作/)
  await assert.rejects(() => quote('a', { productId: 'inactive', orderUnit: 'PCS', quantityPieces: 1 }), /不可补货/)
  await assert.rejects(() => quote('a', { productId: 'kg-missing', orderUnit: 'KG', quantityGrams: 1000 }), /不可补货/)
  await assert.rejects(() => quote('a', { productId: 'pcs-missing', orderUnit: 'PCS', quantityPieces: 1 }), /不可补货/)
  assert.throws(() => calculatePartnerAmountCents({ orderUnit: 'KG', quantityBase: 9_999_999, basePriceCents: 99_999_999_999n, discountBps: 10_000 }), /超出允许范围/)
})

test('additive migration preserves legacy BOX/2500g and defaults catalogue disabled', async () => {
  const db = new PGlite()
  await db.exec(`CREATE TABLE "InventoryItem" (
    "id" TEXT PRIMARY KEY,
    "category" TEXT NOT NULL DEFAULT 'product',
    "isActive" BOOLEAN NOT NULL DEFAULT FALSE,
    "salePriceCents" BIGINT,
    "transferBoxEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    "transferBoxWeightGrams" INTEGER,
    "partnerSupplyEnabled" BOOLEAN NOT NULL DEFAULT FALSE
  );
  INSERT INTO "InventoryItem" ("id", "category", "isActive", "salePriceCents", "transferBoxEnabled", "transferBoxWeightGrams", "partnerSupplyEnabled")
  VALUES ('legacy-box', 'product', TRUE, 500, TRUE, 2500, TRUE);`)
  const sql = await readFile(new URL('../prisma/migrations/20260906210000_partner_replenishment_catalogue/migration.sql', import.meta.url), 'utf8')
  await db.exec(sql)
  const result = await db.query('SELECT * FROM "InventoryItem" WHERE "id" = $1', ['legacy-box'])
  const row = result.rows[0]
  assert.equal(row.transferBoxEnabled, true)
  assert.equal(row.transferBoxWeightGrams, 2500)
  assert.equal(row.partnerSupplyEnabled, true)
  assert.equal(row.partnerReplenishmentEnabled, false)
  assert.equal(row.partnerOrderUnit, null)
  await db.close()
})

test('product configuration validates KG/PCS independently and never requires 6g', () => {
  const base = { name: '配置商品', sku: 'CONFIG-1', salePriceCents: '500', costPriceCents: '200', isActive: true, unit: '颗' }
  const kg = productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: 'KG', partnerKgBasePriceCents: '18000', partnerMinOrderBaseQty: 1000, partnerOrderStepBaseQty: 500 })
  assert.equal(kg.partnerKgBasePriceCents, 18000n)
  assert.equal(kg.salePriceCents, 500n)
  assert.equal(kg.transferPieceWeightGrams, null)
  const pcs = productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: '', partnerMinOrderBaseQty: 20, partnerOrderStepBaseQty: 10 })
  assert.equal(pcs.partnerKgBasePriceCents, null)
  assert.equal(pcs.salePriceCents, 500n)
  assert.throws(() => productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: 'KG', partnerMinOrderBaseQty: 1000, partnerOrderStepBaseQty: 500 }), /KG 标准/)
  assert.throws(() => productData({ ...base, isActive: false, salePriceCents: '', partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerMinOrderBaseQty: 20, partnerOrderStepBaseQty: 10 }), /单颗售价/)
})

test('KG price changes append the existing generic audit authority payload', async () => {
  const data = buildPartnerKgPriceAuditData({ id: 'admin-1', username: '产品管理员' }, 'kg', 18000n, 19500n)
  assert.equal(data.recordType, 'InventoryItem')
  assert.equal(data.recordId, 'kg')
  assert.equal(data.actorUserId, 'admin-1')
  assert.deepEqual(JSON.parse(data.reason), { field: 'partnerKgBasePriceCents', before: '18000', after: '19500', unit: 'CENTS_PER_KG' })
  let written = null
  await appendPartnerKgPriceAudit({ sensitiveRecordAudit: { create: async ({ data: input }) => { written = input } } }, { id: 'admin-1', username: '产品管理员' }, 'kg', 18000n, 19500n)
  assert.equal(written.action, 'partner_replenishment.kg_base_price.change')
  assert.deepEqual(JSON.parse(written.reason), JSON.parse(data.reason))
})

test('API contract exposes read-only catalogue/quote and product route keeps manager guard', async () => {
  const partnerSource = await readFile(new URL('../server/partner-auth.js', import.meta.url), 'utf8')
  const productSource = await readFile(new URL('../server/products.js', import.meta.url), 'utf8')
  assert.match(partnerSource, /router\.get\('\/catalogue'/)
  assert.match(partnerSource, /router\.post\('\/catalogue\/quote'/)
  assert.match(productSource, /productsRouter\.put\('\/products\/:productId'[\s\S]*?requireProductManager\(req\.user\)/)
  assert.doesNotMatch(partnerSource, /stockLedger\.(create|update|delete)/i)
})
