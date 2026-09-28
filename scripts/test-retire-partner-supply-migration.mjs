import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../prisma/migrations/20260928010000_retire_partner_supply/migration.sql', import.meta.url), 'utf8')

async function fixture(partnerName) {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "InventoryItem" (id TEXT PRIMARY KEY, "partnerSupplyEnabled" BOOLEAN NOT NULL DEFAULT FALSE);
    CREATE TABLE "Partner" (id TEXT PRIMARY KEY);
    CREATE TABLE "PartnerStore" (id TEXT PRIMARY KEY);
    CREATE TABLE "ReplenishmentOrder" (id TEXT PRIMARY KEY);
    CREATE TABLE "PartnerSupplyOrder" (id TEXT PRIMARY KEY, "partnerNameSnapshot" TEXT NOT NULL);
    CREATE TABLE "PartnerSupplyItem" (id TEXT PRIMARY KEY, "orderId" TEXT REFERENCES "PartnerSupplyOrder"(id), "productId" TEXT REFERENCES "InventoryItem"(id));
    CREATE TABLE "PartnerReceipt" (id TEXT PRIMARY KEY, "orderId" TEXT REFERENCES "PartnerSupplyOrder"(id));
    INSERT INTO "InventoryItem" VALUES ('stable-product', TRUE);
    INSERT INTO "Partner" VALUES ('formal-partner');
    INSERT INTO "PartnerStore" VALUES ('formal-store');
    INSERT INTO "ReplenishmentOrder" VALUES ('formal-order');
  `)
  await db.query('INSERT INTO "PartnerSupplyOrder" VALUES ($1, $2)', ['legacy-order', partnerName])
  await db.exec(`INSERT INTO "PartnerSupplyItem" VALUES ('legacy-item', 'legacy-order', 'stable-product'); INSERT INTO "PartnerReceipt" VALUES ('legacy-receipt', 'legacy-order');`)
  return db
}

test('迁移拒绝秦皇岛之外的旧订单并保持原结构与正式补货事实', async () => {
  const db = await fixture('真实合作商')
  try {
    await assert.rejects(() => db.exec(migration), /PARTNER_SUPPLY_REAL_DATA_REVIEW_REQUIRED/)
    await db.exec('ROLLBACK')
    assert.equal((await db.query('SELECT count(*) AS n FROM "PartnerSupplyOrder"')).rows[0].n, 1)
    assert.equal((await db.query('SELECT id FROM "ReplenishmentOrder"')).rows[0].id, 'formal-order')
  } finally { await db.close() }
})

test('迁移仅删除旧体验版结构，保留 Partner/Store/InventoryItem 身份和正式订单', async () => {
  const db = await fixture('秦皇岛体验合作商')
  try {
    await db.exec(migration)
    const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map((row) => row.tablename)
    for (const name of ['PartnerSupplyOrder', 'PartnerSupplyItem', 'PartnerReceipt']) assert.ok(!tables.includes(name), name)
    for (const name of ['Partner', 'PartnerStore', 'InventoryItem', 'ReplenishmentOrder']) assert.ok(tables.includes(name), name)
    assert.equal((await db.query('SELECT id FROM "InventoryItem"')).rows[0].id, 'stable-product')
    assert.equal((await db.query('SELECT id FROM "ReplenishmentOrder"')).rows[0].id, 'formal-order')
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='InventoryItem'")).rows.map((row) => row.column_name)
    assert.ok(!columns.includes('partnerSupplyEnabled'))
  } finally { await db.close() }
})
