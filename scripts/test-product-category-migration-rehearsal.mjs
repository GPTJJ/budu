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
const schemaName = `product_category_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260829030000_product_category_transfer_summary'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000,
  })
}

test('产品分类 additive migration leaves every product uncategorized and preserves historical transfer facts', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-product-category-migration-'))
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(path.join(temp, 'migrations'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
      if (entry === migrationName) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry), path.join(temp, 'migrations', entry), { recursive: true })
    }
    migrate(path.join(temp, 'schema.prisma'))
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, "transferCode", "transferEnabled", "transferSortOrder", "isActive", "sortOrder") VALUES ('p1', 'NO.1树莓', 'product', 'NO.1', true, 1, false, 77), ('p2', 'POS产品', 'product', NULL, false, 0, true, 9), ('m1', '冰袋', 'material', NULL, true, 1, false, 4)`)
    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('from', '调出'), ('to', '调入')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy", "shippedBy", "shippedAt") VALUES ('tr', 'from', 'to', 'shipped', 'legacy', 'shipper', NOW())`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, note, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('ti', 'tr', 'p1', 5, '历史', 'NO.1树莓', 'NO.1', 'product')`)
    const projection = `SELECT i.id, i.name, i.category, i."transferCode", i."transferEnabled", i."transferSortOrder", i."isActive", i."sortOrder", t.id AS "transferId", t.quantity, t.note FROM "InventoryItem" i LEFT JOIN "TransferItem" t ON t."itemId" = i.id ORDER BY i.id`
    const before = await client.$queryRawUnsafe(projection)
    const digest = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 54)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex'), digest)
    assert.equal(await client.productCategory.count(), 0)
    assert.equal(await client.inventoryItem.count({ where: { productCategoryId: { not: null } } }), 0)
    assert.equal((await client.transferItem.findUnique({ where: { id: 'ti' } })).productCategoryNameSnapshot, '')
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
