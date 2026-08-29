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
const schemaName = `partner_supply_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260829043000_partner_supply'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000,
  })
}

test('Partner Supply additive migration seeds explicit partner data and preserves all existing business facts', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-partner-supply-migration-'))
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
    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('guanshe', '北京官舍店'), ('tongying', '北京通盈中心店')`)
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, "transferCode", "transferEnabled", "isActive", "salePriceCents") VALUES ('p1', 'NO.1树莓', 'product', 'NO.1', true, true, 500), ('m1', '冰袋', 'material', NULL, true, true, NULL)`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy", "shippedBy", "shippedAt") VALUES ('tr', 'guanshe', 'tongying', 'shipped', 'legacy', 'shipper', NOW())`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, note, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('ti', 'tr', 'p1', 5, '历史', 'NO.1树莓', 'NO.1', 'product')`)
    const projection = `SELECT i.id, i.name, i.category, i."transferCode", i."transferEnabled", i."isActive", i."salePriceCents"::text, t.id AS "transferId", t.quantity, t.note FROM "InventoryItem" i LEFT JOIN "TransferItem" t ON t."itemId" = i.id ORDER BY i.id`
    const before = await client.$queryRawUnsafe(projection)
    const digest = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex')
    const stockBefore = await client.$queryRawUnsafe(`SELECT (SELECT COUNT(*)::int FROM "StockBalance") AS balances, (SELECT COUNT(*)::int FROM "StockLedger") AS ledger`)

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 53)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(await client.$queryRawUnsafe(projection))).digest('hex'), digest)
    assert.deepEqual(await client.$queryRawUnsafe(`SELECT (SELECT COUNT(*)::int FROM "StockBalance") AS balances, (SELECT COUNT(*)::int FROM "StockLedger") AS ledger`), stockBefore)
    const partner = await client.partner.findUnique({ where: { id: 'partner-qinhuangdao-v1' } })
    assert.equal(partner?.name, '秦皇岛合作商')
    assert.equal(partner?.defaultStoreKey, 'guanshe')
    assert.equal(partner?.defaultDiscountBps, 6500)
    assert.equal(await client.partnerSupplyOrder.count(), 0)
    assert.equal(await client.partnerReceipt.count(), 0)
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
