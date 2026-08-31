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
const schemaName = `transfer_actual_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260830130000_transfer_actual_shipment'
const laterMigrations = new Set([
  '20260831190000_report_center_order_source_external_settlement',
  '20260831193000_report_center_unified_refund_authority',
])

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
    timeout: 180000,
  })
}

test('57→58 additive migration preserves every requested transfer fact and leaves actual shipment unknown', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-transfer-actual-migration-'))
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(path.join(temp, 'migrations'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
      if (entry === migrationName || laterMigrations.has(entry) || entry === 'migration_lock.toml') continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry), path.join(temp, 'migrations', entry), { recursive: true })
    }
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(temp, 'migrations', 'migration_lock.toml'))
    migrate(path.join(temp, 'schema.prisma'))

    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('guanshe', '北京官舍店'), ('tongying', '北京通盈中心店')`)
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, "transferCode", "transferEnabled", "transferBoxEnabled", "transferBoxWeightGrams", "transferPieceEnabled", "transferPieceWeightGrams") VALUES ('candy', 'NO.2柠檬', 'product', 'NO.2', true, true, 2500, true, 6), ('material', '冰袋', 'material', 'MAT', true, false, NULL, false, NULL)`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy", "shippedBy", "shippedAt") VALUES ('historical-transfer', 'guanshe', 'tongying', 'shipped', 'requester', 'shipper', NOW())`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, "quantityUnit", "unitWeightGramsSnapshot", "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('box-row', 'historical-transfer', 'candy', 1, 'box', 2500, 'NO.2柠檬', 'NO.2', 'product'), ('piece-row', 'historical-transfer', 'candy', 166, 'piece', 6, 'NO.2柠檬', 'NO.2', 'product'), ('legacy-row', 'historical-transfer', 'material', 100, 'legacy', NULL, '冰袋', 'MAT', 'material')`)

    const projection = `SELECT id, "requestId", "itemId", quantity, "quantityUnit", "unitWeightGramsSnapshot", note, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot", "productCategoryNameSnapshot" FROM "TransferItem" ORDER BY id`
    const beforeRows = await client.$queryRawUnsafe(projection)
    const before = crypto.createHash('sha256').update(JSON.stringify(beforeRows)).digest('hex')

    fs.cpSync(path.join(root, 'prisma', 'migrations', migrationName), path.join(temp, 'migrations', migrationName), { recursive: true })
    migrate(path.join(temp, 'schema.prisma'))

    const afterRows = await client.$queryRawUnsafe(projection)
    const after = crypto.createHash('sha256').update(JSON.stringify(afterRows)).digest('hex')
    assert.equal(after, before)
    const shipped = await client.$queryRawUnsafe(`SELECT id, "shippedQuantity" FROM "TransferItem" ORDER BY id`)
    assert.deepEqual(shipped, [
      { id: 'box-row', shippedQuantity: null },
      { id: 'legacy-row', shippedQuantity: null },
      { id: 'piece-row', shippedQuantity: null },
    ])
    await assert.rejects(client.$executeRawUnsafe(`UPDATE "TransferItem" SET "shippedQuantity" = 167 WHERE id = 'piece-row'`))
    await assert.rejects(client.$executeRawUnsafe(`UPDATE "TransferItem" SET "shippedQuantity" = -1 WHERE id = 'legacy-row'`))
    await assert.rejects(client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, "quantityUnit", "unitWeightGramsSnapshot") VALUES ('duplicate-piece', 'historical-transfer', 'candy', 1, 'piece', 6)`))
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 58)
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
