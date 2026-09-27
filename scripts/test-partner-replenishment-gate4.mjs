import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import express from 'express'
import {
  REPLENISHMENT_CREATED_BY_TYPES,
  cancelPartnerReplenishmentOrder,
  createReplenishmentOrder,
  getPartnerReplenishmentOrder,
  listPartnerReplenishmentOrders,
  serializeReplenishmentOrder,
} from '../server/replenishment-order-service.js'
import { createPartnerDomainRouter } from '../server/partner-domain.js'

const now = new Date('2026-09-07T00:00:00.000Z')

function fixtures() {
  return {
    partners: [
      { id: 'partner-a', name: 'Partner A', status: 'ACTIVE', defaultDiscountBps: 6500 },
      { id: 'partner-b', name: 'Partner B', status: 'ACTIVE', defaultDiscountBps: 8000 },
      { id: 'paused', name: 'Paused', status: 'PAUSED', defaultDiscountBps: 6500 },
      { id: 'terminated', name: 'Terminated', status: 'TERMINATED', defaultDiscountBps: 6500 },
    ],
    stores: [
      { id: 'store-a', partnerId: 'partner-a', name: 'A 门店', contactName: 'A 联系人', phone: '13800000001', province: '河北省', city: '秦皇岛市', district: '海港区', addressLine: 'A 路1号', status: 'ACTIVE' },
      { id: 'store-a-off', partnerId: 'partner-a', name: 'A 停用店', contactName: '', phone: '', province: '', city: '', district: '', addressLine: '', status: 'INACTIVE' },
      { id: 'store-b', partnerId: 'partner-b', name: 'B 门店', contactName: 'B 联系人', phone: '13800000002', province: '北京市', city: '北京市', district: '西城区', addressLine: 'B 路2号', status: 'ACTIVE' },
    ],
    products: [
      { id: 'kg', name: 'KG 糖', sku: 'KG-1', transferCode: 'NO.1', spec: '散装', unit: 'kg', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'KG', partnerKgBasePriceCents: 18000n, partnerMinOrderBaseQty: 1000, partnerOrderStepBaseQty: 500, updatedAt: now },
      { id: 'pcs', name: '颗糖', sku: 'PCS-1', transferCode: 'NO.2', spec: '6g', unit: '颗', category: 'product', isActive: true, salePriceCents: 500n, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 20, partnerOrderStepBaseQty: 10, updatedAt: now },
      { id: 'inactive', name: '停用商品', sku: 'OFF-1', transferCode: '', spec: '', unit: '颗', category: 'product', isActive: false, salePriceCents: 500n, partnerReplenishmentEnabled: false, partnerOrderUnit: 'PCS', partnerKgBasePriceCents: null, partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1, updatedAt: now },
    ],
    users: [
      { id: 'partner-user-a', username: 'partner_a' },
      { id: 'partner-user-b', username: 'partner_b' },
      { id: 'developer-1', username: 'developer', role: 'developer', status: 'active', employeeId: '' },
      { id: 'admin-1', username: 'admin', role: 'admin', status: 'active', employeeId: '' },
    ],
    orders: [],
    audits: [],
  }
}

function memoryDb(initial = fixtures()) {
  let state = structuredClone(initial)
  let queue = Promise.resolve()
  let failNextAudit = false

  const includeItems = (order, source = state) => order ? { ...structuredClone(order), items: structuredClone(source.orders.find((row) => row.id === order.id)?.items || order.items || []) } : null
  const client = (source) => ({
    partner: { findUnique: async ({ where }) => structuredClone(source.partners.find((row) => row.id === where.id) || null) },
    partnerStore: { findFirst: async ({ where }) => structuredClone(source.stores.find((row) => row.id === where.id && (!where.partnerId || row.partnerId === where.partnerId)) || null) },
    inventoryItem: { findMany: async ({ where }) => structuredClone(source.products.filter((row) => where.id.in.includes(row.id))) },
    user: { findUnique: async ({ where }) => structuredClone(source.users.find((row) => row.id === where.id) || null) },
    replenishmentOrder: {
      findUnique: async ({ where }) => {
        const compound = where.idempotencyScope_idempotencyKey
        const row = compound
          ? source.orders.find((item) => item.idempotencyScope === compound.idempotencyScope && item.idempotencyKey === compound.idempotencyKey)
          : source.orders.find((item) => item.id === where.id)
        return includeItems(row, source)
      },
      findFirst: async ({ where }) => includeItems(source.orders.find((row) => (!where.id || row.id === where.id) && (!where.partnerId || row.partnerId === where.partnerId)), source),
      findMany: async ({ where } = {}) => source.orders.filter((row) => !where?.partnerId || row.partnerId === where.partnerId).map((row) => includeItems(row, source)).reverse(),
      create: async ({ data }) => {
        if (source.orders.some((row) => row.idempotencyScope === data.idempotencyScope && row.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const order = {
          ...structuredClone(data),
          items: structuredClone(data.items.create),
          version: 1,
          cancelledAt: null,
          cancelledByType: null,
          cancelledByActorId: '',
          cancelledByActorName: '',
          createdAt: data.submittedAt,
          updatedAt: data.submittedAt,
        }
        source.orders.push(order)
        return includeItems(order, source)
      },
      updateMany: async ({ where, data }) => {
        const row = source.orders.find((item) => item.id === where.id && item.partnerId === where.partnerId && item.status === where.status && item.version === where.version)
        if (!row) return { count: 0 }
        Object.assign(row, structuredClone(data), { version: row.version + 1 })
        delete row.version.increment
        return { count: 1 }
      },
    },
    partnerAuditLog: { create: async ({ data }) => {
      if (failNextAudit) { failNextAudit = false; throw new Error('audit failure') }
      source.audits.push(structuredClone(data)); return structuredClone(data)
    } },
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
  db.failNextAudit = () => { failNextAudit = true }
  return db
}

const partnerPrincipal = (partnerId = 'partner-a', userId = 'partner-user-a') => ({ type: 'PARTNER', partnerId, userId, partnerUserId: `binding-${userId}` })
const partnerBody = (overrides = {}) => ({
  partnerStoreId: 'store-a',
  items: [
    { inventoryItemId: 'kg', orderUnit: 'KG', quantity: 1000 },
    { inventoryItemId: 'pcs', orderUnit: 'PCS', quantity: 20 },
  ],
  ...overrides,
})

async function createPartner(db, key = 'partner-key-0001', overrides = {}, principal = partnerPrincipal()) {
  return createReplenishmentOrder({
    db,
    createdByType: REPLENISHMENT_CREATED_BY_TYPES.PARTNER,
    actor: { id: principal.userId },
    principalPartnerId: principal.partnerId,
    body: partnerBody(overrides),
    idempotencyKey: key,
  })
}

test('ACTIVE Partner creates one multi-item server-repriced immutable submission', async () => {
  const db = memoryDb()
  const result = await createPartner(db)
  assert.equal(result.reused, false)
  assert.equal(result.order.status, 'SUBMITTED')
  assert.equal(result.order.createdByType, 'PARTNER')
  assert.equal(result.order.createdByActorId, 'partner-user-a')
  assert.match(result.order.orderNo, /^RPL-\d{8}-[A-F0-9]{16}$/)
  assert.equal(result.order.partnerStoreId, 'store-a')
  assert.equal(result.order.requestedTotalAmountCents, 18200n)
  assert.deepEqual(result.order.items.map((row) => [row.inventoryItemId, row.requestedLineAmountCents]), [['kg', 11700n], ['pcs', 6500n]])
  assert.equal(db.getState().audits[0].action, 'REPLENISHMENT_ORDER_CREATED')
})

test('creation re-reads current KG price, PCS price and one Partner discount', async () => {
  const data = fixtures()
  data.products.find((row) => row.id === 'kg').partnerKgBasePriceCents = 19500n
  data.products.find((row) => row.id === 'pcs').salePriceCents = 600n
  data.partners.find((row) => row.id === 'partner-a').defaultDiscountBps = 6000
  const order = (await createPartner(memoryDb(data), 'repricing-000001')).order
  assert.deepEqual(order.items.map((row) => [row.basePriceSnapshotCents, row.discountBpsSnapshot, row.requestedLineAmountCents]), [
    [19500n, 6000, 11700n],
    [600n, 6000, 7200n],
  ])
  assert.equal(order.requestedTotalAmountCents, 18900n)
})

test('lifecycle, PartnerStore tenant/state and current Catalogue all fail closed', async () => {
  for (const [partnerId, message] of [['paused', /暂停/], ['terminated', /停止合作/]]) {
    const principal = partnerPrincipal(partnerId, `${partnerId}-user`)
    await assert.rejects(() => createPartner(memoryDb(), `key-${partnerId}-0001`, { partnerStoreId: 'store-a' }, principal), message)
  }
  await assert.rejects(() => createPartner(memoryDb(), 'wrong-store-0001', { partnerStoreId: 'store-b' }), /门店不存在/)
  await assert.rejects(() => createPartner(memoryDb(), 'off-store-00001', { partnerStoreId: 'store-a-off' }), /停用/)
  await assert.rejects(() => createPartner(memoryDb(), 'inactive-item-01', { items: [{ inventoryItemId: 'inactive', quantity: 1 }] }), /不可补货/)
  assert.equal((await createPartner(memoryDb(), 'moq-retired-0001', { items: [{ inventoryItemId: 'kg', quantity: 500 }] })).order.items[0].requestedQuantityBase, 500)
  assert.equal((await createPartner(memoryDb(), 'step-retired-001', { items: [{ inventoryItemId: 'kg', quantity: 1200 }] })).order.items[0].requestedQuantityBase, 1200)
  await assert.rejects(() => createPartner(memoryDb(), 'unit-tamper-0001', { items: [{ inventoryItemId: 'kg', orderUnit: 'PCS', quantity: 1000 }] }), /单位/)
  await assert.rejects(() => createPartner(memoryDb(), 'stale-actor-0001', {}, partnerPrincipal('partner-a', 'missing-user')), /身份已失效/)
})

test('client authority fields, duplicates, malformed quantities and empty orders are rejected', async () => {
  for (const [field, value] of [['partnerId', 'partner-b'], ['totalAmountCents', '1'], ['discountBps', 1], ['price', 1]]) {
    await assert.rejects(() => createPartner(memoryDb(), `tamper-${field}-0001`, { [field]: value }), /不接受客户端字段/)
  }
  for (const extra of [{ price: 1 }, { lineAmount: 1 }, { discountBps: 1 }]) {
    await assert.rejects(() => createPartner(memoryDb(), 'item-tamper-0001', { items: [{ inventoryItemId: 'kg', quantity: 1000, ...extra }] }), /不接受客户端字段/)
  }
  await assert.rejects(() => createPartner(memoryDb(), 'duplicate-item-01', { items: [{ inventoryItemId: 'kg', quantity: 1000 }, { inventoryItemId: 'kg', quantity: 1500 }] }), /不能重复/)
  await assert.rejects(() => createPartner(memoryDb(), 'empty-order-0001', { items: [] }), /必须包含/)
  for (const quantity of [1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => createPartner(memoryDb(), `bad-qty-${String(quantity).slice(0, 10)}-0001`, { items: [{ inventoryItemId: 'kg', quantity }] }))
  }
  await assert.rejects(() => createPartner(memoryDb(), 'short'), /Idempotency-Key/)
})

test('submitted snapshots survive later price, discount, name, unit, MOQ and address changes', async () => {
  const db = memoryDb()
  const created = (await createPartner(db)).order
  const source = db.getState()
  Object.assign(source.products.find((row) => row.id === 'kg'), { name: '新名称', partnerKgBasePriceCents: 19500n, partnerOrderUnit: 'PCS', partnerMinOrderBaseQty: 2000, partnerOrderStepBaseQty: 1000 })
  source.products.find((row) => row.id === 'pcs').salePriceCents = 900n
  source.partners.find((row) => row.id === 'partner-a').defaultDiscountBps = 6000
  Object.assign(source.stores.find((row) => row.id === 'store-a'), { name: '新门店', addressLine: '新地址' })
  assert.equal(created.requestedTotalAmountCents, 18200n)
  assert.deepEqual(created.items.map((row) => [row.productNameSnapshot, row.orderUnitSnapshot, row.basePriceSnapshotCents, row.discountBpsSnapshot, row.minimumOrderBaseQtySnapshot, row.orderStepBaseQtySnapshot]), [
    ['KG 糖', 'KG', 18000n, 6500, 1, 1],
    ['颗糖', 'PCS', 500n, 6500, 1, 1],
  ])
  assert.equal(created.partnerStoreNameSnapshot, 'A 门店')
  assert.equal(created.addressLineSnapshot, 'A 路1号')
})

test('persisted idempotency replays identity, rejects digest mismatch and scopes actors/Partners', async () => {
  const db = memoryDb()
  const first = await createPartner(db, 'idem-same-000001')
  const replay = await createPartner(db, 'idem-same-000001')
  assert.equal(replay.reused, true)
  assert.equal(replay.order.id, first.order.id)
  assert.equal(db.getState().orders.length, 1)
  for (const body of [
    { items: [{ inventoryItemId: 'kg', quantity: 1500 }] },
    { partnerStoreId: 'store-a-off' },
    { items: [{ inventoryItemId: 'pcs', quantity: 20 }] },
  ]) await assert.rejects(() => createPartner(db, 'idem-same-000001', body), /请求内容不一致/)

  const other = partnerPrincipal('partner-b', 'partner-user-b')
  const otherResult = await createPartner(db, 'idem-same-000001', { partnerStoreId: 'store-b' }, other)
  assert.notEqual(otherResult.order.id, first.order.id)
  assert.equal(db.getState().orders.length, 2)
})

test('concurrent same-key calls commit one order and transaction failure leaves no half order', async () => {
  const db = memoryDb()
  const results = await Promise.all([createPartner(db, 'concurrent-00001'), createPartner(db, 'concurrent-00001')])
  assert.equal(new Set(results.map((row) => row.order.id)).size, 1)
  assert.equal(results.filter((row) => row.reused).length, 1)
  assert.equal(db.getState().orders.length, 1)
  assert.equal(db.getState().audits.length, 1)

  const failing = memoryDb()
  failing.failNextAudit()
  await assert.rejects(() => createPartner(failing, 'audit-fail-00001'), /audit failure/)
  assert.equal(failing.getState().orders.length, 0)
  assert.equal(failing.getState().audits.length, 0)
})

test('Partner reads/cancels only own SUBMITTED order and repeated cancel is idempotent', async () => {
  const db = memoryDb()
  const order = (await createPartner(db)).order
  const principal = partnerPrincipal()
  assert.equal((await listPartnerReplenishmentOrders({ db, principal })).length, 1)
  assert.equal((await listPartnerReplenishmentOrders({ db, principal: partnerPrincipal('partner-b', 'partner-user-b') })).length, 0)
  assert.equal((await getPartnerReplenishmentOrder({ db, principal, orderId: order.id })).id, order.id)
  assert.equal(await getPartnerReplenishmentOrder({ db, principal: partnerPrincipal('partner-b', 'partner-user-b'), orderId: order.id }), null)
  await assert.rejects(() => cancelPartnerReplenishmentOrder({ db, principal: partnerPrincipal('partner-b', 'partner-user-b'), orderId: order.id }), /不存在/)
  const cancelled = await cancelPartnerReplenishmentOrder({ db, principal, orderId: order.id })
  assert.equal(cancelled.order.status, 'CANCELLED')
  assert.equal(cancelled.order.items.length, 2)
  assert.equal(cancelled.reused, false)
  const replay = await cancelPartnerReplenishmentOrder({ db, principal, orderId: order.id })
  assert.equal(replay.reused, true)
  assert.equal(db.getState().audits.filter((row) => row.action === 'REPLENISHMENT_ORDER_CANCELLED').length, 1)
})

test('concurrent Partner cancellation produces one transition and one audit', async () => {
  const db = memoryDb()
  const order = (await createPartner(db)).order
  const results = await Promise.all([
    cancelPartnerReplenishmentOrder({ db, principal: partnerPrincipal(), orderId: order.id }),
    cancelPartnerReplenishmentOrder({ db, principal: partnerPrincipal(), orderId: order.id }),
  ])
  assert.equal(results.filter((row) => row.reused).length, 1)
  assert.equal(results.every((row) => row.order.status === 'CANCELLED'), true)
  assert.equal(db.getState().audits.filter((row) => row.action === 'REPLENISHMENT_ORDER_CANCELLED').length, 1)
})

test('Internal developer/admin route uses the same service while staff/Partner are denied', async () => {
  const db = memoryDb()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { const role = req.get('x-test-role') || 'staff'; req.user = { id: `${role}-1`, username: role, role, status: 'active' }; next() })
  app.use('/api/v2', createPartnerDomainRouter({ db, mirrorUsers: async () => {} }))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = (role, key) => fetch(`${origin}/api/v2/partner-management/replenishment-orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': role, 'idempotency-key': key }, body: JSON.stringify({ partnerId: 'partner-a', ...partnerBody() }) })
  const read = (role, suffix = '') => fetch(`${origin}/api/v2/partner-management/replenishment-orders${suffix}`, { headers: { 'x-test-role': role } })
  try {
    assert.equal((await request('staff', 'internal-staff-01')).status, 403)
    assert.equal((await request('partner', 'internal-partner-1')).status, 403)
    assert.equal((await read('staff')).status, 403)
    assert.equal((await read('partner')).status, 403)
    const developerResponse = await request('developer', 'internal-dev-0001')
    assert.equal(developerResponse.status, 201)
    const developerOrder = (await developerResponse.json()).order
    assert.equal(developerOrder.createdByType, 'INTERNAL')
    assert.equal(developerOrder.createdByActorId, 'developer-1')
    assert.equal(developerOrder.requestedTotalAmountCents, '18200')
    assert.deepEqual(developerOrder.items.map((row) => [row.orderUnitSnapshot, row.basePriceSnapshotCents, row.discountBpsSnapshot, row.requestedLineAmountCents]), [
      ['KG', '18000', 6500, '11700'],
      ['PCS', '500', 6500, '6500'],
    ])
    const listResponse = await read('developer')
    assert.equal(listResponse.status, 200)
    assert.equal((await listResponse.json()).rows.length, 1)
    const detailResponse = await read('admin', `/${developerOrder.id}`)
    assert.equal(detailResponse.status, 200)
    assert.equal((await detailResponse.json()).order.id, developerOrder.id)
    const adminResponse = await request('admin', 'internal-admin-001')
    assert.equal(adminResponse.status, 201)
    assert.equal((await adminResponse.json()).order.createdByActorId, 'admin-1')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Partner DTO excludes idempotency, internal actor, audit, inventory and cost internals', async () => {
  const order = (await createPartner(memoryDb())).order
  const dto = serializeReplenishmentOrder(order)
  const json = JSON.stringify(dto)
  for (const forbidden of ['idempotencyKey', 'idempotencyScope', 'createdByActorId', 'actorUsername', 'costPriceCents', 'stockQty', 'availableQty']) assert.doesNotMatch(json, new RegExp(forbidden))
  assert.equal(dto.items[0].productNameSnapshot, 'KG 糖')
})

test('PGlite migration proves constraints, unique idempotency, atomic rollback and snapshot persistence', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "Partner" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "defaultDiscountBps" INTEGER NOT NULL, "status" TEXT NOT NULL);
    CREATE TABLE "PartnerStore" ("id" TEXT PRIMARY KEY, "partnerId" TEXT NOT NULL, "name" TEXT NOT NULL, "contactName" TEXT NOT NULL DEFAULT '', "phone" TEXT NOT NULL DEFAULT '', "province" TEXT NOT NULL DEFAULT '', "city" TEXT NOT NULL DEFAULT '', "district" TEXT NOT NULL DEFAULT '', "addressLine" TEXT NOT NULL DEFAULT '', "status" TEXT NOT NULL DEFAULT 'ACTIVE');
    CREATE UNIQUE INDEX "PartnerStore_partnerId_name_key" ON "PartnerStore"("partnerId", "name");
    CREATE TABLE "InventoryItem" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "sku" TEXT, "salePriceCents" BIGINT, "partnerKgBasePriceCents" BIGINT, "transferBoxEnabled" BOOLEAN NOT NULL DEFAULT FALSE, "transferBoxWeightGrams" INTEGER, "partnerSupplyEnabled" BOOLEAN NOT NULL DEFAULT FALSE);
    INSERT INTO "Partner" VALUES ('partner-a', 'Partner A', 6500, 'ACTIVE');
    INSERT INTO "PartnerStore" ("id", "partnerId", "name", "contactName", "addressLine") VALUES ('store-a', 'partner-a', 'A 门店', 'A 联系人', 'A 路1号');
    INSERT INTO "InventoryItem" ("id", "name", "sku", "salePriceCents", "partnerKgBasePriceCents", "transferBoxEnabled", "transferBoxWeightGrams", "partnerSupplyEnabled") VALUES ('kg', 'KG 糖', 'KG-1', 500, 18000, TRUE, 2500, TRUE);
  `)
  const migration = await readFile(new URL('../prisma/migrations/20260907100000_replenishment_order_core/migration.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const insertOrder = (id, digest = 'a'.repeat(64)) => db.query(`INSERT INTO "ReplenishmentOrder" ("id", "orderNo", "partnerId", "partnerStoreId", "partnerNameSnapshot", "partnerStoreNameSnapshot", "contactNameSnapshot", "addressLineSnapshot", "createdByType", "createdByActorId", "requestedTotalAmountCents", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES ($1, $2, 'partner-a', 'store-a', 'Partner A', 'A 门店', 'A 联系人', 'A 路1号', 'PARTNER', 'partner-user-a', 11700, 'scope-a', 'same-key-0001', $3)`, [id, `RPL-${id}`, digest])
  const concurrent = await Promise.allSettled([insertOrder('one'), insertOrder('two')])
  assert.equal(concurrent.filter((row) => row.status === 'fulfilled').length, 1)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "ReplenishmentOrder"')).rows[0].count, 1)

  await assert.rejects(() => db.transaction(async (tx) => {
    await tx.query(`INSERT INTO "ReplenishmentOrder" ("id", "orderNo", "partnerId", "partnerStoreId", "partnerNameSnapshot", "partnerStoreNameSnapshot", "createdByType", "createdByActorId", "requestedTotalAmountCents", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest") VALUES ('rollback', 'RPL-ROLLBACK', 'partner-a', 'store-a', 'Partner A', 'A 门店', 'PARTNER', 'partner-user-a', 1, 'scope-b', 'rollback-0001', $1)`, ['b'.repeat(64)])
    await tx.query(`INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "orderUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot") VALUES ('bad-item', 'rollback', 'kg', 'KG 糖', 'KG', -1, 18000, 6500, 1, 1000, 500)`)
  }))
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM "ReplenishmentOrder" WHERE "id"='rollback'`)).rows[0].count, 0)

  const orderId = (await db.query('SELECT "id" FROM "ReplenishmentOrder" LIMIT 1')).rows[0].id
  await db.query(`INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "skuSnapshot", "productCodeSnapshot", "orderUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot") VALUES ('item-one', $1, 'kg', 'KG 糖', 'KG-1', 'NO.1', 'KG', 1000, 18000, 6500, 11700, 1000, 500)`, [orderId])
  await db.exec(`UPDATE "Partner" SET "defaultDiscountBps"=6000; UPDATE "PartnerStore" SET "name"='新门店', "addressLine"='新地址'; UPDATE "InventoryItem" SET "name"='新名称', "partnerKgBasePriceCents"=19500;`)
  const snapshot = (await db.query(`SELECT i."productNameSnapshot", i."basePriceSnapshotCents", i."discountBpsSnapshot", o."partnerStoreNameSnapshot", o."addressLineSnapshot" FROM "ReplenishmentOrderItem" i JOIN "ReplenishmentOrder" o ON o."id"=i."replenishmentOrderId" WHERE i."id"='item-one'`)).rows[0]
  assert.deepEqual(snapshot, { productNameSnapshot: 'KG 糖', basePriceSnapshotCents: 18000, discountBpsSnapshot: 6500, partnerStoreNameSnapshot: 'A 门店', addressLineSnapshot: 'A 路1号' })
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrder" SET "requestedTotalAmountCents"=1 WHERE "id"=$1`, [orderId]), /SNAPSHOT_IMMUTABLE/)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrderItem" SET "requestedQuantityBase"=2000 WHERE "id"='item-one'`), /SNAPSHOT_IMMUTABLE/)
  await assert.rejects(() => db.query(`DELETE FROM "ReplenishmentOrderItem" WHERE "id"='item-one'`), /DELETE_FORBIDDEN/)
  await assert.rejects(() => db.query(`DELETE FROM "ReplenishmentOrder" WHERE "id"=$1`, [orderId]), /DELETE_FORBIDDEN/)
  const legacy = (await db.query(`SELECT "transferBoxEnabled", "transferBoxWeightGrams", "partnerSupplyEnabled" FROM "InventoryItem" WHERE "id"='kg'`)).rows[0]
  assert.deepEqual(legacy, { transferBoxEnabled: true, transferBoxWeightGrams: 2500, partnerSupplyEnabled: true })
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrder" SET "status"='CANCELLED' WHERE "id"=$1`, [orderId]))
  await db.query(`UPDATE "ReplenishmentOrder" SET "status"='CANCELLED', "cancelledAt"=CURRENT_TIMESTAMP, "cancelledByType"='PARTNER', "cancelledByActorId"='partner-user-a' WHERE "id"=$1`, [orderId])
  await db.close()
})

test('Gate 4 create path has no StockLedger, Payment or Shipment write and no mutable requested update path', async () => {
  const [service, partnerRoutes, internalRoutes, migration] = await Promise.all([
    readFile(new URL('../server/replenishment-order-service.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/partner-auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/partner-domain.js', import.meta.url), 'utf8'),
    readFile(new URL('../prisma/migrations/20260907100000_replenishment_order_core/migration.sql', import.meta.url), 'utf8'),
  ])
  assert.match(partnerRoutes, /router\.post\('\/replenishment-orders'/)
  assert.match(partnerRoutes, /partnerScopedWhere|principal\.partnerId/)
  assert.match(internalRoutes, /canManagePartnerDomain/)
  assert.doesNotMatch(service, /(?:stockLedger|payment|replenishmentShipment)\.(?:create|update|delete|upsert)/i)
  assert.doesNotMatch(migration, /^\s*(DROP|TRUNCATE|DELETE)\b/im)
  assert.doesNotMatch(service, /updateMany\(\{[\s\S]{0,800}requestedQuantityBase/)
})
