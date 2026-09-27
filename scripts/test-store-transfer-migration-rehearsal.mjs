import { copyBeforeMigration, migrationNames, assertMigrationHistory } from './migration-rehearsal-plan.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const migrationName = '20260828230000_store_transfer_2_audit_fields'
let testUrl = ''

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000,
  })
}

test('Transfer 2.0 additive migration preserves every legacy transfer fact and old-app reads', async () => {
  testUrl = await createDisposablePgDatabase('transfer_2_migration', { applyMigrations: false })
  const { PrismaClient } = await import('@prisma/client')
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-transfer-2-migration-'))
  try {
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(path.join(temp, 'migrations'))
    copyBeforeMigration(root, temp, migrationName)
    migrate(path.join(temp, 'schema.prisma'))
    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('legacy-from', '历史调出'), ('legacy-to', '历史调入')`)
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category) VALUES ('legacy-item', '历史产品', 'product')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, note, "createdBy", "createdAt", "updatedAt") VALUES ('legacy-transfer', 'legacy-from', 'legacy-to', 'completed', '历史备注', 'legacy-user', '2026-08-08T07:45:45.789Z', '2026-08-08T08:45:45.789Z')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, note) VALUES ('legacy-detail', 'legacy-transfer', 'legacy-item', 17, '历史明细备注')`)
    const oldProjection = `SELECT r.id, r."fromStoreKey", r."toStoreKey", r.status, r.note, r."createdBy", r."createdAt", r."updatedAt", i.id AS "detailId", i."itemId", i.quantity, i.note AS "detailNote" FROM "TransferRequest" r JOIN "TransferItem" i ON i."requestId" = r.id ORDER BY r.id, i.id`
    const before = await client.$queryRawUnsafe(oldProjection)
    const beforeDigest = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    await assertMigrationHistory(client, migrationNames(root))
    const after = await client.$queryRawUnsafe(oldProjection)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(after)).digest('hex'), beforeDigest)
    const additive = await client.$queryRawUnsafe(`SELECT "shippedBy", "shippedAt", "withdrawnBy", "withdrawnAt" FROM "TransferRequest" WHERE id = 'legacy-transfer'`)
    assert.deepEqual(additive[0], { shippedBy: '', shippedAt: null, withdrawnBy: '', withdrawnAt: null })
    const detail = await client.$queryRawUnsafe(`SELECT "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot" FROM "TransferItem" WHERE id = 'legacy-detail'`)
    assert.deepEqual(detail[0], { itemNameSnapshot: '', itemCodeSnapshot: '', categorySnapshot: '' })
    assert.equal((await client.$queryRawUnsafe(oldProjection)).length, 1)
  } finally {
    await client.$disconnect()
    await dropDisposablePgDatabase(testUrl)
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
