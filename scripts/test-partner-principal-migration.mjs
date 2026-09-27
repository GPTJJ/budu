import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync(new URL('../prisma/migrations/20260906170000_partner_principal_boundary/migration.sql', import.meta.url), 'utf8')

test('Gate 1 migration preserves customer sessions and adds fail-closed PartnerUser constraints', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "role" TEXT NOT NULL, "status" TEXT NOT NULL);
    CREATE TABLE "Partner" ("id" TEXT PRIMARY KEY, "isActive" BOOLEAN NOT NULL);
    CREATE TABLE "customer_sessions" (
      "id" TEXT PRIMARY KEY,
      "token_hash" TEXT NOT NULL UNIQUE,
      "user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
      "expires_at" TIMESTAMP(3) NOT NULL,
      "revoked_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "User" VALUES ('customer-a','customer','active'), ('partner-a-user','partner','active');
    INSERT INTO "Partner" VALUES ('partner-a',TRUE), ('partner-b',TRUE);
    INSERT INTO "customer_sessions" ("id","token_hash","user_id","expires_at")
      VALUES ('session-a','hash-a','customer-a','2027-01-01');
  `)
  await db.exec(migration)
  const legacy = await db.query(`SELECT "id", "token_hash", "user_id", "principal_type" FROM "customer_sessions"`)
  assert.deepEqual(legacy.rows, [{ id: 'session-a', token_hash: 'hash-a', user_id: 'customer-a', principal_type: 'CUSTOMER' }])

  await db.exec(`INSERT INTO "partner_users" ("id","partner_id","user_id") VALUES ('binding-a','partner-a','partner-a-user')`)
  await assert.rejects(() => db.exec(`INSERT INTO "partner_users" ("id","partner_id","user_id") VALUES ('binding-b','partner-b','partner-a-user')`))
  await assert.rejects(() => db.exec(`INSERT INTO "partner_users" ("id","partner_id","user_id","status") VALUES ('binding-bad','partner-b','customer-a','paused')`))
  await assert.rejects(() => db.exec(`INSERT INTO "customer_sessions" ("id","token_hash","user_id","principal_type","expires_at") VALUES ('bad-session','hash-b','partner-a-user','INTERNAL','2027-01-01')`))
  await assert.rejects(() => db.exec(`DELETE FROM "User" WHERE "id"='partner-a-user'`))
  await assert.rejects(() => db.exec(`DELETE FROM "Partner" WHERE "id"='partner-a'`))
  await db.close()
})
