import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'
import { applyProductSkuPlanOnTestDatabase } from '../server/product-sku-migration.js'
import { recordProductSkuAssignment, reserveProductSku } from '../server/product-sku-authority.js'
import { productsRouter } from '../server/products.js'

process.env.SKU_AUTHORITY_TEST_APPLY = 'YES'
const db = new PrismaClient()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = { id: 'sku-test-admin', role: 'admin', status: 'active' }
const makeId = () => `sku-test-${crypto.randomUUID()}`

async function seedLegacyProduct(data) {
  return db.$transaction(async (tx) => {
    const [mark] = await tx.$queryRaw`SELECT set_config('budu.sku_authority_writer', '1', true) AS value`
    assert.equal(mark.value, '1')
    return tx.inventoryItem.create({ data })
  })
}

async function historicalFacts(productId) {
  const [order, transfer, purchase, supply, replenishment] = await Promise.all([
    db.orderItem.findFirst({ where: { productId }, select: { productId: true, productNameSnapshot: true, skuSnapshot: true } }),
    db.transferItem.findFirst({ where: { itemId: productId }, select: { itemId: true, itemNameSnapshot: true, itemCodeSnapshot: true } }),
    db.purchaseItem.findFirst({ where: { itemId: productId }, select: { itemId: true, itemNameSnapshot: true } }),
    db.partnerSupplyItem.findFirst({ where: { productId }, select: { productId: true, productCodeSnapshot: true, productNameSnapshot: true } }),
    db.replenishmentOrderItem.findFirst({ where: { inventoryItemId: productId }, select: { inventoryItemId: true, productNameSnapshot: true, skuSnapshot: true, productCodeSnapshot: true } }),
  ])
  return { order, transfer, purchase, supply, replenishment }
}

async function waitForBlockedAllocator() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await db.$queryRaw`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query LIKE '%product_sku_sequences%'`
    if (rows.length) return
    await delay(100)
  }
  throw new Error('未观测到真实 PostgreSQL 行锁等待；并发证明失败')
}

async function createWithAllocatedSku(prefix, name, afterReserve = async () => {}) {
  return db.$transaction(async (tx) => {
    const sku = await reserveProductSku(tx, { source: prefix, user })
    await afterReserve()
    const itemId = makeId()
    await tx.inventoryItem.create({ data: { id: itemId, name, category: 'product', sku } })
    await recordProductSkuAssignment(tx, { sku, itemId, user, reason: 'PG16 contention test' })
    return { sku, itemId }
  }, { maxWait: 10000, timeout: 20000 })
}

async function proveAtomicProductCreationRollback() {
  const beforeProducts = await db.inventoryItem.count({ where: { category: 'product' } })
  const beforeAssignments = await db.productSkuAssignment.count()
  const beforeAudits = await db.sensitiveRecordAudit.count({ where: { action: 'product.sku.assign' } })
  await assert.rejects(db.$transaction(async (tx) => {
    const sku = await reserveProductSku(tx, { source: 'BD', user })
    const itemId = makeId()
    await tx.inventoryItem.create({ data: { id: itemId, name: '故障回滚商品', category: 'product', sku } })
    await recordProductSkuAssignment(tx, { sku: 'BD-999999', itemId, user, reason: 'force assignment failure' })
  }), /allocation must match|SKU allocation/)
  assert.equal(await db.inventoryItem.count({ where: { category: 'product' } }), beforeProducts)
  assert.equal(await db.productSkuAssignment.count(), beforeAssignments)
  assert.equal(await db.sensitiveRecordAudit.count({ where: { action: 'product.sku.assign' } }), beforeAudits)
}

async function proveSamePrefixContention(prefix, expectedFirst) {
  let firstLocked
  const locked = new Promise((resolve) => { firstLocked = resolve })
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const firstCreate = createWithAllocatedSku(prefix, `${prefix}并发一`, async () => { firstLocked(); await gate })
  await locked
  const secondCreate = createWithAllocatedSku(prefix, `${prefix}并发二`)
  await waitForBlockedAllocator()
  releaseFirst()
  const [firstNew, secondNew] = await Promise.all([firstCreate, secondCreate])
  assert.deepEqual([firstNew.sku, secondNew.sku], [
    `${prefix}-${String(expectedFirst).padStart(6, '0')}`,
    `${prefix}-${String(expectedFirst + 1).padStart(6, '0')}`,
  ])
}

try {
  const [{ version }] = await db.$queryRaw`SELECT current_setting('server_version_num')::int AS version`
  assert.equal(Math.floor(version / 10000), 16, '真实 PostgreSQL 16 必须可用')
  assert.equal(await db.inventoryItem.count({ where: { category: 'product' } }), 0, '使用空白隔离测试库')

  await assert.rejects(db.inventoryItem.create({ data: { id: makeId(), name: '旧应用未授权新商品', category: 'product', sku: 'LEGACY-DENY' } }), /SKU Authority writer/)

  let markedPid = null
  await db.$transaction(async (tx) => {
    const [mark] = await tx.$queryRaw`SELECT set_config('budu.sku_authority_writer', '1', true) AS value`
    assert.equal(mark.value, '1')
    const [pid] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
    markedPid = pid.pid
  })
  let sameConnectionObserved = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await db.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid, current_setting('budu.sku_authority_writer', true) AS value`
      return row
    })
    if (result.pid === markedPid) {
      sameConnectionObserved = true
      assert.notEqual(result.value, '1', 'transaction-local SKU writer marker must not leak through pool reuse')
      break
    }
  }
  assert.equal(sameConnectionObserved, true, 'must observe the same pooled PostgreSQL connection after commit')

  let releaseMarked
  const markedGate = new Promise((resolve) => { releaseMarked = resolve })
  let markedReady
  const ready = new Promise((resolve) => { markedReady = resolve })
  const markedTxn = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('budu.sku_authority_writer', '1', true)`
    markedReady()
    await markedGate
  }, { timeout: 10000 })
  await ready
  await assert.rejects(db.inventoryItem.create({ data: { id: makeId(), name: '并发事务不能继承授权', category: 'product', sku: 'LEGACY-CONCURRENT' } }), /SKU Authority writer/)
  releaseMarked()
  await markedTxn

  const category = await db.productCategory.create({ data: { id: makeId(), name: 'pos-森醒' } })
  const legacy = [
    { id: makeId(), name: 'SKU测试自有A', sku: 'LEGACY-A', createdAt: new Date('2026-01-01T00:00:00Z'), isActive: false, salePriceCents: 500n, costPriceCents: 100n },
    { id: makeId(), name: 'SKU测试自有B', sku: null, createdAt: new Date('2026-01-01T00:00:00Z'), isActive: false },
    { id: makeId(), name: 'SKU测试第三方', sku: 'LEGACY-TP', createdAt: new Date('2026-02-01T00:00:00Z'), isActive: false, productCategoryId: category.id },
  ]
  for (const row of legacy) await seedLegacyProduct({ ...row, category: 'product' })
  const external = await db.onlineProductPolicy.create({ data: {
    id: makeId(), namespace: 'wechat', externalProductId: 'c1', externalSkuId: 's1',
    productId: legacy[0].id, enabled: true, updatedById: user.id,
  } })
  const store = await db.store.create({ data: { key: 'sku-test-store', name: 'SKU isolated store' } })
  await db.order.create({ data: { id: makeId(), orderNo: makeId(), storeId: store.key,
    cashierId: 'sku-test-cashier', checkoutKey: makeId(), cartHash: 'sku-test-cart',
    items: { create: [{ id: makeId(), productId: legacy[0].id,
      productNameSnapshot: legacy[0].name, skuSnapshot: 'LEGACY-A',
      unitPrice: 500n, costPriceSnapshot: 100n, quantity: 1, lineAmount: 500n }] } } })
  await db.transferRequest.create({ data: { id: makeId(), fromStoreKey: store.key,
    toLocationName: 'SKU isolated destination',
    items: { create: [{ id: makeId(), itemId: legacy[0].id, quantity: 1,
      itemNameSnapshot: legacy[0].name, itemCodeSnapshot: 'LEGACY-A' }] } } })
  await db.purchaseRequest.create({ data: { id: makeId(), storeKey: store.key,
    items: { create: [{ id: makeId(), itemId: legacy[0].id, orderedQty: 1,
      itemNameSnapshot: legacy[0].name }] } } })
  const partner = await db.partner.create({ data: { id: makeId(), name: 'SKU isolated partner', defaultStoreKey: store.key } })
  const partnerStore = await db.partnerStore.create({ data: { id: makeId(), partnerId: partner.id, name: 'SKU partner store' } })
  await db.partnerSupplyOrder.create({ data: { id: makeId(), orderNo: makeId(), partnerId: partner.id,
    partnerNameSnapshot: partner.name, fromStoreKey: store.key, fromStoreNameSnapshot: store.name,
    businessDate: new Date('2026-01-02T00:00:00Z'), defaultDiscountBpsSnapshot: 6500,
    effectiveDiscountBps: 6500, totalAmountCents: 500n,
    items: { create: [{ id: makeId(), productId: legacy[0].id, productCodeSnapshot: 'LEGACY-A',
      productNameSnapshot: legacy[0].name, retailPriceCentsSnapshot: 500n,
      discountBpsSnapshot: 6500, partnerUnitPriceCents: 500n, quantity: 1, subtotalCents: 500n }] } } })
  await db.replenishmentOrder.create({ data: { id: makeId(), orderNo: makeId(), partnerId: partner.id,
    partnerStoreId: partnerStore.id, partnerNameSnapshot: partner.name,
    partnerStoreNameSnapshot: partnerStore.name, createdByType: 'INTERNAL', createdByActorId: user.id,
    requestedTotalAmountCents: 500n, idempotencyScope: makeId(), idempotencyKey: makeId(),
    idempotencyPayloadDigest: crypto.createHash('sha256').update('sku-fixture').digest('hex'), items: { create: [{ id: makeId(), inventoryItemId: legacy[0].id,
      productNameSnapshot: legacy[0].name, skuSnapshot: 'LEGACY-A', productCodeSnapshot: 'LEGACY-A',
      orderUnitSnapshot: 'PCS', requestedQuantityBase: 1, basePriceSnapshotCents: 500n,
      discountBpsSnapshot: 10000, requestedLineAmountCents: 500n,
      minimumOrderBaseQtySnapshot: 1, orderStepBaseQtySnapshot: 1 }] } } })
  const factsBefore = await historicalFacts(legacy[0].id)
  assert.ok(Object.values(factsBefore).every(Boolean), 'all historical domains must have nonempty fixtures')
  const rows = await db.inventoryItem.findMany({ where: { category: 'product' }, select: {
    id: true, name: true, sku: true, category: true, createdAt: true, isActive: true,
    transferCode: true, productCategory: { select: { name: true } },
  } })
  const plan = buildProductSkuPlan(rows, { actorUserId: user.id, reason: 'PG16 isolated migration', snapshotId: 'pg16-fixture', expectedCount: 3 })
  assert.deepEqual(plan.counts, { total: 3, BD: 2, TP: 1, missingOldSku: 1, aliases: 2 })
  const rolledBack = await applyProductSkuPlanOnTestDatabase(db, plan, { dryRollback: true })
  assert.equal(rolledBack.rolledBack, true)
  assert.equal(await db.productSkuAssignment.count(), 0)
  assert.equal((await db.inventoryItem.findUnique({ where: { id: legacy[0].id } })).sku, 'LEGACY-A')
  for (const tampered of [
    { ...plan, counts: { ...plan.counts, BD: 999 } },
    { ...plan, mapping: plan.mapping.map((row, index) => index ? row : { ...row, newSku: 'BD-999999' }) },
    { ...plan, mapping: plan.mapping.slice(1) },
  ]) {
    await assert.rejects(applyProductSkuPlanOnTestDatabase(db, tampered), /映射摘要不匹配/)
  }
  const applied = await applyProductSkuPlanOnTestDatabase(db, plan)
  assert.equal(applied.onlineMappings, 1)
  assert.equal(await db.productSkuAlias.count(), 2)
  assert.equal(await db.productSkuAssignment.count(), 3)
  assert.deepEqual(await historicalFacts(legacy[0].id), factsBefore, 'historical refs and snapshots are unchanged')
  const externalAfter = await db.onlineProductPolicy.findUnique({ where: { id: external.id } })
  assert.deepEqual([externalAfter.externalProductId, externalAfter.externalSkuId, externalAfter.productId, externalAfter.enabled],
    ['c1', 's1', legacy[0].id, true])
  const first = await db.inventoryItem.findUnique({ where: { id: legacy[0].id } })
  await assert.rejects(db.inventoryItem.update({ where: { id: first.id }, data: { name: '禁改名' } }), /immutable/)
  await assert.rejects(db.inventoryItem.update({ where: { id: first.id }, data: { sku: 'BD-999999' } }), /immutable/)
  await assert.rejects(db.inventoryItem.update({ where: { id: first.id }, data: { category: 'material' } }), /immutable/)
  await db.inventoryItem.update({ where: { id: first.id }, data: { salePriceCents: 600n, isActive: true } })
  const mutable = await db.inventoryItem.findUnique({ where: { id: first.id } })
  assert.equal(mutable.salePriceCents, 600n)
  assert.equal(mutable.isActive, true)
  await proveAtomicProductCreationRollback()

  await proveSamePrefixContention('BD', 3)
  await proveSamePrefixContention('TP', 2)
  const thirdParty = await createWithAllocatedSku('TP', '并发第三方')
  assert.equal(thirdParty.sku, 'TP-000004')

  await db.productSkuAlias.create({ data: { alias: 'BD-000005', itemId: first.id, actorUserId: user.id, reason: 'reserved test' } })
  await assert.rejects(db.$transaction((tx) => reserveProductSku(tx, {
    source: 'BD', override: 'BD-000005', user, reason: 'collision test',
  })), /占用/)
  const skipped = await createWithAllocatedSku('BD', '别名占位后生成')
  assert.equal(skipped.sku, 'BD-000006')
  assert.equal(await db.productSkuSequence.findUnique({ where: { prefix: 'BD' } }).then((row) => row.nextValue), 7)

  const app = express()
  app.use(express.json(), (req, _res, next) => {
    req.user = { id: `sku-${req.headers['x-role'] || 'finance'}`, role: req.headers['x-role'] || 'finance', status: 'active' }
    next()
  }, productsRouter)
  const listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  const base = `http://127.0.0.1:${listener.address().port}`
  const request = async (method, path, body, role = 'finance') => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-role': role },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  try {
    const normalCreate = await request('POST', '/products', { name: 'HTTP新商品', skuSource: 'BD', isActive: false })
    assert.equal(normalCreate.status, 201)
    assert.equal(normalCreate.data.product.sku, 'BD-000007')
    const deniedOverride = await request('POST', '/products', { name: '越权SKU', skuSource: 'BD', isActive: false,
      skuOverride: 'BD-000008', skuOverrideReason: 'attempt' })
    assert.equal(deniedOverride.status, 403)
    const badFormat = await request('POST', '/products', { name: '格式错', skuSource: 'TP', isActive: false,
      skuOverride: 'TP-8', skuOverrideReason: 'reviewed' }, 'admin')
    assert.equal(badFormat.status, 400)
    const acceptedOverride = await request('POST', '/products', { name: '管理员指定', skuSource: 'TP', isActive: false,
      skuOverride: 'TP-000005', skuOverrideReason: 'reviewed' }, 'admin')
    assert.equal(acceptedOverride.status, 201)
    assert.equal(acceptedOverride.data.product.sku, 'TP-000005')
    const duplicateName = await request('POST', '/products', { name: legacy[0].name, skuSource: 'BD', isActive: false })
    assert.equal(duplicateName.status, 409)
    const original = await db.inventoryItem.findUnique({ where: { id: legacy[0].id } })
    const renamed = await request('PUT', `/products/${original.id}`, { name: '错误改名', sku: original.sku,
      version: original.version, isActive: false })
    assert.equal(renamed.status, 409)
    assert.match(renamed.data.error, /名称不能原地修改/)
    const recoded = await request('PUT', `/products/${original.id}`, { name: original.name, sku: 'BD-999999',
      version: original.version, isActive: false })
    assert.equal(recoded.status, 409)
    const restored = await request('PUT', `/products/${original.id}`, { name: original.name, sku: original.sku,
      version: original.version, isActive: true, salePriceCents: '500' })
    assert.equal(restored.status, 200)
    assert.equal(restored.data.product.productId, original.id)
    assert.equal(restored.data.product.sku, original.sku)
    const aliasSearch = await request('GET', '/products?q=LEGACY-A')
    assert.equal(aliasSearch.status, 200)
    assert.ok(aliasSearch.data.rows.some((row) => row.productId === original.id && row.skuAliases.includes('LEGACY-A')))
    const aliasImport = await request('POST', '/products/import', { rows: [{ name: original.name,
      sku: 'LEGACY-A', skuSource: 'BD', salePriceCents: '500', costPriceCents: '100' }] })
    assert.equal(aliasImport.status, 409)
    const aliasWithId = await request('POST', '/products/import', { rows: [{ productId: original.id,
      name: original.name, sku: 'LEGACY-A', version: restored.data.product.version,
      salePriceCents: '500', costPriceCents: '100' }] })
    assert.equal(aliasWithId.status, 409)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
  console.log(JSON.stringify({ result: 'PASS', pgMajor: 16, migration: plan.counts,
    onlineMappings: 1, deterministicContention: true, aliasReserved: true, rollbackDryRun: true }))
} finally {
  await db.$disconnect()
}