import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const schemaName = `product_group_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260829180000_product_groups'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000,
  })
}

test('ProductGroup migration is additive and preserves every historical InventoryItem identity and reference', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-product-group-migration-'))
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(path.join(temp, 'migrations'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
      if (entry === migrationName || entry === 'migration_lock.toml') continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry), path.join(temp, 'migrations', entry), { recursive: true })
    }
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(temp, 'migrations', 'migration_lock.toml'))
    migrate(path.join(temp, 'schema.prisma'))

    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('guanshe', '北京官舍店'), ('tongying', '北京通盈中心店') ON CONFLICT DO NOTHING`)
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, sku, "transferCode", "transferEnabled", "partnerSupplyEnabled", "isActive", "salePriceCents", "costPriceCents") VALUES ('sku-blue', '幸运饼干-蓝', 'product', 'BLUE', 'BLUE', true, true, true, 7900, 3000), ('sku-green', '幸运饼干-绿', 'product', 'GREEN', NULL, false, false, true, 7900, 3000)`)
    await client.$executeRawUnsafe(`INSERT INTO "orders" (id, "order_no", "store_id", "cashier_id", subtotal, "payable_amount", status, "payment_status", "checkout_key", "cart_hash") VALUES ('order-1', 'POS-HISTORY-1', 'guanshe', 'cashier-1', 7900, 7900, 'completed', 'paid', 'checkout-history-1', 'hash-history-1')`)
    await client.$executeRawUnsafe(`INSERT INTO "order_items" (id, "order_id", "product_id", "product_name_snapshot", "sku_snapshot", "unit_price", "cost_price_snapshot", quantity, "line_amount", "actual_amount") VALUES ('oi-1', 'order-1', 'sku-blue', '幸运饼干-蓝', 'BLUE', 7900, 3000, 1, 7900, 7900)`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy") VALUES ('tr-1', 'guanshe', 'tongying', 'shipped', 'legacy')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('ti-1', 'tr-1', 'sku-blue', 2, '幸运饼干-蓝', 'BLUE', 'product')`)
    await client.$executeRawUnsafe(`INSERT INTO "Partner" (id, name, "defaultStoreKey") VALUES ('partner-1', '历史合作商', 'guanshe')`)
    await client.$executeRawUnsafe(`INSERT INTO "PartnerSupplyOrder" (id, "orderNo", "partnerId", "partnerNameSnapshot", "fromStoreKey", "fromStoreNameSnapshot", "businessDate", status, "defaultDiscountBpsSnapshot", "effectiveDiscountBps", "totalAmountCents") VALUES ('ps-1', 'PS-HISTORY-1', 'partner-1', '历史合作商', 'guanshe', '北京官舍店', DATE '2026-08-29', 'shipped', 6500, 6500, 5135)`)
    await client.$executeRawUnsafe(`INSERT INTO "PartnerSupplyItem" (id, "orderId", "productId", "productCodeSnapshot", "productNameSnapshot", "retailPriceCentsSnapshot", "discountBpsSnapshot", "partnerUnitPriceCents", quantity, "subtotalCents") VALUES ('psi-1', 'ps-1', 'sku-blue', 'BLUE', '幸运饼干-蓝', 7900, 6500, 5135, 1, 5135)`)

    const projection = `SELECT i.id, i.name, i.sku, o.id AS "orderItemId", t.id AS "transferItemId", p.id AS "partnerItemId" FROM "InventoryItem" i LEFT JOIN "order_items" o ON o."product_id" = i.id LEFT JOIN "TransferItem" t ON t."itemId" = i.id LEFT JOIN "PartnerSupplyItem" p ON p."productId" = i.id ORDER BY i.id`
    const digest = crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const defaults = await client.inventoryItem.findMany({ orderBy: { id: 'asc' }, select: { id: true, productGroupId: true, variantName: true } })
    assert.deepEqual(defaults, [
      { id: 'sku-blue', productGroupId: null, variantName: '' },
      { id: 'sku-green', productGroupId: null, variantName: '' },
    ])
    assert.equal(await client.productGroup.count(), 0)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex'), digest)
    const group = await client.productGroup.create({ data: { id: 'pg-lucky', name: '幸运饼干', sortOrder: 1 } })
    await client.inventoryItem.update({ where: { id: 'sku-blue' }, data: { productGroupId: group.id, variantName: '蓝' } })
    assert.equal((await client.orderItem.findUnique({ where: { id: 'oi-1' } })).productId, 'sku-blue')
    assert.equal((await client.transferItem.findUnique({ where: { id: 'ti-1' } })).itemId, 'sku-blue')
    assert.equal((await client.partnerSupplyItem.findUnique({ where: { id: 'psi-1' } })).productId, 'sku-blue')
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 55)
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
