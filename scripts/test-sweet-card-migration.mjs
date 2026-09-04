import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync(new URL('../prisma/migrations/20260904170000_sweet_card_candidate/migration.sql', import.meta.url), 'utf8')

test('migration 63 rehearses on a legacy-compatible PostgreSQL catalog without mutating existing facts', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TYPE "RefundMode" AS ENUM ('PAYMENT','MANUAL_EXTERNAL');
    CREATE TABLE "Store" ("key" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "InventoryItem" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "ProductCategory" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "Member" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "orders" ("id" TEXT PRIMARY KEY, "payable_amount" BIGINT NOT NULL);
    CREATE TABLE "order_items" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "refunds" ("id" TEXT PRIMARY KEY, "refund_amount" BIGINT NOT NULL, "refund_mode" "RefundMode" NOT NULL);
    CREATE TABLE "refund_items" ("id" TEXT PRIMARY KEY);
    INSERT INTO "Store" VALUES ('legacy-store','Legacy');
    INSERT INTO "orders" VALUES ('legacy-order',12345);
    INSERT INTO "order_items" VALUES ('legacy-item');
    INSERT INTO "refunds" VALUES ('legacy-refund',1000,'PAYMENT');
  `)
  await db.exec(migration)
  const legacy = await db.query(`SELECT "payable_amount", "sweet_card_amount" FROM "orders" WHERE "id"='legacy-order'`)
  assert.deepEqual(legacy.rows[0], { payable_amount: 12345, sweet_card_amount: 0 })
  const refund = await db.query(`SELECT "refund_amount", "provider_refund_amount", "sweet_card_refund_amount" FROM "refunds" WHERE "id"='legacy-refund'`)
  assert.deepEqual(refund.rows[0], { refund_amount: 1000, provider_refund_amount: null, sweet_card_refund_amount: null })
  await db.exec(`INSERT INTO "sweet_card_batches" ("id","name","face_value_cents","card_count","total_initial_amount_cents","validity_type","carrier_type","binding_mode","created_by_id") VALUES ('b','Batch',50000,1,50000,'ONE_YEAR','PHYSICAL','NONE','u')`)
  await assert.rejects(() => db.exec(`INSERT INTO "sweet_card_accounts" ("id","public_card_no","batch_id","initial_amount_cents","balance_cents","validity_type","carrier_type","binding_mode") VALUES ('a','SC1','b',50000,-1,'ONE_YEAR','PHYSICAL','NONE')`))
  await db.close()
})
