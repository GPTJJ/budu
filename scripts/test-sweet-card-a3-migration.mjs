import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync(new URL('../prisma/migrations/20260906030000_sweet_card_claim_binding/migration.sql', import.meta.url), 'utf8')

test('migration 70 preserves legacy Member binding and adds guarded User claim authority', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TYPE "SweetCardCarrierType" AS ENUM ('PHYSICAL','ELECTRONIC');
    CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Member" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "sweet_card_batches" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "sweet_card_accounts" (
      "id" TEXT PRIMARY KEY,
      "batch_id" TEXT REFERENCES "sweet_card_batches"("id") ON DELETE RESTRICT
    );
    CREATE TABLE "sweet_card_claim_tokens" (
      "id" TEXT PRIMARY KEY,
      "account_id" TEXT NOT NULL REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT
    );
    CREATE TABLE "sweet_card_bindings" (
      "id" TEXT PRIMARY KEY,
      "account_id" TEXT NOT NULL UNIQUE REFERENCES "sweet_card_accounts"("id") ON DELETE RESTRICT,
      "member_id" TEXT NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT,
      "verification_method" TEXT NOT NULL DEFAULT 'ADMIN_VERIFIED',
      "bound_by_id" TEXT NOT NULL,
      "bound_by_name" TEXT NOT NULL DEFAULT '',
      "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX "sweet_card_bindings_member_id_bound_at_idx" ON "sweet_card_bindings"("member_id", "bound_at");
    INSERT INTO "User" VALUES ('user-a'),('user-b');
    INSERT INTO "Member" VALUES ('member-a');
    INSERT INTO "sweet_card_batches" VALUES ('batch');
    INSERT INTO "sweet_card_accounts" VALUES ('legacy-account','batch'),('user-account','batch'),('claim-account','batch');
    INSERT INTO "sweet_card_claim_tokens" VALUES ('token-a','claim-account'),('token-b','user-account');
    INSERT INTO "sweet_card_bindings" ("id","account_id","member_id","bound_by_id")
      VALUES ('legacy-binding','legacy-account','member-a','admin');
  `)
  await db.exec(migration)
  const legacy = await db.query(`SELECT "member_id", "user_id", "channel" FROM "sweet_card_bindings" WHERE "id"='legacy-binding'`)
  assert.deepEqual(legacy.rows[0], { member_id: 'member-a', user_id: null, channel: 'ADMIN' })
  await db.exec(`INSERT INTO "sweet_card_bindings" ("id","account_id","member_id","user_id","channel","bound_by_id") VALUES ('user-binding','user-account',NULL,'user-a','MINIPROGRAM','user-a')`)
  await assert.rejects(() => db.exec(`INSERT INTO "sweet_card_bindings" ("id","account_id","member_id","user_id","bound_by_id") VALUES ('bad-both','claim-account','member-a','user-a','x')`))
  await assert.rejects(() => db.exec(`INSERT INTO "sweet_card_bindings" ("id","account_id","member_id","user_id","bound_by_id") VALUES ('bad-neither','claim-account',NULL,NULL,'x')`))
  await db.exec(`INSERT INTO "sweet_card_claims" ("id","account_id","user_id","token_id","source_carrier","request_key_hash") VALUES ('claim-a','claim-account','user-a','token-a','ELECTRONIC','request-a')`)
  await assert.rejects(() => db.exec(`INSERT INTO "sweet_card_claims" ("id","account_id","user_id","token_id","source_carrier","request_key_hash") VALUES ('claim-b','claim-account','user-b','token-b','ELECTRONIC','request-b')`))
  await assert.rejects(() => db.exec(`INSERT INTO "sweet_card_claims" ("id","account_id","user_id","token_id","source_carrier","request_key_hash") VALUES ('claim-c','user-account','user-a','token-b','ELECTRONIC','request-a')`))
  await db.close()
})
