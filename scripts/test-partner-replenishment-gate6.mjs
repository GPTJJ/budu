import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createReplenishmentShipment, normalizeShipment } from '../server/replenishment-shipment-service.js'
import { serializeReplenishmentOrder } from '../server/replenishment-order-service.js'

const now = new Date('2026-09-07T04:00:00.000Z')

const orderItem = (id, unit, approved, overrides = {}) => ({
  id,
  replenishmentOrderId: 'order-1',
  inventoryItemId: `product-${id}`,
  productNameSnapshot: `商品 ${id}`,
  skuSnapshot: id.toUpperCase(),
  productCodeSnapshot: id.toUpperCase(),
  orderUnitSnapshot: unit,
  requestedQuantityBase: approved,
  basePriceSnapshotCents: unit === 'KG' ? 18000n : 500n,
  discountBpsSnapshot: 6500,
  requestedLineAmountCents: 1000n,
  minimumOrderBaseQtySnapshot: 1,
  orderStepBaseQtySnapshot: 1,
  approvedQuantityBase: approved,
  approvedLineAmountCents: approved > 0 ? 1000n : 0n,
  reviewReason: approved > 0 ? '' : '本次不发',
  shipmentItems: [],
  createdAt: now,
  ...overrides,
})

const approvedOrder = () => ({
  id: 'order-1',
  orderNo: 'RPL-ORDER-1',
  partnerId: 'partner-a',
  partnerStoreId: 'partner-store-a',
  partnerNameSnapshot: 'Partner A',
  partnerStoreNameSnapshot: 'A 门店',
  contactNameSnapshot: '联系人',
  phoneSnapshot: '13800000000',
  provinceSnapshot: '河北省',
  citySnapshot: '秦皇岛市',
  districtSnapshot: '海港区',
  addressLineSnapshot: '测试地址',
  status: 'APPROVED',
  createdByType: 'PARTNER',
  createdByActorId: 'partner-user',
  createdByActorName: 'partner',
  submittedAt: now,
  cancelledAt: null,
  cancelledByType: null,
  cancelledByActorId: '',
  cancelledByActorName: '',
  requestedTotalAmountCents: 2000n,
  approvedTotalAmountCents: 2000n,
  reviewAction: 'APPROVE',
  reviewReason: '批准',
  reviewedAt: now,
  reviewedByActorId: 'developer',
  reviewedByActorName: 'developer',
  reviewIdempotencyScope: 'review-scope',
  reviewIdempotencyKey: 'review-key-001',
  reviewPayloadDigest: 'a'.repeat(64),
  version: 2,
  items: [orderItem('kg', 'KG', 10000), orderItem('pcs', 'PCS', 5), orderItem('removed', 'PCS', 0)],
  shipments: [],
  createdAt: now,
  updatedAt: now,
})

const users = [
  { id: 'developer', username: 'developer', role: 'developer', status: 'active', employeeId: '' },
  { id: 'admin', username: 'admin', role: 'admin', status: 'active', employeeId: '' },
  { id: 'duty', username: 'duty', role: 'staff', status: 'active', employeeId: 'emp-duty' },
  { id: 'finance', username: 'finance', role: 'finance', status: 'active', employeeId: '' },
  { id: 'partner-user', username: 'partner', role: 'partner', status: 'active', employeeId: '' },
]

function fixtures() {
  return {
    users,
    stores: [
      { key: 'guanshe', name: '北京官舍店', active: true },
      { key: 'tongying', name: '北京通盈中心店', active: true },
      { key: 'closed', name: '停用门店', active: false },
    ],
    employees: [{ id: 'emp-duty', status: 'ACTIVE' }],
    schedules: [{ id: 'schedule-1', storeKey: 'guanshe', date: '2026-09-07', shifts: [{ employeeId: 'emp-duty' }] }],
    orders: [approvedOrder()],
    shipments: [],
    audits: [],
  }
}

function memoryDb(initial = fixtures()) {
  let state = structuredClone(initial)
  let queue = Promise.resolve()
  let failAudit = false
  const client = (source) => ({
    user: { findUnique: async ({ where }) => structuredClone(source.users.find((row) => row.id === where.id) || null) },
    store: {
      findUnique: async ({ where }) => structuredClone(source.stores.find((row) => row.key === where.key) || null),
      findMany: async ({ where }) => structuredClone(source.stores.filter((row) => !where?.active || row.active)),
    },
    employee: { findUnique: async ({ where }) => structuredClone(source.employees.find((row) => row.id === where.id) || null) },
    schedule: {
      findMany: async ({ where, take }) => structuredClone(source.schedules.filter((row) => row.storeKey === where.storeKey && row.date === where.date).slice(0, take)),
    },
    replenishmentOrder: {
      findUnique: async ({ where }) => structuredClone(source.orders.find((row) => row.id === where.id) || null),
    },
    replenishmentShipment: {
      findUnique: async ({ where }) => {
        const pair = where.idempotencyScope_idempotencyKey
        return structuredClone(source.shipments.find((row) => row.idempotencyScope === pair.idempotencyScope && row.idempotencyKey === pair.idempotencyKey) || null)
      },
      create: async ({ data }) => {
        if (source.shipments.some((row) => row.idempotencyScope === data.idempotencyScope && row.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const order = source.orders.find((row) => row.id === data.replenishmentOrderId)
        const items = data.items.create.map((item) => ({ ...structuredClone(item), replenishmentShipmentId: data.id, createdAt: now }))
        for (const shipmentItem of items) {
          const orderLine = order.items.find((row) => row.id === shipmentItem.replenishmentOrderItemId)
          const shipped = orderLine.shipmentItems.reduce((sum, row) => sum + row.shippedQuantityBase, 0)
          if (shipped + shipmentItem.shippedQuantityBase > orderLine.approvedQuantityBase) throw Object.assign(new Error('over ship'), { code: 'REPLENISHMENT_SHIPMENT_OVER_SHIP', status: 409 })
          orderLine.shipmentItems.push(structuredClone(shipmentItem))
        }
        const shipment = { ...structuredClone(data), items, createdAt: now }
        delete shipment.items.create
        source.shipments.push(shipment)
        order.shipments.push(structuredClone(shipment))
        order.status = order.items.every((item) => item.approvedQuantityBase === 0 || item.shipmentItems.reduce((sum, row) => sum + row.shippedQuantityBase, 0) === item.approvedQuantityBase)
          ? 'SHIPPED'
          : 'PARTIALLY_SHIPPED'
        order.version += items.length
        return structuredClone(shipment)
      },
    },
    partnerAuditLog: {
      create: async ({ data }) => {
        if (failAudit) { failAudit = false; throw new Error('audit failure') }
        source.audits.push(structuredClone(data))
        return structuredClone(data)
      },
    },
  })
  const db = client(state)
  db.$transaction = async (callback) => {
    const run = queue.then(async () => {
      const draft = structuredClone(state)
      const result = await callback(client(draft))
      state = draft
      Object.assign(db, client(state))
      return result
    })
    queue = run.catch(() => {})
    return run
  }
  db.getState = () => state
  db.failNextAudit = () => { failAudit = true }
  return db
}

const shipmentBody = (items, overrides = {}) => ({
  fulfillmentStoreKey: 'guanshe',
  carrier: '顺丰',
  trackingNumber: 'SF123456789',
  freightType: 'PREPAID',
  items,
  ...overrides,
})

const ship = (db, items, key, actor = 'developer', overrides = {}) => createReplenishmentShipment({
  db,
  actor: { id: actor },
  orderId: 'order-1',
  body: shipmentBody(items, overrides),
  idempotencyKey: key,
  now,
})

test('10kg ships 6kg then 4kg and transitions PARTIALLY_SHIPPED to SHIPPED', async () => {
  const db = memoryDb()
  await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 6000 }, { orderItemId: 'pcs', shippedQuantityBase: 5 }], 'shipment-first-001')
  assert.equal(db.getState().orders[0].status, 'PARTIALLY_SHIPPED')
  assert.equal(db.getState().orders[0].items[0].shipmentItems[0].shippedQuantityBase, 6000)
  await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 4000 }], 'shipment-second-01', 'developer', { trackingNumber: 'SF987654321' })
  assert.equal(db.getState().orders[0].status, 'SHIPPED')
  assert.equal(db.getState().shipments.length, 2)
  assert.deepEqual(db.getState().shipments.map((row) => row.trackingNumber), ['SF123456789', 'SF987654321'])
})

test('multi-item partial and alternate active store are supported', async () => {
  const db = memoryDb()
  const result = await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 6000 }, { orderItemId: 'pcs', shippedQuantityBase: 5 }], 'alternate-store-01', 'admin', { fulfillmentStoreKey: 'tongying', freightType: 'COLLECT' })
  assert.equal(result.shipment.fulfillmentStoreKey, 'tongying')
  assert.equal(result.shipment.freightType, 'COLLECT')
  assert.equal(db.getState().orders[0].status, 'PARTIALLY_SHIPPED')
})

test('default guanshe, removed line, over-ship and non-approved states fail closed', async () => {
  assert.equal(normalizeShipment({ carrier: '顺丰', trackingNumber: 'SF1', freightType: 'PREPAID', items: [{ orderItemId: 'kg', shippedQuantityBase: 1 }] }).fulfillmentStoreKey, 'guanshe')
  await assert.rejects(() => ship(memoryDb(), [{ orderItemId: 'removed', shippedQuantityBase: 1 }], 'removed-line-0001'), /本次不发/)
  await assert.rejects(() => ship(memoryDb(), [{ orderItemId: 'kg', shippedQuantityBase: 10001 }], 'over-ship-000001'), /超过剩余/)
  for (const status of ['SUBMITTED', 'CANCELLED', 'REJECTED', 'SHIPPED']) {
    const data = fixtures(); data.orders[0].status = status
    await assert.rejects(() => ship(memoryDb(data), [{ orderItemId: 'kg', shippedQuantityBase: 1 }], `state-${status}-0001`), /只有待发货或部分发货/)
  }
})

test('Developer, Admin and current Guanshe duty can ship; others cannot', async () => {
  for (const actor of ['developer', 'admin', 'duty']) {
    await ship(memoryDb(), [{ orderItemId: 'kg', shippedQuantityBase: 1 }], `allowed-${actor}-0001`, actor)
  }
  for (const actor of ['finance', 'partner-user']) {
    await assert.rejects(() => ship(memoryDb(), [{ orderItemId: 'kg', shippedQuantityBase: 1 }], `denied-${actor}-00001`, actor), /无补货发货权限/)
  }
})

test('idempotency and serialized concurrent overship create one immutable business result', async () => {
  const db = memoryDb()
  const first = await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 6000 }], 'same-shipment-001')
  const replayed = await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 6000 }], 'same-shipment-001')
  assert.equal(replayed.reused, true)
  assert.equal(replayed.shipment.id, first.shipment.id)
  assert.equal(db.getState().audits.length, 1)
  await assert.rejects(() => ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 5000 }], 'same-shipment-001'), /内容不一致/)

  const raceDb = memoryDb()
  await ship(raceDb, [{ orderItemId: 'kg', shippedQuantityBase: 6000 }], 'race-first-00001')
  const race = await Promise.allSettled([
    ship(raceDb, [{ orderItemId: 'kg', shippedQuantityBase: 4000 }], 'race-second-a001'),
    ship(raceDb, [{ orderItemId: 'kg', shippedQuantityBase: 4000 }], 'race-second-b001', 'admin'),
  ])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(raceDb.getState().orders[0].items[0].shipmentItems.reduce((sum, row) => sum + row.shippedQuantityBase, 0), 10000)
})

test('shipment and audit are atomic', async () => {
  const db = memoryDb(); db.failNextAudit()
  await assert.rejects(() => ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 1000 }], 'audit-failure-001'), /audit failure/)
  assert.equal(db.getState().shipments.length, 0)
  assert.equal(db.getState().orders[0].status, 'APPROVED')
  assert.equal(db.getState().orders[0].items[0].shipmentItems.length, 0)
})

test('Partner DTO exposes shipment/remaining evidence without internal or idempotency fields', async () => {
  const db = memoryDb()
  await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 6000 }], 'partner-dto-00001')
  const dto = serializeReplenishmentOrder(db.getState().orders[0])
  assert.equal(dto.items[0].shippedQuantityBase, 6000)
  assert.equal(dto.items[0].remainingQuantityBase, 4000)
  assert.equal(dto.shipments[0].trackingNumber, 'SF123456789')
  for (const forbidden of ['createdByActorId', 'idempotencyKey', 'idempotencyPayloadDigest', 'stockLedger', 'payment']) {
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(forbidden, 'i'))
  }
})

test('PGlite migration enforces cumulative quantity, state derivation and immutable evidence', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "Store" ("key" TEXT PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "active" BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE "Partner" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "PartnerStore" ("id" TEXT PRIMARY KEY, "partnerId" TEXT NOT NULL, "name" TEXT NOT NULL);
    CREATE UNIQUE INDEX "PartnerStore_partnerId_name_key" ON "PartnerStore"("partnerId", "name");
    CREATE TABLE "InventoryItem" ("id" TEXT PRIMARY KEY);
    INSERT INTO "Store" VALUES ('guanshe', '北京官舍店', TRUE);
    INSERT INTO "Partner" VALUES ('partner-a');
    INSERT INTO "PartnerStore" VALUES ('partner-store-a', 'partner-a', 'A 门店');
    INSERT INTO "InventoryItem" VALUES ('kg'), ('pcs'), ('removed');
  `)
  for (const path of [
    '../prisma/migrations/20260907100000_replenishment_order_core/migration.sql',
    '../prisma/migrations/20260907200000_replenishment_review/migration.sql',
    '../prisma/migrations/20260907300000_replenishment_shipment/migration.sql',
  ]) await db.exec(await readFile(new URL(path, import.meta.url), 'utf8'))
  await db.exec(`
    INSERT INTO "ReplenishmentOrder" ("id", "orderNo", "partnerId", "partnerStoreId", "partnerNameSnapshot", "partnerStoreNameSnapshot", "status", "createdByType", "createdByActorId", "requestedTotalAmountCents", "approvedTotalAmountCents", "reviewAction", "reviewReason", "reviewedAt", "reviewedByActorId", "reviewedByActorName", "reviewIdempotencyScope", "reviewIdempotencyKey", "reviewPayloadDigest", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest")
      VALUES ('order-1', 'RPL-1', 'partner-a', 'partner-store-a', 'Partner A', 'A 门店', 'APPROVED', 'PARTNER', 'partner-user', 2000, 2000, 'APPROVE', '批准', CURRENT_TIMESTAMP, 'developer', 'developer', 'review-scope', 'review-key-001', '${'a'.repeat(64)}', 'create-scope', 'create-key-001', '${'b'.repeat(64)}');
    INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "orderUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot", "approvedQuantityBase", "approvedLineAmountCents", "reviewReason") VALUES
      ('kg-line', 'order-1', 'kg', 'KG 糖', 'KG', 10000, 18000, 6500, 1000, 1, 1, 10000, 1000, ''),
      ('pcs-line', 'order-1', 'pcs', '颗糖', 'PCS', 5, 500, 6500, 1000, 1, 1, 5, 1000, ''),
      ('removed-line', 'order-1', 'removed', '不发糖', 'PCS', 1, 500, 6500, 1, 1, 1, 0, 0, '本次不发');
    INSERT INTO "ReplenishmentShipment" ("id", "shipmentNo", "replenishmentOrderId", "fulfillmentStoreKey", "fulfillmentStoreSnapshot", "carrier", "trackingNumber", "freightType", "shippedAt", "createdByActorId", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES
      ('shipment-1', 'RPS-1', 'order-1', 'guanshe', '北京官舍店', '顺丰', 'SF-1', 'PREPAID', CURRENT_TIMESTAMP, 'developer', 'scope-1', 'ship-key-001', '${'c'.repeat(64)}');
    INSERT INTO "ReplenishmentShipmentItem" ("id", "replenishmentShipmentId", "replenishmentOrderItemId", "productNameSnapshot", "orderUnitSnapshot", "shippedQuantityBase") VALUES
      ('ship-item-kg-1', 'shipment-1', 'kg-line', 'KG 糖', 'KG', 6000),
      ('ship-item-pcs-1', 'shipment-1', 'pcs-line', '颗糖', 'PCS', 5);
  `)
  assert.equal((await db.query(`SELECT "status" FROM "ReplenishmentOrder" WHERE "id"='order-1'`)).rows[0].status, 'PARTIALLY_SHIPPED')
  await db.exec(`INSERT INTO "ReplenishmentShipment" ("id", "shipmentNo", "replenishmentOrderId", "fulfillmentStoreKey", "fulfillmentStoreSnapshot", "carrier", "trackingNumber", "freightType", "shippedAt", "createdByActorId", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES ('shipment-over', 'RPS-OVER', 'order-1', 'guanshe', '北京官舍店', '顺丰', 'SF-OVER', 'PREPAID', CURRENT_TIMESTAMP, 'developer', 'scope-over', 'ship-over-001', '${'d'.repeat(64)}')`)
  await assert.rejects(() => db.query(`INSERT INTO "ReplenishmentShipmentItem" ("id", "replenishmentShipmentId", "replenishmentOrderItemId", "productNameSnapshot", "orderUnitSnapshot", "shippedQuantityBase") VALUES ('over', 'shipment-over', 'kg-line', 'KG 糖', 'KG', 5000)`), /OVER_SHIP/)
  await assert.rejects(() => db.query(`INSERT INTO "ReplenishmentShipmentItem" ("id", "replenishmentShipmentId", "replenishmentOrderItemId", "productNameSnapshot", "orderUnitSnapshot", "shippedQuantityBase") VALUES ('removed', 'shipment-over', 'removed-line', '不发糖', 'PCS', 1)`), /NOT_APPROVED/)
  await db.exec(`
    INSERT INTO "ReplenishmentShipment" ("id", "shipmentNo", "replenishmentOrderId", "fulfillmentStoreKey", "fulfillmentStoreSnapshot", "carrier", "trackingNumber", "freightType", "shippedAt", "createdByActorId", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES
      ('shipment-2', 'RPS-2', 'order-1', 'guanshe', '北京官舍店', '顺丰', 'SF-2', 'COLLECT', CURRENT_TIMESTAMP, 'developer', 'scope-2', 'ship-key-002', '${'e'.repeat(64)}');
    INSERT INTO "ReplenishmentShipmentItem" ("id", "replenishmentShipmentId", "replenishmentOrderItemId", "productNameSnapshot", "orderUnitSnapshot", "shippedQuantityBase") VALUES
      ('ship-item-kg-2', 'shipment-2', 'kg-line', 'KG 糖', 'KG', 4000);
  `)
  assert.equal((await db.query(`SELECT "status" FROM "ReplenishmentOrder" WHERE "id"='order-1'`)).rows[0].status, 'SHIPPED')
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentShipment" SET "trackingNumber"='CHANGED' WHERE "id"='shipment-1'`), /SHIPMENT_IMMUTABLE/)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentShipmentItem" SET "shippedQuantityBase"=1 WHERE "id"='ship-item-kg-1'`), /SHIPMENT_IMMUTABLE/)
  await db.close()
})

test('source contracts expose Internal shipment only and write no stock or payment domain', async () => {
  const [service, internalRoutes, partnerRoutes, migration] = await Promise.all([
    readFile(new URL('../server/replenishment-shipment-service.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/partner-domain.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/partner-auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../prisma/migrations/20260907300000_replenishment_shipment/migration.sql', import.meta.url), 'utf8'),
  ])
  assert.match(internalRoutes, /replenishment-orders\/:id\/shipments/)
  assert.doesNotMatch(partnerRoutes, /replenishment-orders\/:id\/shipments/)
  assert.match(service, /FOR UPDATE/)
  for (const source of [service, migration]) {
    assert.doesNotMatch(source, /(?:stockLedger|payment)\.(?:create|update|delete|upsert)/i)
    assert.doesNotMatch(source, /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:StockLedger|Payment)"?/i)
  }
})

// Gate 10A: fault injection checks the existing whole-transaction retry contract.
test('P2010 serialization retries once and commits one shipment/item/audit', async () => {
  const db = memoryDb()
  const transaction = db.$transaction.bind(db)
  let attempts = 0
  db.$transaction = (...args) => {
    if (++attempts === 1) throw Object.assign(new Error('serialization fixture'), { code: 'P2010', meta: { code: '40001' } })
    return transaction(...args)
  }
  await ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 4000 }], 'serialization-once-001')
  assert.equal(attempts, 2)
  assert.equal(db.getState().shipments.length, 1)
  assert.equal(db.getState().audits.length, 1)
  assert.equal(db.getState().orders[0].items[0].shipmentItems.length, 1)
})

test('serialization exhaustion is bounded to three attempts and returns 409 without commit', async () => {
  const db = memoryDb()
  let attempts = 0
  db.$transaction = () => { attempts++; throw Object.assign(new Error('serialization fixture'), { code: 'P2010', meta: { code: '40001' } }) }
  await assert.rejects(() => ship(db, [{ orderItemId: 'kg', shippedQuantityBase: 4000 }], 'serialization-exhaust-001'), error => error.status === 409 && error.code === 'REPLENISHMENT_SHIPMENT_CONFLICT')
  assert.equal(attempts, 3)
  assert.equal(db.getState().shipments.length, 0)
  assert.equal(db.getState().audits.length, 0)
})
