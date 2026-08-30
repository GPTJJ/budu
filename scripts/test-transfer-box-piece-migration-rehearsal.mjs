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
const schemaName = `transfer_units_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260830090000_transfer_box_piece_units'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], { cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000 })
}

test('56→57 additive migration preserves historical transfer facts and defaults them to legacy', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-transfer-units-migration-'))
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
    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('guanshe', '北京官舍店'), ('tongying', '北京通盈中心店')`)
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, "transferCode", "transferEnabled") VALUES ('legacy-product', '历史树莓', 'product', 'NO.1', true)`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy") VALUES ('legacy-transfer', 'guanshe', 'tongying', 'shipped', 'history')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('legacy-item', 'legacy-transfer', 'legacy-product', 417, '历史树莓', 'NO.1', 'product')`)
    const projection = `SELECT t.id, t."requestId", t."itemId", t.quantity, t."itemNameSnapshot", t."itemCodeSnapshot", t."categorySnapshot" FROM "TransferItem" t ORDER BY t.id`
    const before = crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const after = crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex')
    assert.equal(after, before)
    const legacy = await client.transferItem.findUnique({ where: { id: 'legacy-item' } })
    assert.deepEqual({ quantity: legacy.quantity, unit: legacy.quantityUnit, weight: legacy.unitWeightGramsSnapshot }, { quantity: 417, unit: 'legacy', weight: null })
    const product = await client.inventoryItem.findUnique({ where: { id: 'legacy-product' } })
    assert.deepEqual({ box: product.transferBoxEnabled, boxWeight: product.transferBoxWeightGrams, piece: product.transferPieceEnabled, pieceWeight: product.transferPieceWeightGrams }, { box: false, boxWeight: null, piece: false, pieceWeight: null })
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 57)
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
