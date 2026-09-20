import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { listPartnerCatalogue, quotePartnerCatalogueItem } from '../server/partner-replenishment-catalogue.js'
import { calculatePartnerAmountCents, validatePartnerQuantity } from '../server/partner-replenishment-pricing.js'
import { createReplenishmentOrder, REPLENISHMENT_CREATED_BY_TYPES } from '../server/replenishment-order-service.js'
import { productData } from '../server/products.js'
import { adjustShortcutQuantity, parseDisplayQuantity } from '../src/utils/partnerReplenishmentPortal.js'

const now = new Date('2026-09-07T00:00:00.000Z')
const partner = { id: 'partner-a', name: 'Partner A', status: 'ACTIVE', defaultDiscountBps: 6500 }
const store = { id: 'store-a', partnerId: partner.id, name: 'A 门店', status: 'ACTIVE', contactName: '', phone: '', province: '', city: '', district: '', addressLine: '' }
const products = [
  { id: 'kg', name: 'KG 糖', sku: 'KG-1', transferCode: 'NO.1', spec: '', unit: 'kg', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'KG', partnerKgBasePriceCents: 18000n, partnerMinOrderBaseQty: 1000, partnerOrderStepBaseQty: 500, updatedAt: now, sortOrder: 1 },
  { id: 'pcs', name: '颗糖', sku: 'PCS-1', transferCode: 'NO.2', spec: '', unit: '颗', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 20, partnerOrderStepBaseQty: 10, updatedAt: now, sortOrder: 2 },
  { id: 'native', name: '礼盒', sku: 'BOX-1', transferCode: 'BOX-1', spec: '', unit: '盒', category: 'product', isActive: false, salePriceCents: 8800n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'NATIVE', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: null, partnerOrderStepBaseQty: null, updatedAt: now, sortOrder: 3 },
  { id: 'disabled', name: '未明确开启', sku: 'OFF-1', unit: '份', category: 'product', isActive: true, salePriceCents: 100n, partnerReplenishmentEnabled: false, partnerOrderUnit: null, updatedAt: now, sortOrder: 4 },
]

function db() {
  const orders = []
  const client = {
    partner: { findUnique: async ({ where }) => where.id === partner.id ? partner : null },
    partnerStore: { findFirst: async ({ where }) => where.id === store.id && where.partnerId === partner.id ? store : null },
    inventoryItem: {
      findMany: async ({ where }) => where?.id?.in ? products.filter((row) => where.id.in.includes(row.id)) : products.filter((row) => row.partnerReplenishmentEnabled),
      findUnique: async ({ where }) => products.find((row) => row.id === where.id) || null,
    },
    user: { findUnique: async ({ where }) => where.id === 'partner-user' ? { id: 'partner-user', username: 'partner_user' } : null },
    partnerAuditLog: { create: async ({ data }) => data },
    replenishmentOrder: {
      findUnique: async () => null,
      create: async ({ data }) => {
        const row = { ...data, items: data.items.create, shipments: [], version: 1, approvedTotalAmountCents: null, cancelledAt: null, reviewedAt: null, reviewReason: '' }
        orders.push(row)
        return row
      },
    },
  }
  client.$transaction = async (callback) => callback(client)
  client.orders = orders
  return client
}

test('KG manual input converts exactly to integer grams and rejects fractional grams', () => {
  assert.equal(parseDisplayQuantity('0.1', 'KG'), 100)
  assert.equal(parseDisplayQuantity('1.25', 'KG'), 1250)
  assert.equal(parseDisplayQuantity('2.37', 'KG'), 2370)
  for (const value of ['0', '-1', '1.2345', 'abc']) assert.equal(parseDisplayQuantity(value, 'KG'), null)
})

test('PCS and native inputs require positive integer units', () => {
  for (const value of ['1', '7', '23', '35', '100']) assert.equal(parseDisplayQuantity(value, 'PCS'), Number(value))
  assert.equal(parseDisplayQuantity('23', 'NATIVE'), 23)
  for (const value of ['0', '-1', '1.5']) assert.equal(parseDisplayQuantity(value, 'PCS'), null)
})

test('shortcut increments are UI-only KG 100g, PCS 10 and native 1', () => {
  assert.equal(adjustShortcutQuantity(1000, 'KG', 1), 1100)
  assert.equal(adjustShortcutQuantity(1000, 'KG', -1), 900)
  assert.equal(adjustShortcutQuantity(20, 'PCS', 1), 30)
  assert.equal(adjustShortcutQuantity(20, 'PCS', -1), 10)
  assert.equal(adjustShortcutQuantity(2, 'NATIVE', 1), 3)
})

test('server accepts positive integer quantities without MOQ or shortcut-step enforcement', () => {
  for (const value of [1, 7, 23, 1250, 2370]) assert.equal(validatePartnerQuantity({ quantityBase: value, minimumBase: 9999, stepBase: 100 }), value)
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validatePartnerQuantity({ quantityBase: value }))
})

test('catalogue is explicit-enable only and supports native unit with existing price authority', async () => {
  const source = db()
  const rows = await listPartnerCatalogue({ db: source, principal: { partnerId: partner.id } })
  assert.deepEqual(rows.map((row) => row.productId), ['kg', 'pcs', 'native'])
  assert.deepEqual(rows.map((row) => row.shortcutIncrementBaseQty), [100, 10, 1])
  const native = rows.find((row) => row.productId === 'native')
  assert.equal(native.nativeUnit, '盒')
  assert.equal(native.basePriceCents, '8800')
  assert.equal(native.referencePriceCents, '5720')
  assert.equal('partnerKgBasePriceCents' in native, false)
})

test('KG 1.25/2.37, PCS 1/23 and native quotes use server price and Partner discount', async () => {
  const source = db()
  const principal = { partnerId: partner.id }
  for (const [body, expected] of [
    [{ productId: 'kg', orderUnit: 'KG', quantityGrams: 1250 }, '14625'],
    [{ productId: 'kg', orderUnit: 'KG', quantityGrams: 2370 }, '27729'],
    [{ productId: 'pcs', orderUnit: 'PCS', quantityPieces: 1 }, '325'],
    [{ productId: 'pcs', orderUnit: 'PCS', quantityPieces: 23 }, '7475'],
    [{ productId: 'native', orderUnit: 'NATIVE', quantityUnits: 2 }, '11440'],
  ]) assert.equal((await quotePartnerCatalogueItem({ db: source, principal, body })).finalAmountCents, expected)
  await assert.rejects(() => quotePartnerCatalogueItem({ db: source, principal, body: { productId: 'native', orderUnit: 'NATIVE', quantityPieces: 2 } }), /单位/)
  assert.equal(calculatePartnerAmountCents({ orderUnit: 'NATIVE', quantityBase: 2, basePriceCents: 8800, discountBps: 6500 }), 11440n)
})

test('native product creates an order without KG price, 6g, MOQ or step config', async () => {
  const source = db()
  const result = await createReplenishmentOrder({
    db: source,
    createdByType: REPLENISHMENT_CREATED_BY_TYPES.PARTNER,
    actor: { id: 'partner-user' },
    principalPartnerId: partner.id,
    idempotencyKey: 'native-order-0001',
    body: { partnerStoreId: store.id, items: [{ inventoryItemId: 'native', orderUnit: 'NATIVE', quantity: 2 }] },
  })
  const item = result.order.items[0]
  assert.equal(item.orderUnitSnapshot, 'NATIVE')
  assert.equal(item.nativeUnitSnapshot, '盒')
  assert.equal(item.basePriceSnapshotCents, 8800n)
  assert.equal(item.minimumOrderBaseQtySnapshot, 1)
  assert.equal(item.orderStepBaseQtySnapshot, 1)
})

test('Product Center requires explicit mode and reuses native unit/price', () => {
  const base = { name: '礼盒', sku: 'BOX-1', salePriceCents: '8800', costPriceCents: '4000', unit: '盒', isActive: true }
  const native = productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: 'NATIVE' })
  assert.equal(native.partnerKgBasePriceCents, null)
  assert.equal(native.partnerMinOrderBaseQty, 1)
  assert.equal(native.partnerOrderStepBaseQty, 1)
  assert.throws(() => productData({ ...base, partnerReplenishmentEnabled: true, partnerOrderUnit: '' }), /请选择/)
})

test('migration executes additively and preserves historical rule snapshots', async () => {
  const sql = await readFile(new URL('../prisma/migrations/20260907500000_partner_product_rule_reconciliation/migration.sql', import.meta.url), 'utf8')
  assert.match(sql, /'NATIVE'/)
  assert.match(sql, /ADD COLUMN "nativeUnitSnapshot"/)
  assert.doesNotMatch(sql, /UPDATE\s+"(?:InventoryItem|ReplenishmentOrderItem|ReplenishmentShipmentItem)"/i)
  assert.doesNotMatch(sql, /DROP COLUMN "(?:partnerMinOrderBaseQty|partnerOrderStepBaseQty|minimumOrderBaseQtySnapshot|orderStepBaseQtySnapshot)"/i)
  const database = new PGlite()
  await database.exec(`
    CREATE TABLE "InventoryItem" (
      "id" TEXT PRIMARY KEY, "unit" TEXT NOT NULL, "salePriceCents" BIGINT,
      "partnerReplenishmentEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "partnerOrderUnit" TEXT, "partnerKgBasePriceCents" BIGINT,
      "partnerMinOrderBaseQty" INTEGER, "partnerOrderStepBaseQty" INTEGER,
      CONSTRAINT "InventoryItem_partner_order_unit_check" CHECK ("partnerOrderUnit" IS NULL OR "partnerOrderUnit" IN ('KG', 'PCS')),
      CONSTRAINT "InventoryItem_partner_enabled_config_check" CHECK ("partnerReplenishmentEnabled" = FALSE OR "partnerOrderUnit" IN ('KG', 'PCS'))
    );
    CREATE TABLE "ReplenishmentOrder" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL);
    CREATE TABLE "ReplenishmentOrderItem" (
      "id" TEXT PRIMARY KEY, "replenishmentOrderId" TEXT NOT NULL, "inventoryItemId" TEXT NOT NULL,
      "productNameSnapshot" TEXT NOT NULL, "skuSnapshot" TEXT NOT NULL DEFAULT '', "productCodeSnapshot" TEXT NOT NULL DEFAULT '',
      "orderUnitSnapshot" TEXT NOT NULL, "requestedQuantityBase" INTEGER NOT NULL,
      "basePriceSnapshotCents" BIGINT NOT NULL, "discountBpsSnapshot" INTEGER NOT NULL,
      "requestedLineAmountCents" BIGINT NOT NULL, "minimumOrderBaseQtySnapshot" INTEGER NOT NULL,
      "orderStepBaseQtySnapshot" INTEGER NOT NULL, "approvedQuantityBase" INTEGER,
      "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ReplenishmentOrderItem_order_unit_check" CHECK ("orderUnitSnapshot" IN ('KG', 'PCS'))
    );
    CREATE TABLE "ReplenishmentShipment" ("id" TEXT PRIMARY KEY, "replenishmentOrderId" TEXT NOT NULL);
    CREATE TABLE "ReplenishmentShipmentItem" (
      "id" TEXT PRIMARY KEY, "replenishmentShipmentId" TEXT NOT NULL, "replenishmentOrderItemId" TEXT NOT NULL,
      "productNameSnapshot" TEXT NOT NULL, "orderUnitSnapshot" TEXT NOT NULL,
      "shippedQuantityBase" INTEGER NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ReplenishmentShipmentItem_unit_check" CHECK ("orderUnitSnapshot" IN ('KG', 'PCS'))
    );
    INSERT INTO "InventoryItem" VALUES ('legacy', '颗', 500, FALSE, NULL, NULL, NULL, NULL);
    INSERT INTO "ReplenishmentOrder" VALUES ('old-order', 'SUBMITTED');
    INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "orderUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot")
      VALUES ('old-line', 'old-order', 'legacy', '旧糖', 'KG', 1500, 18000, 6500, 17550, 1000, 500);
  `)
  await database.exec(sql)
  await database.exec(`INSERT INTO "InventoryItem" VALUES ('native', '盒', 8800, TRUE, 'NATIVE', NULL, 1, 1)`)
  await database.exec(`INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "orderUnitSnapshot", "nativeUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot") VALUES ('native-line', 'old-order', 'native', '礼盒', 'NATIVE', '盒', 2, 8800, 6500, 11440, 1, 1)`)
  const old = (await database.query('SELECT "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot", "nativeUnitSnapshot" FROM "ReplenishmentOrderItem" WHERE "id" = \'old-line\'')).rows[0]
  assert.deepEqual(old, { minimumOrderBaseQtySnapshot: 1000, orderStepBaseQtySnapshot: 500, nativeUnitSnapshot: '' })
  await assert.rejects(() => database.exec(`INSERT INTO "InventoryItem" VALUES ('bad-native', '', 8800, TRUE, 'NATIVE', NULL, 1, 1)`))
  await database.close()
})
