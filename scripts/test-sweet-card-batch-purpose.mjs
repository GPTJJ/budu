import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = fs.readFileSync(new URL('../prisma/migrations/20260905130000_sweet_card_batch_purpose_authority/migration.sql', import.meta.url), 'utf8')
const rollback = fs.readFileSync(new URL('../prisma/rollbacks/20260905130000_sweet_card_batch_purpose_authority.rollback.sql', import.meta.url), 'utf8')
const service = fs.readFileSync(new URL('../server/sweet-card.js', import.meta.url), 'utf8')

test('Migration 65 classifies every pre-authority batch as ACCEPTANCE_TEST without touching economic tables', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "sweet_card_batches" (
      "id" TEXT PRIMARY KEY,
      "purpose" TEXT NOT NULL DEFAULT '',
      "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "sweet_card_batches" ("id", "purpose") VALUES
      ('p7', 'Production Gate acceptance'),
      ('p10', 'P10-P19 approved acceptance'),
      ('later-test', '测试');
  `)
  await db.exec(migration)
  const rows = await db.query('SELECT "id", "business_purpose"::text AS purpose FROM "sweet_card_batches" ORDER BY "id"')
  assert.deepEqual(rows.rows, [
    { id: 'later-test', purpose: 'ACCEPTANCE_TEST' },
    { id: 'p10', purpose: 'ACCEPTANCE_TEST' },
    { id: 'p7', purpose: 'ACCEPTANCE_TEST' },
  ])
  await assert.rejects(() => db.exec('INSERT INTO "sweet_card_batches" ("id") VALUES (\'missing-purpose\')'))
  await db.exec('INSERT INTO "sweet_card_batches" ("id", "business_purpose") VALUES (\'commercial\', \'COMMERCIAL\')')
  await assert.rejects(() => db.exec(rollback), /commercial Sweet Card batches exist/)
  await db.close()
})

test('commercial reports default to typed COMMERCIAL and full reconciliation remains ALL facts', () => {
  assert.match(service, /reportPurpose\(req\.query\.businessPurpose\)/)
  assert.match(service, /fallback = 'COMMERCIAL'/)
  assert.match(service, /scope: 'ALL_REAL_FACTS'/)
  assert.match(service, /byPurpose: \{ COMMERCIAL:/)
  assert.match(service, /businessPurpose: purpose/)
  assert.match(service, /必须选择正式批次用途/)
})

test('migration is classification-only and does not update economic tables', () => {
  assert.match(migration, /UPDATE "sweet_card_batches"/)
  assert.doesNotMatch(migration, /sweet_card_(?:accounts|ledger|redemptions|refunds)/i)
  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i)
})
