import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import {
  normalizeSweetCardIssuePayload,
  normalizeSweetCardIssueRequestKey,
  sweetCardIssueFingerprint,
} from '../server/sweet-card-issue.js'

const migration = fs.readFileSync(new URL('../prisma/migrations/20260919010000_sweet_card_issue_idempotency/migration.sql', import.meta.url), 'utf8')
const route = fs.readFileSync(new URL('../server/sweet-card.js', import.meta.url), 'utf8')
const client = fs.readFileSync(new URL('../src/components/SweetCardPage.jsx', import.meta.url), 'utf8')

const basePayload = {
  name: '客户答谢',
  purpose: '九月活动',
  businessPurpose: 'COMMERCIAL',
  cardCount: 3,
  faceValueYuan: '500.00',
  validityType: 'ONE_YEAR',
  carrierType: 'PHYSICAL',
  bindingMode: 'NONE',
  recipientType: 'CUSTOMER',
  recipientLabel: 'A',
  recipientCompany: 'Budu',
  recipientNote: '前台领取',
  giftingScenario: 'THANK_YOU',
  activateNow: true,
}

test('issue request keys follow the existing API convention', () => {
  assert.equal(normalizeSweetCardIssueRequestKey('issue:12345678'), 'issue:12345678')
  for (const invalid of ['', 'short', 'contains space', 'a'.repeat(129), null]) {
    assert.throws(() => normalizeSweetCardIssueRequestKey(invalid), /发卡请求标识无效/)
  }
})

test('canonical payload captures every persisted business input and normalizes non-effective activation', () => {
  const canonical = normalizeSweetCardIssuePayload(basePayload)
  assert.deepEqual(canonical, {
    name: '客户答谢', purpose: '九月活动', businessPurpose: 'COMMERCIAL', cardCount: 3,
    faceValueCents: '50000', validityType: 'ONE_YEAR', carrierType: 'PHYSICAL', bindingMode: 'NONE',
    recipientType: 'CUSTOMER', recipientLabel: 'A', recipientCompany: 'Budu', recipientNote: '前台领取',
    giftingScenario: 'THANK_YOU', presentationTemplateKey: 'minimal-v1', activateNow: false,
  })
  assert.equal(
    sweetCardIssueFingerprint(canonical),
    sweetCardIssueFingerprint(normalizeSweetCardIssuePayload({ ...basePayload, faceValueYuan: '500.0', activateNow: false })),
  )
  assert.notEqual(
    sweetCardIssueFingerprint(canonical),
    sweetCardIssueFingerprint(normalizeSweetCardIssuePayload({ ...basePayload, faceValueYuan: '501.00' })),
  )
})

test('migration is additive and leaves historical Batch/Card/Ledger facts untouched', async () => {
  assert.doesNotMatch(migration, /(?:^|\n)\s*(?:UPDATE|DELETE|TRUNCATE)\b/i)
  assert.doesNotMatch(migration, /ALTER TABLE sweet_card_(?:accounts|credentials|ledger)/i)
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE sweet_card_batches (id TEXT PRIMARY KEY);
    CREATE TABLE sweet_card_accounts (id TEXT PRIMARY KEY, batch_id TEXT);
    CREATE TABLE sweet_card_ledger (id TEXT PRIMARY KEY, account_id TEXT, amount_cents BIGINT);
    INSERT INTO sweet_card_batches VALUES ('legacy-batch');
    INSERT INTO sweet_card_accounts VALUES ('legacy-card', 'legacy-batch');
    INSERT INTO sweet_card_ledger VALUES ('legacy-ledger', 'legacy-card', 50000);
  `)
  await db.exec(migration)
  assert.deepEqual((await db.query('SELECT * FROM sweet_card_batches')).rows, [{ id: 'legacy-batch' }])
  assert.deepEqual((await db.query('SELECT * FROM sweet_card_accounts')).rows, [{ id: 'legacy-card', batch_id: 'legacy-batch' }])
  assert.equal((await db.query('SELECT amount_cents::text FROM sweet_card_ledger')).rows[0].amount_cents, '50000')
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM sweet_card_issue_operations')).rows[0].count, 0)
  await db.close()
})

test('database uniqueness scopes an operation to principal plus request key', () => {
  assert.match(migration, /UNIQUE INDEX sweet_card_issue_operations_actor_id_request_key_key[\s\S]*actor_id, request_key/)
  assert.match(migration, /FOREIGN KEY \(batch_id\) REFERENCES sweet_card_batches\(id\)/)
  assert.match(migration, /request_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/)
})

test('route and current client expose compatible idempotency contracts', () => {
  assert.match(route, /req\.get\('Idempotency-Key'\)/)
  assert.match(route, /LEGACY_REQUEST_WITHOUT_IDEMPOTENCY_KEY/)
  assert.match(route, /requireAdmin\(req, SWEET_CARD_CAPABILITIES\.ISSUE\)[\s\S]*suppliedRequestKey/)
  assert.match(client, /issueAttemptRef = useRef\(null\)/)
  assert.match(client, /'Idempotency-Key': issueAttemptRef\.current\.requestKey/)
  assert.match(client, /issueAttemptRef\.current = null/)
})
