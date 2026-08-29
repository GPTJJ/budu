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
const schemaName = `unified_product_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260829110000_unified_product_center'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000,
  })
}

test('Unified Product Center migration adds only an independent opt-in flag and preserves historical IDs and facts', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-unified-product-migration-'))
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
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, sku, "transferCode", "transferEnabled", "isActive", "salePriceCents", "costPriceCents") VALUES ('pos-1', 'POS历史商品', 'product', 'POS-1', NULL, false, true, 1000, 300), ('transfer-1', '调拨历史商品', 'product', NULL, 'NO.1', true, false, NULL, NULL)`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy") VALUES ('tr-1', 'guanshe', 'tongying', 'shipped', 'legacy')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('ti-1', 'tr-1', 'transfer-1', 5, '调拨历史商品', 'NO.1', 'product')`)
    await client.$executeRawUnsafe(`INSERT INTO "Partner" (id, name, "defaultStoreKey") VALUES ('partner-1', '历史合作商', 'guanshe')`)
    await client.$executeRawUnsafe(`INSERT INTO "PartnerSupplyOrder" (id, "orderNo", "partnerId", "partnerNameSnapshot", "fromStoreKey", "fromStoreNameSnapshot", "businessDate", status, "defaultDiscountBpsSnapshot", "effectiveDiscountBps", "totalAmountCents") VALUES ('ps-1', 'PS-HISTORY-1', 'partner-1', '历史合作商', 'guanshe', '北京官舍店', DATE '2026-08-28', 'shipped', 6500, 6500, 650)`)
    await client.$executeRawUnsafe(`INSERT INTO "PartnerSupplyItem" (id, "orderId", "productId", "productCodeSnapshot", "productNameSnapshot", "retailPriceCentsSnapshot", "discountBpsSnapshot", "partnerUnitPriceCents", quantity, "subtotalCents") VALUES ('psi-1', 'ps-1', 'pos-1', 'POS-1', 'POS历史商品', 1000, 6500, 650, 1, 650)`)

    const projection = `SELECT i.id, i.name, i.sku, i."transferCode", i."transferEnabled", i."isActive", i."salePriceCents"::text, i."costPriceCents"::text, t.id AS "transferItemId", p.id AS "partnerItemId" FROM "InventoryItem" i LEFT JOIN "TransferItem" t ON t."itemId" = i.id LEFT JOIN "PartnerSupplyItem" p ON p."productId" = i.id ORDER BY i.id`
    const digest = crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const rows = await client.$queryRawUnsafe(`SELECT id, "partnerSupplyEnabled" FROM "InventoryItem" ORDER BY id`)
    assert.deepEqual(rows, [{ id: 'pos-1', partnerSupplyEnabled: false }, { id: 'transfer-1', partnerSupplyEnabled: false }])
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex'), digest)
    assert.equal(await client.transferItem.count({ where: { id: 'ti-1', itemId: 'transfer-1' } }), 1)
    assert.equal(await client.partnerSupplyItem.count({ where: { id: 'psi-1', productId: 'pos-1' } }), 1)
    await client.inventoryItem.update({ where: { id: 'pos-1' }, data: { partnerSupplyEnabled: true } })
    const updated = await client.inventoryItem.findUnique({ where: { id: 'pos-1' } })
    assert.equal(updated.partnerSupplyEnabled, true)
    assert.equal(updated.transferEnabled, false)
    assert.equal(updated.isActive, true)
    assert.equal(updated.salePriceCents, 1000n)
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 54)
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
