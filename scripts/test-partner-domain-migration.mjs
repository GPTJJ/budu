import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync(new URL('../prisma/migrations/20260906200000_partner_domain_foundation/migration.sql', import.meta.url), 'utf8')

test('Gate 2 migration preserves Partner/PartnerUser facts and adds 1:N stores plus lifecycle constraints', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "Partner" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL UNIQUE,
      "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
      "defaultDiscountBps" INTEGER NOT NULL DEFAULT 6500
    );
    CREATE TABLE "partner_users" (
      "id" TEXT PRIMARY KEY,
      "partner_id" TEXT NOT NULL REFERENCES "Partner"("id") ON DELETE RESTRICT,
      "user_id" TEXT NOT NULL UNIQUE
    );
    INSERT INTO "Partner" VALUES ('active','秦皇岛',TRUE,6500), ('inactive','历史停用合作商',FALSE,7200);
    INSERT INTO "partner_users" VALUES ('binding-a','active','user-a');
  `)
  await db.exec(migration)

  const partners = await db.query(`SELECT "id", "status", "defaultDiscountBps" FROM "Partner" ORDER BY "id"`)
  assert.deepEqual(partners.rows, [
    { id: 'active', status: 'ACTIVE', defaultDiscountBps: 6500 },
    { id: 'inactive', status: 'PAUSED', defaultDiscountBps: 7200 },
  ])
  assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM "partner_users"`)).rows[0].count, 1)

  await db.exec(`
    INSERT INTO "PartnerStore" ("id","partnerId","name","province","city","district","addressLine")
      VALUES ('store-a','active','一号店','北京市','北京市','西城区','测试路1号');
    INSERT INTO "PartnerStore" ("id","partnerId","name","province","city","district","addressLine")
      VALUES ('store-b','active','二号店','河北省','秦皇岛市','海港区','测试路2号');
  `)
  assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM "PartnerStore" WHERE "partnerId"='active'`)).rows[0].count, 2)
  await assert.rejects(() => db.exec(`INSERT INTO "PartnerStore" ("id","partnerId","name","status") VALUES ('store-c','active','一号店','ACTIVE')`))
  await assert.rejects(() => db.exec(`INSERT INTO "PartnerStore" ("id","partnerId","name","status") VALUES ('store-c','active','三号店','PAUSED')`))
  await assert.rejects(() => db.exec(`DELETE FROM "Partner" WHERE "id"='active'`))
  await db.close()
})
