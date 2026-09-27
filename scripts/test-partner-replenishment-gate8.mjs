import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { afterSalesDto, normalizeAfterSalesCreate } from '../server/replenishment-after-sales-service.js'

test('damaged, wrong-item and return inputs use positive integer KG/PCS authority', () => {
  for (const type of ['DAMAGED', 'WRONG_ITEM', 'RETURN']) assert.equal(normalizeAfterSalesCreate({ orderId: 'order-1', shipmentItemId: 'ship-item-1', type, quantityBase: 1, description: '问题说明', attachments: [] }).type, type)
  assert.throws(() => normalizeAfterSalesCreate({ orderId: 'order-1', shipmentItemId: 'ship-item-1', type: 'REFUND', quantityBase: 1, description: 'x' }), /类型/)
  assert.throws(() => normalizeAfterSalesCreate({ orderId: 'order-1', shipmentItemId: 'ship-item-1', type: 'DAMAGED', quantityBase: 1.5, description: 'x' }), /正整数/)
})

test('images are bounded private payloads and reject public-path authority fields', () => {
  const image = `data:image/png;base64,${Buffer.from('png').toString('base64')}`
  const input = normalizeAfterSalesCreate({ orderId: 'order-1', shipmentItemId: 'ship-item-1', type: 'DAMAGED', quantityBase: 1, description: 'x', attachments: [{ name: 'proof.png', fileType: 'image/png', dataUrl: image }] })
  assert.equal(input.attachments[0].fileSize, 3)
  assert.throws(() => normalizeAfterSalesCreate({ orderId: 'order-1', shipmentItemId: 'ship-item-1', type: 'DAMAGED', quantityBase: 1, description: 'x', publicUrl: 'https://example.test/x' }), /不接受客户端字段/)
})

test('Partner DTO exposes safe status and attachment metadata without storage or actor leakage', () => {
  const dto = afterSalesDto({ id: 'as-1', requestNo: 'AS-1', replenishmentOrderId: 'order-1', replenishmentShipmentItemId: 'si-1', type: 'DAMAGED', quantityBase: 1000, description: '破损', status: 'PENDING', resultNote: '', createdAt: new Date(), handledAt: null, attachments: [{ id: 'a-1', name: 'x.png', fileType: 'image/png', fileSize: 10, dataUrl: 'secret', storageKey: 'secret' }], replenishmentOrder: { orderNo: 'RPL-1' }, replenishmentShipmentItem: { productNameSnapshot: '糖', orderUnitSnapshot: 'KG', shippedQuantityBase: 2000 }, createdByActorId: 'secret-user' })
  assert.equal(dto.status, 'PENDING')
  assert.doesNotMatch(JSON.stringify(dto), /dataUrl|storageKey|secret-user|handledBy/)
})

test('PGlite enforces shipped scope, tenant match, cumulative claims and immutable evidence', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "Store" ("key" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "active" BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE "Partner" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "PartnerStore" ("id" TEXT PRIMARY KEY, "partnerId" TEXT NOT NULL, "name" TEXT NOT NULL);
    CREATE UNIQUE INDEX "PartnerStore_partnerId_name_key" ON "PartnerStore"("partnerId", "name");
    CREATE TABLE "InventoryItem" ("id" TEXT PRIMARY KEY);
    INSERT INTO "Store" VALUES ('guanshe', '北京官舍店', TRUE);
    INSERT INTO "Partner" VALUES ('partner-a'), ('partner-b');
    INSERT INTO "PartnerStore" VALUES ('partner-store-a', 'partner-a', 'A 门店');
    INSERT INTO "InventoryItem" VALUES ('kg');
  `)
  for (const path of ['../prisma/migrations/20260907100000_replenishment_order_core/migration.sql', '../prisma/migrations/20260907200000_replenishment_review/migration.sql', '../prisma/migrations/20260907300000_replenishment_shipment/migration.sql', '../prisma/migrations/20260907400000_replenishment_after_sales/migration.sql']) await db.exec(await readFile(new URL(path, import.meta.url), 'utf8'))
  await db.exec(`
    INSERT INTO "ReplenishmentOrder" ("id", "orderNo", "partnerId", "partnerStoreId", "partnerNameSnapshot", "partnerStoreNameSnapshot", "status", "createdByType", "createdByActorId", "requestedTotalAmountCents", "approvedTotalAmountCents", "reviewAction", "reviewReason", "reviewedAt", "reviewedByActorId", "reviewedByActorName", "reviewIdempotencyScope", "reviewIdempotencyKey", "reviewPayloadDigest", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES ('order-1', 'RPL-1', 'partner-a', 'partner-store-a', 'Partner A', 'A 门店', 'APPROVED', 'PARTNER', 'partner-user', 1000, 1000, 'APPROVE', '批准', CURRENT_TIMESTAMP, 'developer', 'developer', 'review-scope', 'review-key-001', '${'a'.repeat(64)}', 'create-scope', 'create-key-001', '${'b'.repeat(64)}');
    INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "orderUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot", "approvedQuantityBase", "approvedLineAmountCents") VALUES ('kg-line', 'order-1', 'kg', 'KG 糖', 'KG', 6000, 18000, 6500, 1000, 1, 1, 6000, 1000);
    INSERT INTO "ReplenishmentShipment" ("id", "shipmentNo", "replenishmentOrderId", "fulfillmentStoreKey", "fulfillmentStoreSnapshot", "carrier", "trackingNumber", "freightType", "shippedAt", "createdByActorId", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES ('shipment-1', 'RPS-1', 'order-1', 'guanshe', '北京官舍店', '顺丰', 'SF-1', 'PREPAID', CURRENT_TIMESTAMP, 'developer', 'scope-1', 'ship-key-001', '${'c'.repeat(64)}');
    INSERT INTO "ReplenishmentShipmentItem" ("id", "replenishmentShipmentId", "replenishmentOrderItemId", "productNameSnapshot", "orderUnitSnapshot", "shippedQuantityBase") VALUES ('ship-item-1', 'shipment-1', 'kg-line', 'KG 糖', 'KG', 6000);
    INSERT INTO "ReplenishmentAfterSalesRequest" ("id", "requestNo", "partnerId", "replenishmentOrderId", "replenishmentShipmentItemId", "type", "quantityBase", "description", "createdByActorId") VALUES ('as-1', 'AS-1', 'partner-a', 'order-1', 'ship-item-1', 'DAMAGED', 4000, '破损', 'partner-user');
  `)
  await assert.rejects(() => db.query(`INSERT INTO "ReplenishmentAfterSalesRequest" ("id", "requestNo", "partnerId", "replenishmentOrderId", "replenishmentShipmentItemId", "type", "quantityBase", "description", "createdByActorId") VALUES ('as-over', 'AS-OVER', 'partner-a', 'order-1', 'ship-item-1', 'WRONG_ITEM', 2001, '错发', 'partner-user')`), /QUANTITY_EXCEEDED/)
  await assert.rejects(() => db.query(`INSERT INTO "ReplenishmentAfterSalesRequest" ("id", "requestNo", "partnerId", "replenishmentOrderId", "replenishmentShipmentItemId", "type", "quantityBase", "description", "createdByActorId") VALUES ('as-cross', 'AS-CROSS', 'partner-b', 'order-1', 'ship-item-1', 'RETURN', 1, '跨租户', 'partner-user')`), /SCOPE_INVALID/)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentAfterSalesRequest" SET "quantityBase"=1 WHERE "id"='as-1'`), /CORE_IMMUTABLE/)
  await assert.rejects(() => db.query(`DELETE FROM "ReplenishmentAfterSalesRequest" WHERE "id"='as-1'`), /DELETE_FORBIDDEN/)
  await db.close()
})

test('processing authority is Developer/Admin only and state transitions are fail-closed', async () => {
  const source = await readFile(new URL('../server/replenishment-after-sales-service.js', import.meta.url), 'utf8')
  assert.match(source, /canManagePartnerDomain/)
  assert.match(source, /PENDING.*PROCESSING.*REJECTED/)
  assert.match(source, /PROCESSING.*RESOLVED.*REJECTED/)
  assert.match(source, /partnerId: principal\.partnerId/)
  assert.doesNotMatch(source, /(?:stockLedger|payment|refund)\.(?:create|update|delete|upsert)/i)
})

test('migration and routes never write stock, payment, refund or public attachments', async () => {
  const sources = await Promise.all(['../prisma/migrations/20260907400000_replenishment_after_sales/migration.sql', '../server/partner-auth.js', '../server/partner-domain.js'].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  assert.match(sources[1], /after-sales\/:requestId\/attachments\/:attachmentId/)
  assert.match(sources[2], /partner-management\/after-sales/)
  assert.doesNotMatch(sources.join('\n'), /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:StockLedger|Payment|Refund)"?/i)
  assert.doesNotMatch(sources.join('\n'), /publicUrl|public\/uploads/i)
})
