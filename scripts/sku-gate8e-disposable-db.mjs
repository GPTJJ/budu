// Runner-only PostgreSQL 16 fixture and immutable before/after fingerprint.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const candidate = process.env.CANDIDATE_DIR
assert.ok(candidate)
const require = createRequire(join(candidate, 'package.json'))
const { PrismaClient } = require('@prisma/client')
const target = new URL(process.env.DATABASE_URL || '')
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
assert.match(target.pathname.slice(1), /^sku_authority_test_[a-z0-9_]+$/)
const db = new PrismaClient()
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value,
  (_key, item) => typeof item === 'bigint' ? item.toString() : item)).digest('hex')

async function inspect() {
  const [{ version }] = await db.$queryRaw`SELECT current_setting('server_version_num')::int AS version`
  const [{ applied, failed }] = await db.$queryRaw`
    SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
           count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed
    FROM _prisma_migrations`
  const [{ assignments, aliases, sequences }] = await db.$queryRaw`
    SELECT to_regclass('public.product_sku_assignments')::text AS assignments,
           to_regclass('public.product_sku_aliases')::text AS aliases,
           to_regclass('public.product_sku_sequences')::text AS sequences`
  const roles = await db.$queryRaw`SELECT rolconfig FROM pg_roles WHERE rolname='sku_plan_ro'`
  const [products, online, history] = await Promise.all([
    db.inventoryItem.findMany({ select: { id: true, sku: true, isActive: true,
      transferEnabled: true, version: true }, orderBy: { id: 'asc' } }),
    db.onlineProductPolicy.findMany({ select: { id: true, productId: true,
      externalProductId: true, externalSkuId: true, enabled: true }, orderBy: { id: 'asc' } }),
    db.orderItem.findMany({ select: { id: true, productId: true,
      skuSnapshot: true }, orderBy: { id: 'asc' } }),
  ])
  return { pgMajor: Math.floor(version / 10000), ledger: `${applied}/${failed}`,
    skuTables: assignments === null && aliases === null && sequences === null ? 'ABSENT' : 'PRESENT',
    readOnlyRole: roles.length === 1 &&
      (roles[0].rolconfig || []).includes('default_transaction_read_only=on'),
    products: products.length, online: online.length, history: history.length,
    fixtureDigest: hash({ products, online, history }) }
}

try {
  const before = await inspect()
  assert.equal(before.pgMajor, 16)
  assert.equal(before.ledger, '85/0')
  assert.equal(before.skuTables, 'ABSENT')
  if (process.argv[2] === 'seed') {
    assert.equal(before.products, 0)
    const bd = await db.productCategory.create({ data: { id: 'gate8e-bd', name: '糖果' } })
    const tp = await db.productCategory.create({ data: { id: 'gate8e-tp', name: 'pos-森醒' } })
    await db.store.create({ data: { key: 'gate8e-store', name: 'Gate 8E store' } })
    const products = Array.from({ length: 178 }, (_, i) => ({
      id: `gate8e-product-${String(i + 1).padStart(3, '0')}`,
      name: `Gate8E商品${String(i + 1).padStart(3, '0')}`,
      sku: i < 33 ? null : `LEGACY-${String(i + 1).padStart(3, '0')}`,
      category: 'product', productCategoryId: i < 89 ? tp.id : bd.id,
      createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 6), i % 24)),
      isActive: i < 87, transferEnabled: i >= 87 && i < 113,
    }))
    await db.inventoryItem.createMany({ data: products })
    await db.onlineProductPolicy.createMany({ data: products.slice(0, 153).map((row, i) => ({
      id: `gate8e-online-${String(i + 1).padStart(3, '0')}`,
      namespace: 'cloudbase-miniprogram', externalProductId: `external-${i + 1}`,
      externalSkuId: `sku-external-${i + 1}`, productId: row.id,
      enabled: true, updatedById: 'gate8e',
    })) })
    const order = await db.order.create({ data: { id: 'gate8e-order', orderNo: 'gate8e-order',
      storeId: 'gate8e-store', cashierId: 'gate8e', checkoutKey: 'gate8e-order',
      cartHash: 'synthetic-fixture' } })
    await db.orderItem.create({ data: { id: 'gate8e-order-item', orderId: order.id,
      productId: products[0].id, productNameSnapshot: products[0].name,
      skuSnapshot: 'LEGACY-SNAPSHOT', unitPrice: 100n,
      costPriceSnapshot: 50n, quantity: 1, lineAmount: 100n } })
    // The plan's database role cannot write even if a client ignores PGOPTIONS.
    await db.$executeRawUnsafe("CREATE ROLE sku_plan_ro LOGIN PASSWORD 'sku_plan_ro'")
    await db.$executeRawUnsafe('GRANT CONNECT ON DATABASE sku_authority_test_gate8e TO sku_plan_ro')
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO sku_plan_ro')
    await db.$executeRawUnsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO sku_plan_ro')
    await db.$executeRawUnsafe('ALTER ROLE sku_plan_ro SET default_transaction_read_only = on')
  } else {
    assert.equal(process.argv[2], 'check')
  }
  const after = await inspect()
  if (process.argv[2] === 'seed') {
    assert.equal(after.products, 178)
    assert.equal(after.online, 153)
    assert.equal(after.history, 1)
  }
  assert.equal(after.readOnlyRole, true)
  process.stdout.write(JSON.stringify({ event: 'GATE_8E_DISPOSABLE_DB',
    mode: process.argv[2], ...after }) + '\n')
} finally {
  await db.$disconnect()
}
