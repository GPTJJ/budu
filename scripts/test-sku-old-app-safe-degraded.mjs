import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'
import { applyProductSkuPlanOnTestDatabase } from '../server/product-sku-migration.js'

const BASELINE = '5ad27a06d731fbc94de5ae3776060b4350b886e8'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const db = new PrismaClient()
process.env.SKU_AUTHORITY_TEST_APPLY = 'YES'

function run(args, cwd = ROOT) {
  return execFileSync(args[0], args.slice(1), { cwd, env: process.env, stdio: 'pipe', encoding: 'utf8' })
}

async function request(base, method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data = {}
  try { data = await response.json() } catch {}
  return { status: response.status, data }
}

function productPayload(row, extra = {}) {
  return {
    name: row.name,
    sku: row.sku,
    posCategory: row.posCategory || '',
    salePriceCents: String(row.salePriceCents ?? 500),
    costPriceCents: String(row.costPriceCents ?? 100),
    unit: row.unit || '颗',
    barcode: row.barcode || '',
    isActive: row.isActive,
    trackInventory: row.trackInventory,
    sortOrder: row.sortOrder,
    transferCode: row.transferCode || '',
    transferEnabled: row.transferEnabled,
    transferBoxEnabled: row.transferBoxEnabled,
    transferBoxWeightGrams: row.transferBoxWeightGrams,
    transferPieceEnabled: row.transferPieceEnabled,
    transferPieceWeightGrams: row.transferPieceWeightGrams,
    partnerSupplyEnabled: row.partnerSupplyEnabled,
    partnerReplenishmentEnabled: row.partnerReplenishmentEnabled,
    partnerOrderUnit: row.partnerOrderUnit,
    partnerKgBasePriceCents: row.partnerKgBasePriceCents == null ? null : String(row.partnerKgBasePriceCents),
    productCategoryId: row.productCategoryId || '',
    productGroupId: row.productGroupId || '',
    variantName: row.variantName || '',
    version: row.version,
    ...extra,
  }
}

let worktree = null
let listener = null
let baselinePrisma = null
try {
  const [{ version }] = await db.$queryRaw`SELECT current_setting('server_version_num')::int AS version`
  assert.equal(Math.floor(version / 10000), 16, 'Gate 8B requires native PostgreSQL 16')
  assert.match(new URL(process.env.DATABASE_URL).pathname.slice(1), /^sku_authority_test_[a-z0-9_]+$/)

  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-old-app-'))
  run(['git', 'worktree', 'add', '--detach', worktree, BASELINE])
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(worktree, 'node_modules'), 'dir')

  // Reproduce production order: baseline schema/data first, then migration 86.
  run([path.join(ROOT, 'node_modules/.bin/prisma'), 'migrate', 'deploy', '--schema', path.join(worktree, 'prisma/schema.prisma')])
  assert.equal(await db.inventoryItem.count({ where: { category: 'product' } }), 0)

  const bdCategory = await db.productCategory.create({ data: { id: 'gate8b-cat-bd', name: '糖果' } })
  const tpCategory = await db.productCategory.create({ data: { id: 'gate8b-cat-tp', name: 'pos-森醒' } })
  await db.store.create({ data: { key: 'tongying', name: '北京通盈中心店', active: true } })

  const products = []
  for (let i = 0; i < 178; i += 1) {
    const tp = i < 89
    const row = await db.inventoryItem.create({ data: {
      id: `gate8b-product-${String(i + 1).padStart(3, '0')}`,
      name: `Gate8B商品${String(i + 1).padStart(3, '0')}`,
      sku: i < 33 ? null : `LEGACY-${String(i + 1).padStart(3, '0')}`,
      category: 'product',
      productCategoryId: tp ? tpCategory.id : bdCategory.id,
      createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 6), i % 24)),
      isActive: i < 113,
      salePriceCents: 500n,
      costPriceCents: 100n,
      unit: '颗',
      transferEnabled: true,
      partnerSupplyEnabled: true,
      sortOrder: i,
      transferSortOrder: i,
    } })
    products.push(row)
  }
  await db.onlineProductPolicy.createMany({ data: products.slice(0, 153).map((row, i) => ({
    id: `gate8b-online-${String(i + 1).padStart(3, '0')}`,
    namespace: 'cloudbase-miniprogram',
    externalProductId: `external-${i + 1}`,
    externalSkuId: `sku-external-${i + 1}`,
    productId: row.id,
    enabled: true,
    updatedById: 'gate8b',
  })) })

  run([path.join(ROOT, 'node_modules/.bin/prisma'), 'migrate', 'deploy', '--schema', path.join(ROOT, 'prisma/schema.prisma')])
  const migrations = await db.$queryRaw`SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  assert.equal(migrations[0].count, 86)

  // Migration 86 must immediately make the old creation path fail closed.
  await assert.rejects(db.inventoryItem.create({ data: {
    id: 'gate8b-orphan-attempt', name: 'Gate8B孤儿尝试', category: 'product', sku: 'MANUAL-OLD',
  } }), /SKU Authority writer/)

  const rows = await db.inventoryItem.findMany({ where: { category: 'product' }, select: {
    id: true, name: true, sku: true, category: true, createdAt: true, isActive: true,
    transferCode: true, productCategory: { select: { name: true } },
  } })
  const plan = buildProductSkuPlan(rows, {
    actorUserId: 'gate8b',
    reason: 'Gate 8B compatibility rehearsal',
    snapshotId: 'gate8b-fixture',
    expectedCount: 178,
  })
  assert.deepEqual(plan.counts, { total: 178, BD: 89, TP: 89, missingOldSku: 33, aliases: 145 })
  const applied = await applyProductSkuPlanOnTestDatabase(db, plan)
  assert.equal(applied.onlineMappings, 153)
  assert.equal(await db.productSkuAssignment.count(), 178)
  assert.equal(await db.productSkuAlias.count(), 145)

  const [{ value: leaked }] = await db.$queryRaw`SELECT current_setting('budu.sku_authority_writer', true) AS value`
  assert.notEqual(leaked, '1', 'migration application must not leave writer capability set')

  const [{ products: productCount }] = await db.$queryRaw`SELECT count(*)::int AS products FROM "InventoryItem" WHERE category='product'`
  assert.equal(productCount, 178)

  // Run the exact old production application routers against the migrated DB.
  const baseUrl = pathToFileURL(worktree + path.sep).href
  const [{ productsRouter }, { posRouter }, { v2Router }, { partnerSupplyRouter }, oldPg] = await Promise.all([
    import(new URL('server/products.js', baseUrl)),
    import(new URL('server/pos.js', baseUrl)),
    import(new URL('server/v2.js', baseUrl)),
    import(new URL('server/partner-supply.js', baseUrl)),
    import(new URL('server/pg.js', baseUrl)),
  ])
  baselinePrisma = oldPg.prisma

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'gate8b-old-developer',
      username: 'gate8b-old-developer',
      name: 'Gate8B',
      role: 'developer',
      status: 'active',
      storeKeys: ['tongying'],
      permissions: {},
    }
    next()
  })
  app.use(productsRouter)
  app.use(posRouter)
  app.use(v2Router)
  app.use(partnerSupplyRouter)
  listener = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  const httpBase = `http://127.0.0.1:${listener.address().port}`

  const productsRead = await request(httpBase, 'GET', '/products')
  assert.equal(productsRead.status, 200)
  assert.equal(productsRead.data.rows.length, 178)

  const posRead = await request(httpBase, 'GET', '/pos/products')
  assert.equal(posRead.status, 200)
  assert.equal(posRead.data.rows.length, 113)

  const transferRead = await request(httpBase, 'GET', '/transfer-master-items?category=product&active=true')
  assert.equal(transferRead.status, 200)
  assert.equal(transferRead.data.rows.length, 178)

  const partnerRead = await request(httpBase, 'GET', '/partner-supply-products')
  assert.equal(partnerRead.status, 200)
  assert.equal(partnerRead.data.rows.length, 178)

  const first = await db.inventoryItem.findUnique({ where: { id: products[0].id } })
  const purchase = await request(httpBase, 'POST', '/purchase-requests', {
    storeKey: 'tongying',
    supplier: '',
    note: 'Gate 8B old-app compatibility',
    items: [{ itemId: first.id, name: first.name, category: 'product', quantity: 1, note: '' }],
  })
  assert.equal(purchase.status, 200)
  assert.equal(purchase.data.request.items[0].itemId, first.id)

  const beforeNewCount = await db.inventoryItem.count({ where: { category: 'product' } })
  const deniedCreate = await request(httpBase, 'POST', '/products', {
    name: '旧应用不允许新建',
    sku: 'OLD-MANUAL-001',
    salePriceCents: '500',
    costPriceCents: '100',
    unit: '颗',
    isActive: true,
  })
  assert.ok(deniedCreate.status >= 400)
  assert.equal(await db.inventoryItem.count({ where: { category: 'product' } }), beforeNewCount)
  assert.equal(await db.productSkuAssignment.count(), 178)

  let current = await db.inventoryItem.findUnique({ where: { id: first.id } })
  const priceUpdate = await request(httpBase, 'PUT', `/products/${first.id}`, productPayload(current, {
    salePriceCents: '600',
  }))
  assert.equal(priceUpdate.status, 200)
  current = await db.inventoryItem.findUnique({ where: { id: first.id } })
  assert.equal(current.salePriceCents, 600n)

  const rename = await request(httpBase, 'PUT', `/products/${first.id}`, productPayload(current, {
    name: current.name + '改名',
  }))
  assert.ok(rename.status >= 400)
  const recode = await request(httpBase, 'PUT', `/products/${first.id}`, productPayload(current, {
    sku: 'BD-999999',
  }))
  assert.ok(recode.status >= 400)

  const disabled = await db.inventoryItem.findFirst({ where: { category: 'product', isActive: false } })
  const restore = await request(httpBase, 'PUT', `/products/${disabled.id}`, productPayload(disabled, {
    isActive: true,
  }))
  assert.equal(restore.status, 200)
  assert.equal((await db.inventoryItem.findUnique({ where: { id: disabled.id } })).isActive, true)

  const orphanProducts = await db.$queryRaw`
    SELECT count(*)::int AS count
    FROM "InventoryItem" i
    WHERE i.category='product'
      AND NOT EXISTS (SELECT 1 FROM product_sku_assignments a WHERE a.item_id=i.id)
  `
  assert.equal(orphanProducts[0].count, 0)

  console.log(JSON.stringify({
    result: 'PASS',
    oldAppSha: BASELINE,
    pgMajor: 16,
    oldAppCompatibility: 'SAFE_DEGRADED',
    productsRead: 178,
    posRead: 113,
    transferRead: 178,
    purchaseCreate: 'PASS',
    partnerRead: 178,
    oldAppProductCreate: 'DENY',
    oldAppRename: 'DENY',
    oldAppSkuChange: 'DENY',
    nonIdentityUpdate: 'PASS',
    sameNameReenable: 'PASS',
    orphanProducts: 0,
  }))
} finally {
  if (listener) await new Promise((resolve) => listener.close(resolve))
  if (baselinePrisma) {
    try { await baselinePrisma.$disconnect() } catch {}
  }
  await db.$disconnect()
  if (worktree) {
    try { run(['git', 'worktree', 'remove', '--force', worktree]) } catch {}
    try { fs.rmSync(worktree, { recursive: true, force: true }) } catch {}
  }
}
