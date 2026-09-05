import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const migration = fs.readFileSync('prisma/migrations/20260905160000_sweet_card_batch_archive/migration.sql', 'utf8')
const service = fs.readFileSync('server/sweet-card.js', 'utf8')
assert.match(migration, /ADD COLUMN "archived_at" TIMESTAMP\(3\)/)
assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|TRUNCATE|DROP)\b/i)
for (const table of ['sweet_card_accounts', 'sweet_card_credentials', 'sweet_card_ledger', 'sweet_card_redemptions', 'sweet_card_refunds', 'orders', 'payments']) {
  assert.doesNotMatch(migration, new RegExp(`ALTER TABLE "${table}"`, 'i'))
}
assert.match(service, /requireAdmin\(req, SWEET_CARD_CAPABILITIES\.MANAGE\)/)
assert.match(service, /sweet_card\.batch_archived/)
assert.match(service, /sweet_card\.batch_restored/)
assert.match(service, /visibilityOnly: true/)
assert.match(service, /sweetCardRouter\.post\('\/sweet-cards\/batches\/:id\/archive'/)
assert.match(service, /sweetCardRouter\.post\('\/sweet-cards\/batches\/:id\/restore'/)
assert.doesNotMatch(service, /sweetCardRouter\.delete\('\/sweet-cards\/(?:batches|cards)/)

async function runPgliteFallback() {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE "sweet_card_batches" (
      "id" TEXT PRIMARY KEY,
      "business_purpose" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "sweet_card_accounts" ("id" TEXT PRIMARY KEY, "batch_id" TEXT NOT NULL, "balance_cents" BIGINT NOT NULL, "status" TEXT NOT NULL);
    CREATE TABLE "sweet_card_credentials" ("id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "status" TEXT NOT NULL);
    CREATE TABLE "sweet_card_bindings" ("id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL);
    CREATE TABLE "sweet_card_ledger" ("id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "amount_cents" BIGINT NOT NULL);
    CREATE TABLE "sweet_card_redemptions" ("id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "amount_cents" BIGINT NOT NULL);
    CREATE TABLE "sweet_card_refunds" ("id" TEXT PRIMARY KEY, "account_id" TEXT NOT NULL, "amount_cents" BIGINT NOT NULL);
    CREATE TABLE "sweet_card_audit_logs" ("id" TEXT PRIMARY KEY, "batch_id" TEXT, "action" TEXT NOT NULL);
    INSERT INTO "sweet_card_batches" ("id", "business_purpose") VALUES ('commercial','COMMERCIAL'), ('acceptance','ACCEPTANCE_TEST');
    INSERT INTO "sweet_card_accounts" VALUES ('account-commercial','commercial',1000,'ACTIVE'), ('account-acceptance','acceptance',1000,'CREATED');
    INSERT INTO "sweet_card_credentials" VALUES ('credential-commercial','account-commercial','ACTIVE');
    INSERT INTO "sweet_card_bindings" VALUES ('binding-commercial','account-commercial');
    INSERT INTO "sweet_card_ledger" VALUES ('ledger-commercial','account-commercial',1000), ('ledger-acceptance','account-acceptance',1000);
    INSERT INTO "sweet_card_redemptions" VALUES ('redemption-commercial','account-commercial',100);
    INSERT INTO "sweet_card_refunds" VALUES ('refund-commercial','account-commercial',50);
  `)
  await db.exec(migration)
  const economicTables = ['sweet_card_accounts', 'sweet_card_credentials', 'sweet_card_bindings', 'sweet_card_ledger', 'sweet_card_redemptions', 'sweet_card_refunds']
  const economicSnapshot = async () => Object.fromEntries(await Promise.all(economicTables.map(async (table) => [table, (await db.query(`SELECT * FROM "${table}" ORDER BY "id"`)).rows])))
  const before = await economicSnapshot()
  await db.exec(`UPDATE "sweet_card_batches" SET "archived_at" = CURRENT_TIMESTAMP WHERE "id" = 'commercial'; INSERT INTO "sweet_card_audit_logs" VALUES ('audit-archive','commercial','sweet_card.batch_archived');`)
  assert.deepEqual(await economicSnapshot(), before)
  assert.deepEqual((await db.query(`SELECT "id" FROM "sweet_card_batches" WHERE "business_purpose"='COMMERCIAL' AND "archived_at" IS NULL`)).rows, [])
  assert.deepEqual((await db.query(`SELECT "id" FROM "sweet_card_batches" WHERE "archived_at" IS NOT NULL`)).rows, [{ id: 'commercial' }])
  await db.exec(`UPDATE "sweet_card_batches" SET "archived_at" = NULL WHERE "id" = 'commercial'; INSERT INTO "sweet_card_audit_logs" VALUES ('audit-restore','commercial','sweet_card.batch_restored');`)
  assert.deepEqual(await economicSnapshot(), before)
  assert.deepEqual((await db.query(`SELECT "id" FROM "sweet_card_batches" WHERE "business_purpose"='COMMERCIAL' AND "archived_at" IS NULL`)).rows, [{ id: 'commercial' }])
  assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM "sweet_card_audit_logs"`)).rows[0].count, 2)
  assert.equal((await db.query(`SELECT SUM("amount_cents")::text AS total FROM "sweet_card_ledger"`)).rows[0].total, '2000')
  assert.equal((await db.query(`SELECT SUM("balance_cents")::text AS total FROM "sweet_card_accounts"`)).rows[0].total, '2000')
  await db.close()
}

try {
  process.env.DATABASE_URL = await createDisposablePgSchema('sweet_card_data_org')
} catch (error) {
  if (!String(error?.message || '').includes('PG_SCHEMA_TEST_NOT_RUN')) throw error
  await runPgliteFallback()
  console.log(JSON.stringify({ result: 'SWEET_CARD_DATA_ORGANIZATION_PASS', databaseMode: 'PGLITE_ISOLATED_MIGRATION_AND_CONTRACT', archive: 'PASS', restore: 'PASS', hardDelete: 'NOT_AVAILABLE', cardDelete: 'DISABLED', ledgerDeltaCents: '0' }))
  process.exit(0)
}
process.env.SWEET_CARD_ENABLED = '1'
process.env.XIDAN_SWEET_CARD_COMMERCIAL = '1'
process.env.SWEET_CARD_CREDENTIAL_KEY = '11'.repeat(32)

const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const register = async (username) => {
  const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '123456' }) })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie').split(';')[0]
}
const developerCookie = await register('data-org-developer')
await register('data-org-pos')
await prisma.user.update({ where: { username: 'data-org-pos' }, data: { role: 'cashier' } })
const posLogin = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'data-org-pos', password: '123456' }) })
assert.equal(posLogin.status, 200)
const posCookie = posLogin.headers.get('set-cookie').split(';')[0]

const seedBatch = async ({ id, purpose, archivedAt = null, status = 'CREATED', withCredential = false, amount = 1000n }) => prisma.sweetCardBatch.create({ data: {
  id: `batch-${id}`, name: `Batch ${id}`, purpose: '', businessPurpose: purpose,
  faceValueCents: amount, cardCount: 1, totalInitialAmountCents: amount,
  validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'NONE', createdById: 'seed', archivedAt,
  accounts: { create: { id: `account-${id}`, publicCardNo: `SC-${id}`, initialAmountCents: amount, balanceCents: amount,
    validityType: 'LONG_TERM', status, carrierType: 'ELECTRONIC', bindingMode: 'NONE',
    ...(withCredential ? { credentials: { create: { id: `credential-${id}`, publicTokenId: `TOKEN-${id}`, tokenHash: `HASH-${id}`, tokenCiphertext: `CIPHER-${id}`, tokenIv: `IV-${id}`, tokenTag: `TAG-${id}`, status: 'ACTIVE', carrierType: 'ELECTRONIC' } } } : {}),
    ledger: { create: { id: `ledger-${id}`, type: 'ISSUE', amountCents: amount, balanceAfterCents: amount, requestKey: `issue-${id}`, actorId: 'seed' } },
  } },
} })

await seedBatch({ id: 'commercial', purpose: 'COMMERCIAL' })
await seedBatch({ id: 'acceptance', purpose: 'ACCEPTANCE_TEST' })
await seedBatch({ id: 'archived', purpose: 'ACCEPTANCE_TEST', archivedAt: new Date('2026-09-01T00:00:00Z') })
await seedBatch({ id: 'void', purpose: 'COMMERCIAL', status: 'ACTIVE', withCredential: true })
await prisma.sweetCardBatch.create({ data: {
  id: 'batch-empty', name: 'Empty without draft authority', purpose: '', businessPurpose: 'ACCEPTANCE_TEST',
  faceValueCents: 1n, cardCount: 0, totalInitialAmountCents: 0n, validityType: 'LONG_TERM',
  carrierType: 'ELECTRONIC', bindingMode: 'NONE', createdById: 'seed',
} })

const request = async (path, { cookie = developerCookie, method = 'GET', body } = {}) => fetch(`${origin}/api/v2${path}`, {
  method,
  headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const json = async (path, options) => {
  const response = await request(path, options)
  return { status: response.status, body: await response.json() }
}
const economicSnapshot = async () => ({
  accounts: await prisma.sweetCardAccount.findMany({ orderBy: { id: 'asc' }, select: { id: true, batchId: true, balanceCents: true, initialAmountCents: true, status: true, version: true, activatedAt: true } }),
  credentials: await prisma.sweetCardCredential.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, status: true, revokedAt: true, revokeReason: true } }),
  bindings: await prisma.sweetCardBinding.findMany({ orderBy: { id: 'asc' } }),
  ledger: await prisma.sweetCardLedger.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, type: true, amountCents: true, balanceAfterCents: true, orderId: true, redemptionId: true, refundId: true, requestKey: true } }),
  redemptions: await prisma.sweetCardRedemption.findMany({ orderBy: { id: 'asc' } }),
  refunds: await prisma.sweetCardRefund.findMany({ orderBy: { id: 'asc' } }),
})

try {
  const commercial = await json('/sweet-cards/batches')
  assert.equal(commercial.status, 200)
  assert.equal(commercial.body.businessPurpose, 'COMMERCIAL')
  assert.equal(commercial.body.archived, false)
  assert.deepEqual(commercial.body.batches.map((row) => row.id).sort(), ['batch-commercial', 'batch-void'])

  const acceptance = await json('/sweet-cards/batches?businessPurpose=ACCEPTANCE_TEST&archived=false')
  assert.deepEqual(acceptance.body.batches.map((row) => row.id).sort(), ['batch-acceptance', 'batch-empty'])
  const archived = await json('/sweet-cards/batches?businessPurpose=ALL&archived=true')
  assert.deepEqual(archived.body.batches.map((row) => row.id), ['batch-archived'])
  assert.equal((await json('/sweet-cards/cards?businessPurpose=ALL&archived=true')).body.cards[0].id, 'account-archived')

  const beforeArchive = await economicSnapshot()
  const archive = await json('/sweet-cards/batches/batch-commercial/archive', { method: 'POST', body: {} })
  assert.equal(archive.status, 200)
  assert.ok(archive.body.batch.archivedAt)
  assert.deepEqual(await economicSnapshot(), beforeArchive)
  assert.equal((await json('/sweet-cards/batches')).body.batches.some((row) => row.id === 'batch-commercial'), false)
  assert.equal((await json('/sweet-cards/batches?businessPurpose=ALL&archived=true')).body.batches.some((row) => row.id === 'batch-commercial'), true)
  assert.equal(await prisma.sweetCardAuditLog.count({ where: { batchId: 'batch-commercial', action: 'sweet_card.batch_archived' } }), 1)

  const restore = await json('/sweet-cards/batches/batch-commercial/restore', { method: 'POST', body: {} })
  assert.equal(restore.status, 200)
  assert.equal(restore.body.batch.archivedAt, null)
  assert.deepEqual(await economicSnapshot(), beforeArchive)
  assert.equal(await prisma.sweetCardAuditLog.count({ where: { batchId: 'batch-commercial', action: 'sweet_card.batch_restored' } }), 1)

  assert.equal((await request('/sweet-cards/batches/batch-commercial/archive', { cookie: posCookie, method: 'POST', body: {} })).status, 403)
  assert.equal((await request('/sweet-cards/batches/batch-commercial', { method: 'DELETE' })).status, 404)
  assert.equal((await request('/sweet-cards/batches/batch-empty', { method: 'DELETE' })).status, 404)
  assert.equal((await request('/sweet-cards/cards/account-commercial', { method: 'DELETE' })).status, 404)

  const voidBalance = (await prisma.sweetCardAccount.findUnique({ where: { id: 'account-void' } })).balanceCents
  const voidLedger = await prisma.sweetCardLedger.findMany({ where: { accountId: 'account-void' }, orderBy: { id: 'asc' } })
  const voidResult = await json('/sweet-cards/cards/account-void/void', { method: 'POST' })
  assert.equal(voidResult.status, 200)
  const voided = await prisma.sweetCardAccount.findUnique({ where: { id: 'account-void' }, include: { credentials: true } })
  assert.equal(voided.status, 'VOID')
  assert.equal(voided.balanceCents, voidBalance)
  assert.equal(voided.credentials[0].status, 'REVOKED')
  assert.equal(voided.credentials[0].revokeReason, 'CARD_VOID')
  assert.deepEqual(await prisma.sweetCardLedger.findMany({ where: { accountId: 'account-void' }, orderBy: { id: 'asc' } }), voidLedger)
  assert.equal(await prisma.sweetCardAuditLog.count({ where: { accountId: 'account-void', action: 'sweet_card.void' } }), 1)

  const reconciliation = await json('/sweet-cards/reconciliation')
  assert.equal(reconciliation.status, 200)
  assert.equal(reconciliation.body.scope, 'ALL_REAL_FACTS')
  assert.equal(reconciliation.body.all.deltaCents, '0')
  assert.equal(reconciliation.body.all.balanceCents, '4000')
  assert.equal(reconciliation.body.all.ledgerCents, '4000')
  assert.equal(reconciliation.body.byPurpose.COMMERCIAL.balanceCents, '2000')
  assert.equal(reconciliation.body.byPurpose.ACCEPTANCE_TEST.balanceCents, '2000')

  console.log(JSON.stringify({ result: 'SWEET_CARD_DATA_ORGANIZATION_PASS', archive: 'PASS', restore: 'PASS', hardDelete: 'NOT_AVAILABLE', cardDelete: 'DISABLED', void: 'EXISTING_CONTRACT_ONLY', ledgerDeltaCents: '0' }))
} finally {
  server.close()
  await prisma.$disconnect()
}
