import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import {
  REPLENISHMENT_REVIEW_ACTIONS,
  getReplenishmentReviewOrder,
  listReplenishmentReviewOrders,
  previewReplenishmentApproval,
  reviewReplenishmentOrder,
} from '../server/replenishment-review-service.js'
import { authorizeReplenishmentReviewer } from '../server/replenishment-review-authorization.js'
import { cancelPartnerReplenishmentOrder, serializeReplenishmentOrder } from '../server/replenishment-order-service.js'
import { MODULE_KEYS, hasModuleAccess } from '../shared/accountPermissions.js'

const beijingMonday = new Date('2026-09-06T16:30:00.000Z')

function submittedOrder(id = 'order-1') {
  return {
    id,
    orderNo: `RPL-${id}`,
    partnerId: 'partner-a',
    partnerStoreId: 'partner-store-a',
    partnerNameSnapshot: 'Partner A',
    partnerStoreNameSnapshot: 'A 门店',
    contactNameSnapshot: 'A 联系人',
    phoneSnapshot: '13800000001',
    provinceSnapshot: '河北省',
    citySnapshot: '秦皇岛市',
    districtSnapshot: '海港区',
    addressLineSnapshot: 'A 路1号',
    status: 'SUBMITTED',
    createdByType: 'PARTNER',
    createdByActorId: 'partner-user-a',
    createdByActorName: 'partner_a',
    submittedAt: new Date('2026-09-07T00:00:00.000Z'),
    cancelledAt: null,
    cancelledByType: null,
    cancelledByActorId: '',
    cancelledByActorName: '',
    requestedTotalAmountCents: 149500n,
    approvedTotalAmountCents: null,
    reviewAction: null,
    reviewReason: '',
    reviewedAt: null,
    reviewedByActorId: '',
    reviewedByActorName: '',
    reviewIdempotencyScope: null,
    reviewIdempotencyKey: null,
    reviewPayloadDigest: null,
    idempotencyScope: `PARTNER:partner-user-a:partner-a:CREATE:${id}`,
    idempotencyKey: `create-${id}`,
    idempotencyPayloadDigest: 'a'.repeat(64),
    version: 1,
    createdAt: new Date('2026-09-07T00:00:00.000Z'),
    updatedAt: new Date('2026-09-07T00:00:00.000Z'),
    items: [
      {
        id: `${id}-kg`, replenishmentOrderId: id, inventoryItemId: 'kg', productNameSnapshot: 'KG 糖', skuSnapshot: 'KG-1', productCodeSnapshot: 'NO.1', orderUnitSnapshot: 'KG',
        requestedQuantityBase: 10000, basePriceSnapshotCents: 18000n, discountBpsSnapshot: 6500, requestedLineAmountCents: 117000n,
        minimumOrderBaseQtySnapshot: 1000, orderStepBaseQtySnapshot: 500, approvedQuantityBase: null, approvedLineAmountCents: null, reviewReason: '', createdAt: new Date('2026-09-07T00:00:00.000Z'),
      },
      {
        id: `${id}-pcs`, replenishmentOrderId: id, inventoryItemId: 'pcs', productNameSnapshot: '颗糖', skuSnapshot: 'PCS-1', productCodeSnapshot: 'NO.2', orderUnitSnapshot: 'PCS',
        requestedQuantityBase: 100, basePriceSnapshotCents: 500n, discountBpsSnapshot: 6500, requestedLineAmountCents: 32500n,
        minimumOrderBaseQtySnapshot: 20, orderStepBaseQtySnapshot: 10, approvedQuantityBase: null, approvedLineAmountCents: null, reviewReason: '', createdAt: new Date('2026-09-07T00:00:00.000Z'),
      },
    ],
  }
}

function fixtures() {
  return {
    users: [
      { id: 'developer', username: 'developer', role: 'developer', status: 'active', employeeId: '' },
      { id: 'admin', username: 'admin', role: 'admin', status: 'active', employeeId: '' },
      { id: 'duty', username: 'duty', role: 'manager', status: 'active', employeeId: 'emp-duty' },
      { id: 'same-name-other', username: 'same_name', role: 'staff', status: 'active', employeeId: 'emp-same-name-other' },
      { id: 'other-store', username: 'other_store', role: 'staff', status: 'active', employeeId: 'emp-other-store' },
      { id: 'yesterday', username: 'yesterday', role: 'staff', status: 'active', employeeId: 'emp-yesterday' },
      { id: 'unbound', username: 'unbound', role: 'staff', status: 'active', employeeId: '' },
      { id: 'finance', username: 'finance', role: 'finance', status: 'active', employeeId: 'emp-finance' },
      { id: 'partner-user-a', username: 'partner_a', role: 'partner', status: 'active', employeeId: '' },
      { id: 'customer', username: 'customer', role: 'customer', status: 'active', employeeId: '' },
    ],
    stores: [{ key: 'guanshe', active: true }, { key: 'tongying', active: true }],
    employees: [
      { id: 'emp-duty', name: '同名员工', status: 'ACTIVE' },
      { id: 'emp-same-name-other', name: '同名员工', status: 'ACTIVE' },
      { id: 'emp-other-store', name: '其他门店', status: 'ACTIVE' },
      { id: 'emp-yesterday', name: '昨日值班', status: 'ACTIVE' },
      { id: 'emp-finance', name: '财务值班', status: 'ACTIVE' },
    ],
    schedules: [
      { id: 'schedule-today-guanshe', storeKey: 'guanshe', date: '2026-09-07', shifts: [{ employeeId: 'emp-duty', staff: '同名员工' }, { employeeId: 'emp-finance', staff: '财务值班' }] },
      { id: 'schedule-yesterday-guanshe', storeKey: 'guanshe', date: '2026-09-06', shifts: [{ employeeId: 'emp-yesterday', staff: '昨日值班' }] },
      { id: 'schedule-today-other', storeKey: 'tongying', date: '2026-09-07', shifts: [{ employeeId: 'emp-other-store', staff: '其他门店' }, { employeeId: 'emp-same-name-other', staff: '同名员工' }] },
    ],
    orders: [submittedOrder()],
    audits: [],
  }
}

function memoryDb(initial = fixtures()) {
  let state = structuredClone(initial)
  let queue = Promise.resolve()
  let failNextAudit = false
  const include = (row) => row ? structuredClone(row) : null

  const client = (source) => ({
    user: { findUnique: async ({ where }) => include(source.users.find((row) => row.id === where.id)) },
    store: { findUnique: async ({ where }) => include(source.stores.find((row) => row.key === where.key)) },
    employee: { findUnique: async ({ where }) => include(source.employees.find((row) => row.id === where.id)) },
    schedule: { findMany: async ({ where, take }) => source.schedules.filter((row) => row.storeKey === where.storeKey && row.date === where.date).slice(0, take).map(include) },
    replenishmentOrder: {
      findUnique: async ({ where }) => {
        const compound = where.reviewIdempotencyScope_reviewIdempotencyKey
        return include(compound
          ? source.orders.find((row) => row.reviewIdempotencyScope === compound.reviewIdempotencyScope && row.reviewIdempotencyKey === compound.reviewIdempotencyKey)
          : source.orders.find((row) => row.id === where.id))
      },
      findFirst: async ({ where }) => include(source.orders.find((row) => (!where.id || row.id === where.id) && (!where.partnerId || row.partnerId === where.partnerId))),
      findMany: async ({ where = {} } = {}) => source.orders.filter((row) => !where.status || row.status === where.status).map(include),
      updateMany: async ({ where, data }) => {
        const row = source.orders.find((item) => item.id === where.id
          && (!where.partnerId || item.partnerId === where.partnerId)
          && (!where.status || item.status === where.status)
          && (!where.version || item.version === where.version)
          && (where.reviewAction !== null || item.reviewAction == null))
        if (!row) return { count: 0 }
        if (data.reviewIdempotencyScope && source.orders.some((other) => other.id !== row.id && other.reviewIdempotencyScope === data.reviewIdempotencyScope && other.reviewIdempotencyKey === data.reviewIdempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const next = structuredClone(data)
        if (next.version?.increment) next.version = row.version + next.version.increment
        Object.assign(row, next, { updatedAt: new Date() })
        return { count: 1 }
      },
    },
    replenishmentOrderItem: {
      updateMany: async ({ where, data }) => {
        const order = source.orders.find((row) => row.id === where.replenishmentOrderId)
        const item = order?.items.find((row) => row.id === where.id && row.approvedQuantityBase == null)
        if (!item) return { count: 0 }
        Object.assign(item, structuredClone(data))
        return { count: 1 }
      },
    },
    partnerAuditLog: {
      create: async ({ data }) => {
        if (failNextAudit) { failNextAudit = false; throw new Error('audit failure') }
        source.audits.push(structuredClone(data))
        return include(data)
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
  db.failNextAudit = () => { failNextAudit = true }
  return db
}

const approval = (orderId = 'order-1', overrides = {}) => ({
  version: 1,
  reason: '按本次备货计划确认',
  items: [
    { itemId: `${orderId}-kg`, approvedQuantityBase: 8000, reason: '本次确认 8kg' },
    { itemId: `${orderId}-pcs`, approvedQuantityBase: 120, reason: '增加至 120 颗' },
  ],
  ...overrides,
})

const review = (db, actor = 'developer', body = approval(), key = 'review-key-0001', action = REPLENISHMENT_REVIEW_ACTIONS.APPROVE, orderId = 'order-1') => reviewReplenishmentOrder({ db, actor: { id: actor }, orderId, action, body, idempotencyKey: key, now: beijingMonday })

test('approved quantity is independent: KG decreases, PCS increases and frozen amounts total authoritatively', async () => {
  const db = memoryDb()
  const result = await review(db)
  assert.equal(result.order.status, 'APPROVED')
  assert.equal(result.order.approvedTotalAmountCents, 132600n)
  assert.deepEqual(result.order.items.map((item) => [item.requestedQuantityBase, item.approvedQuantityBase, item.approvedLineAmountCents]), [
    [10000, 8000, 93600n],
    [100, 120, 39000n],
  ])
  assert.deepEqual(result.order.items.map((item) => [item.basePriceSnapshotCents, item.discountBpsSnapshot]), [[18000n, 6500], [500n, 6500]])
  assert.equal(db.getState().audits[0].action, 'REPLENISHMENT_ORDER_APPROVED')
  assert.equal(db.getState().audits[0].after.decisions.length, 2)
})

test('existing lines can increase, decrease or become zero, but all-zero and new/missing lines fail closed', async () => {
  const removed = await review(memoryDb(), 'developer', approval('order-1', {
    items: [
      { itemId: 'order-1-kg', approvedQuantityBase: 12000, reason: '增加至 12kg' },
      { itemId: 'order-1-pcs', approvedQuantityBase: 0, reason: '本次不发' },
    ],
  }), 'removed-line-001')
  assert.equal(removed.order.items[0].approvedQuantityBase, 12000)
  assert.equal(removed.order.items[1].approvedQuantityBase, 0)
  assert.equal(removed.order.items.length, 2)
  assert.equal(removed.order.approvedTotalAmountCents, 140400n)

  const pcsDecrease = await review(memoryDb(), 'developer', approval('order-1', {
    items: [
      { itemId: 'order-1-kg', approvedQuantityBase: 10000, reason: '' },
      { itemId: 'order-1-pcs', approvedQuantityBase: 80, reason: '减少至 80 颗' },
    ],
  }), 'pcs-decrease-0001')
  assert.equal(pcsDecrease.order.items[1].approvedQuantityBase, 80)
  assert.equal(pcsDecrease.order.items[1].approvedLineAmountCents, 26000n)

  await assert.rejects(() => review(memoryDb(), 'developer', approval('order-1', { items: [
    { itemId: 'order-1-kg', approvedQuantityBase: 0, reason: '不发' },
    { itemId: 'order-1-pcs', approvedQuantityBase: 0, reason: '不发' },
  ] }), 'all-zero-000001'), /整单驳回/)
  await assert.rejects(() => review(memoryDb(), 'developer', approval('order-1', { items: [
    { itemId: 'order-1-kg', approvedQuantityBase: 8000, reason: '调整' },
    { itemId: 'new-sku', approvedQuantityBase: 20, reason: '新增' },
  ] }), 'new-sku-0000001'), /非原申请|不得新增/)
  await assert.rejects(() => review(memoryDb(), 'developer', approval('order-1', { items: [
    { itemId: 'order-1-kg', approvedQuantityBase: 8000, reason: '调整' },
  ] }), 'missing-line-0001'), /原申请全部商品/)
})

test('approved quantities reject fractional base units and client authority fields', async () => {
  for (const [quantity, pattern] of [[1.5, /安全整数/]]) {
    await assert.rejects(() => review(memoryDb(), 'developer', approval('order-1', { items: [
      { itemId: 'order-1-kg', approvedQuantityBase: quantity, reason: '调整' },
      { itemId: 'order-1-pcs', approvedQuantityBase: 100, reason: '' },
    ] }), `invalid-qty-${String(quantity).replace('.', '-')}-0001`), pattern)
  }
  for (const [field, value] of [['approvedTotalAmountCents', 1], ['basePriceSnapshotCents', 1], ['discountBpsSnapshot', 1], ['orderUnit', 'PCS']]) {
    const body = field === 'approvedTotalAmountCents'
      ? { ...approval(), [field]: value }
      : { ...approval(), items: [{ ...approval().items[0], [field]: value }, approval().items[1]] }
    await assert.rejects(() => review(memoryDb(), 'developer', body, `tamper-${field}-0001`), /不接受客户端字段/)
  }
  await assert.rejects(() => review(memoryDb(), 'developer', approval('order-1', { items: [
    { itemId: 'order-1-kg', approvedQuantityBase: 8000, reason: '' },
    approval().items[1],
  ] }), 'missing-reason-01'), /必须填写该行说明/)
})

test('preview and final review both calculate only from Gate 4 frozen KG/PCS price and discount snapshots', async () => {
  const db = memoryDb()
  const before = structuredClone(db.getState().orders[0])
  // Simulate later catalogue and Partner-master changes. Gate 5 has no path to
  // these current values; the submitted order snapshots remain authoritative.
  db.getState().currentCatalogue = { kgBasePriceCents: 19500n, pcsSalePriceCents: 600n }
  db.getState().currentPartnerDiscountBps = 6000
  const preview = await previewReplenishmentApproval({ db, actor: { id: 'developer' }, orderId: 'order-1', body: approval(), now: beijingMonday })
  assert.equal(preview.approvedTotalAmountCents, '132600')
  assert.deepEqual(preview.items.map((item) => item.approvedLineAmountCents), ['93600', '39000'])
  const result = await review(db)
  assert.equal(result.order.approvedTotalAmountCents, 132600n)
  assert.equal(result.order.requestedTotalAmountCents, before.requestedTotalAmountCents)
  assert.deepEqual(result.order.items.map((item) => [item.requestedQuantityBase, item.requestedLineAmountCents]), before.items.map((item) => [item.requestedQuantityBase, item.requestedLineAmountCents]))
})

test('approve and reject state machine is terminal; Partner cancellation after approval is blocked', async () => {
  const approvedDb = memoryDb()
  await review(approvedDb)
  await assert.rejects(() => review(approvedDb, 'admin', approval(), 'second-review-001'), /已被其他审核人处理/)
  await assert.rejects(() => cancelPartnerReplenishmentOrder({ db: approvedDb, principal: { type: 'PARTNER', partnerId: 'partner-a', userId: 'partner-user-a', partnerUserId: 'binding-a' }, orderId: 'order-1' }), /不允许合作商取消/)

  const rejectedDb = memoryDb()
  const rejected = await review(rejectedDb, 'admin', { version: 1, reason: '本次无法安排供货' }, 'reject-key-00001', REPLENISHMENT_REVIEW_ACTIONS.REJECT)
  assert.equal(rejected.order.status, 'REJECTED')
  assert.equal(rejected.order.approvedTotalAmountCents, null)
  assert.equal(rejected.order.reviewReason, '本次无法安排供货')
  assert.equal(rejectedDb.getState().audits[0].action, 'REPLENISHMENT_ORDER_REJECTED')
  await assert.rejects(() => review(rejectedDb, 'developer', approval(), 'after-reject-0001'), /已被其他审核人处理/)
})

test('Developer/Admin and Guanshe today duty pass; other identities and schedules fail closed', async () => {
  const db = memoryDb()
  for (const actor of ['developer', 'admin', 'duty']) {
    const result = await authorizeReplenishmentReviewer({ db, actor: { id: actor }, now: beijingMonday })
    assert.equal(result.actor.id, actor)
  }
  for (const actor of ['same-name-other', 'other-store', 'yesterday', 'unbound', 'finance', 'partner-user-a', 'customer']) {
    await assert.rejects(() => authorizeReplenishmentReviewer({ db, actor: { id: actor }, now: beijingMonday }), /无补货审核权限/)
  }
  assert.equal((await authorizeReplenishmentReviewer({ db, actor: { id: 'duty' }, now: beijingMonday })).businessDate, '2026-09-07')
  const dutyReviewDb = memoryDb()
  await review(dutyReviewDb, 'duty', approval(), 'duty-review-0001')
  assert.equal(dutyReviewDb.getState().audits[0].actorUserId, 'duty')
  assert.equal(dutyReviewDb.getState().audits[0].after.reviewerEmployeeId, 'emp-duty')
  db.getState().schedules.find((row) => row.id === 'schedule-today-guanshe').shifts = []
  await assert.rejects(() => authorizeReplenishmentReviewer({ db, actor: { id: 'duty' }, now: beijingMonday }), /无补货审核权限/)
})

test('review idempotency replays one result and rejects payload mismatch or key reuse on another order', async () => {
  const data = fixtures()
  data.orders.push(submittedOrder('order-2'))
  const db = memoryDb(data)
  const first = await review(db, 'developer', approval(), 'same-review-key1')
  const replayed = await review(db, 'developer', approval(), 'same-review-key1')
  assert.equal(replayed.reused, true)
  assert.equal(replayed.order.id, first.order.id)
  assert.equal(db.getState().audits.length, 1)
  await assert.rejects(() => review(db, 'developer', approval('order-1', { items: [
    { itemId: 'order-1-kg', approvedQuantityBase: 9000, reason: '调整' },
    approval().items[1],
  ] }), 'same-review-key1'), /内容不一致/)
  await assert.rejects(() => review(db, 'developer', approval('order-2'), 'same-review-key1', REPLENISHMENT_REVIEW_ACTIONS.APPROVE, 'order-2'), /内容不一致/)
})

test('two reviewers and approve-vs-reject races commit exactly one review and one audit', async () => {
  const sameActionDb = memoryDb()
  const sameAction = await Promise.allSettled([
    review(sameActionDb, 'developer', approval(), 'race-developer-1'),
    review(sameActionDb, 'admin', approval(), 'race-admin-0001'),
  ])
  assert.equal(sameAction.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(sameActionDb.getState().audits.length, 1)

  const mixedDb = memoryDb()
  const mixed = await Promise.allSettled([
    review(mixedDb, 'developer', approval(), 'race-approve-01'),
    review(mixedDb, 'admin', { version: 1, reason: '驳回' }, 'race-reject-001', REPLENISHMENT_REVIEW_ACTIONS.REJECT),
  ])
  assert.equal(mixed.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(mixedDb.getState().audits.length, 1)
})

test('audit failure rolls back line decisions, order status, idempotency and audit atomically', async () => {
  const db = memoryDb()
  db.failNextAudit()
  await assert.rejects(() => review(db), /audit failure/)
  const order = db.getState().orders[0]
  assert.equal(order.status, 'SUBMITTED')
  assert.equal(order.reviewIdempotencyKey, null)
  assert.equal(order.items.every((item) => item.approvedQuantityBase == null), true)
  assert.equal(db.getState().audits.length, 0)
})

test('Partner DTO shows requested vs approved/removed and safe reason without reviewer or security internals', async () => {
  const result = await review(memoryDb(), 'developer', approval('order-1', { items: [
    { itemId: 'order-1-kg', approvedQuantityBase: 8000, reason: '确认 8kg' },
    { itemId: 'order-1-pcs', approvedQuantityBase: 0, reason: '本次不发' },
  ] }), 'partner-view-001')
  const dto = serializeReplenishmentOrder(result.order)
  assert.deepEqual(dto.items.map((item) => [item.requestedQuantityBase, item.approvedQuantityBase]), [[10000, 8000], [100, 0]])
  assert.equal(dto.items[1].reviewReason, '本次不发')
  const json = JSON.stringify(dto)
  for (const forbidden of ['reviewedByActorId', 'reviewedByActorName', 'reviewIdempotency', 'costPrice', 'stockQty', 'passwordHash']) assert.doesNotMatch(json, new RegExp(forbidden))

  const rejected = await review(memoryDb(), 'admin', { version: 1, reason: '本次无法安排供货' }, 'partner-reject-01', REPLENISHMENT_REVIEW_ACTIONS.REJECT)
  const rejectedDto = serializeReplenishmentOrder(rejected.order)
  assert.equal(rejectedDto.status, 'REJECTED')
  assert.equal(rejectedDto.reviewReason, '本次无法安排供货')
  assert.equal(rejectedDto.items.every((item) => item.requestedQuantityBase > 0 && item.approvedQuantityBase == null), true)
})

test('review queue/detail authorization is dynamic and status-filtered', async () => {
  const db = memoryDb()
  const list = await listReplenishmentReviewOrders({ db, actor: { id: 'duty' }, status: 'SUBMITTED', now: beijingMonday })
  assert.equal(list.rows.length, 1)
  assert.equal(list.authorization.authority, 'GUANSHE_ON_DUTY')
  assert.equal((await getReplenishmentReviewOrder({ db, actor: { id: 'duty' }, orderId: 'order-1', now: beijingMonday })).order.id, 'order-1')
  await assert.rejects(() => listReplenishmentReviewOrders({ db, actor: { id: 'finance' }, now: beijingMonday }), /无补货审核权限/)
})

test('review navigation is a narrow candidate shell and does not grant Partner master access', () => {
  for (const role of ['developer', 'admin', 'manager', 'staff']) {
    assert.equal(hasModuleAccess({ role, status: 'active' }, MODULE_KEYS.PARTNER_REPLENISHMENT_REVIEW), true, role)
  }
  for (const role of ['finance', 'cashier', 'partner', 'customer', 'public']) {
    assert.equal(hasModuleAccess({ role, status: 'active' }, MODULE_KEYS.PARTNER_REPLENISHMENT_REVIEW), false, role)
  }
  for (const role of ['manager', 'staff']) {
    assert.equal(hasModuleAccess({ role, status: 'active' }, MODULE_KEYS.PARTNER_MANAGEMENT), false, role)
  }
})

test('PGlite migration enforces review state, append-only decisions and immutable Gate 4 snapshots', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "Partner" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "defaultDiscountBps" INTEGER NOT NULL, "status" TEXT NOT NULL);
    CREATE TABLE "PartnerStore" ("id" TEXT PRIMARY KEY, "partnerId" TEXT NOT NULL, "name" TEXT NOT NULL, "contactName" TEXT NOT NULL DEFAULT '', "phone" TEXT NOT NULL DEFAULT '', "province" TEXT NOT NULL DEFAULT '', "city" TEXT NOT NULL DEFAULT '', "district" TEXT NOT NULL DEFAULT '', "addressLine" TEXT NOT NULL DEFAULT '', "status" TEXT NOT NULL DEFAULT 'ACTIVE');
    CREATE UNIQUE INDEX "PartnerStore_partnerId_name_key" ON "PartnerStore"("partnerId", "name");
    CREATE TABLE "InventoryItem" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "sku" TEXT, "salePriceCents" BIGINT, "partnerKgBasePriceCents" BIGINT, "transferBoxEnabled" BOOLEAN NOT NULL DEFAULT FALSE, "transferBoxWeightGrams" INTEGER, "partnerSupplyEnabled" BOOLEAN NOT NULL DEFAULT FALSE);
    INSERT INTO "Partner" VALUES ('partner-a', 'Partner A', 6500, 'ACTIVE');
    INSERT INTO "PartnerStore" ("id", "partnerId", "name") VALUES ('store-a', 'partner-a', 'A 门店');
    INSERT INTO "InventoryItem" ("id", "name", "sku", "salePriceCents", "partnerKgBasePriceCents") VALUES ('kg', 'KG 糖', 'KG-1', 500, 18000), ('pcs', '颗糖', 'PCS-1', 500, NULL);
  `)
  await db.exec(await readFile(new URL('../prisma/migrations/20260907100000_replenishment_order_core/migration.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../prisma/migrations/20260907200000_replenishment_review/migration.sql', import.meta.url), 'utf8'))
  await db.exec(`
    INSERT INTO "ReplenishmentOrder" ("id", "orderNo", "partnerId", "partnerStoreId", "partnerNameSnapshot", "partnerStoreNameSnapshot", "createdByType", "createdByActorId", "requestedTotalAmountCents", "idempotencyScope", "idempotencyKey", "idempotencyPayloadDigest")
      VALUES ('order-1', 'RPL-1', 'partner-a', 'store-a', 'Partner A', 'A 门店', 'PARTNER', 'partner-user-a', 149500, 'create-scope', 'create-key-001', '${'a'.repeat(64)}');
    INSERT INTO "ReplenishmentOrderItem" ("id", "replenishmentOrderId", "inventoryItemId", "productNameSnapshot", "orderUnitSnapshot", "requestedQuantityBase", "basePriceSnapshotCents", "discountBpsSnapshot", "requestedLineAmountCents", "minimumOrderBaseQtySnapshot", "orderStepBaseQtySnapshot") VALUES
      ('kg-line', 'order-1', 'kg', 'KG 糖', 'KG', 10000, 18000, 6500, 117000, 1000, 500),
      ('pcs-line', 'order-1', 'pcs', '颗糖', 'PCS', 100, 500, 6500, 32500, 20, 10);
  `)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrder" SET "requestedTotalAmountCents"=1 WHERE "id"='order-1'`), /SNAPSHOT_IMMUTABLE/)
  await db.exec(`
    UPDATE "ReplenishmentOrderItem" SET "approvedQuantityBase"=8000, "approvedLineAmountCents"=93600, "reviewReason"='确认 8kg' WHERE "id"='kg-line';
    UPDATE "ReplenishmentOrderItem" SET "approvedQuantityBase"=0, "approvedLineAmountCents"=0, "reviewReason"='本次不发' WHERE "id"='pcs-line';
    UPDATE "ReplenishmentOrder" SET "status"='APPROVED', "approvedTotalAmountCents"=93600, "reviewAction"='APPROVE', "reviewReason"='确认', "reviewedAt"=CURRENT_TIMESTAMP, "reviewedByActorId"='developer', "reviewedByActorName"='developer', "reviewIdempotencyScope"='developer:review', "reviewIdempotencyKey"='review-key-001', "reviewPayloadDigest"='${'b'.repeat(64)}', "version"=2 WHERE "id"='order-1';
  `)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrderItem" SET "approvedQuantityBase"=9000 WHERE "id"='kg-line'`), /REVIEW_ITEM_IMMUTABLE/)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrder" SET "approvedTotalAmountCents"=1 WHERE "id"='order-1'`), /REVIEW_IMMUTABLE/)
  await assert.rejects(() => db.query(`UPDATE "ReplenishmentOrder" SET "status"='SUBMITTED' WHERE "id"='order-1'`), /STATE_TRANSITION_FORBIDDEN|REVIEW_IMMUTABLE/)
  const rows = (await db.query(`SELECT "requestedQuantityBase", "approvedQuantityBase", "reviewReason" FROM "ReplenishmentOrderItem" ORDER BY "id"`)).rows
  assert.deepEqual(rows, [
    { requestedQuantityBase: 10000, approvedQuantityBase: 8000, reviewReason: '确认 8kg' },
    { requestedQuantityBase: 100, approvedQuantityBase: 0, reviewReason: '本次不发' },
  ])
  await db.close()
})

test('Gate 5 review path cannot write stock, payment or Shipment and has no Partner review route', async () => {
  const [service, routes, partnerRoutes, migration] = await Promise.all([
    readFile(new URL('../server/replenishment-review-service.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/partner-domain.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/partner-auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../prisma/migrations/20260907200000_replenishment_review/migration.sql', import.meta.url), 'utf8'),
  ])
  assert.match(routes, /replenishment-orders\/:id\/approve/)
  assert.match(routes, /replenishment-orders\/:id\/reject/)
  assert.doesNotMatch(partnerRoutes, /replenishment-orders\/:id\/(approve|reject|review-preview)/)
  assert.doesNotMatch(service, /(?:stockLedger|payment|replenishmentShipment)\.(?:create|update|delete|upsert)/i)
  assert.doesNotMatch(migration, /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:StockLedger|Payment|Shipment)"?/i)
  assert.doesNotMatch(migration, /^\s*(TRUNCATE|DELETE|UPDATE)\s/im)
})
