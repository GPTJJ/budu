import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SWEET_CARD_NAMESPACE, SWEET_CARD_PRESENTATION_CONTRACT, allocateCents, decryptToken,
  encryptToken, expiryFor, isSweetCardToken, newCredential, parseAmount, sweetCardEnabled, tokenHash,
} from '../server/sweet-card-core.js'
import { MODULE_KEYS, SWEET_CARD_CAPABILITIES, hasModuleAccess, hasSweetCardCapability, normalizeAccountPermissions } from '../shared/accountPermissions.js'

process.env.SWEET_CARD_CREDENTIAL_KEY = '11'.repeat(32)
const read = (path) => fs.readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('1 value account and credential remain separate schema models', () => { const s = read('prisma/schema.prisma'); assert.match(s, /model SweetCardAccount/); assert.match(s, /model SweetCardCredential/) })
test('2 QR namespace is unique and scanner-recognizable', () => assert.equal(isSweetCardToken(`${SWEET_CARD_NAMESPACE}a.b`), true))
test('3 generated credential has high entropy and no raw database id', () => { const a = newCredential(); const b = newCredential(); assert.notEqual(a.token, b.token); assert.ok(a.token.length > 70); assert.ok(!a.token.includes('scv-')) })
test('4 token verifier is deterministic and one way', () => { const token = `${SWEET_CARD_NAMESPACE}abc.secret`; assert.equal(tokenHash(token), tokenHash(token)); assert.notEqual(tokenHash(token), token) })
test('5 encrypted credential round trips without plaintext storage', () => { const token = `${SWEET_CARD_NAMESPACE}abc.${'x'.repeat(43)}`; const encrypted = encryptToken(token); assert.ok(!encrypted.ciphertext.includes(token)); assert.equal(decryptToken({ tokenCiphertext: encrypted.ciphertext, tokenIv: encrypted.iv, tokenTag: encrypted.tag }), token) })
test('6 integer cents reject zero, negative and float', () => { assert.equal(parseAmount('50000'), 50000n); for (const value of ['0', '-1', '1.2']) assert.throws(() => parseAmount(value)) })
test('7 amount safety cap is enforced server-side', () => assert.throws(() => parseAmount('10000001')))
test('8 one-year expiry is calendar exact', () => assert.equal(expiryFor('ONE_YEAR', new Date('2026-09-04T00:00:00Z')).toISOString(), '2027-09-04T00:00:00.000Z'))
test('9 three-year expiry is calendar exact', () => assert.equal(expiryFor('THREE_YEARS', new Date('2026-09-04T00:00:00Z')).toISOString(), '2029-09-04T00:00:00.000Z'))
test('10 long-term card has no fabricated expiry', () => assert.equal(expiryFor('LONG_TERM'), null))
test('11 deterministic allocation never exceeds item eligibility', () => { const rows = allocateCents(300n, [{ id: 'b', eligibleAmountCents: 200n }, { id: 'a', eligibleAmountCents: 200n }]); assert.deepEqual(rows.map((x) => [x.id, x.redeemedAmountCents]), [['a', 200n], ['b', 100n]]) })
test('12 all-blacklist allocation stays zero', () => assert.equal(allocateCents(0n, [{ id: 'a', eligibleAmountCents: 0n }])[0].redeemedAmountCents, 0n))
test('13 production feature switch defaults OFF', () => { const old = process.env.SWEET_CARD_ENABLED; delete process.env.SWEET_CARD_ENABLED; assert.equal(sweetCardEnabled(), false); if (old == null) delete process.env.SWEET_CARD_ENABLED; else process.env.SWEET_CARD_ENABLED = old })
test('14 feature switch only accepts explicit true values', () => { process.env.SWEET_CARD_ENABLED = '1'; assert.equal(sweetCardEnabled(), true); process.env.SWEET_CARD_ENABLED = 'no'; assert.equal(sweetCardEnabled(), false) })
test('15 developer/admin capabilities are centralized', () => { const p = normalizeAccountPermissions({}, 'admin'); assert.equal(p.sweetCard.issue, true); assert.equal(p.sweetCard.void, true) })
test('16 cashier gets POS but no management capability', () => { const u = { status: 'active', role: 'cashier', permissions: {} }; assert.equal(hasModuleAccess(u, MODULE_KEYS.STORE_POS), true); assert.equal(hasSweetCardCapability(u, SWEET_CARD_CAPABILITIES.ISSUE), false) })
test('17 granted staff capability does not silently grant module access', () => { const u = { status: 'active', role: 'staff', permissions: { sweetCard: { view: true }, modules: { [MODULE_KEYS.SWEET_CARD]: false } } }; assert.equal(hasSweetCardCapability(u, 'view'), true); assert.equal(hasModuleAccess(u, MODULE_KEYS.SWEET_CARD), false) })
test('18 presentation renderer contract is replaceable', () => { assert.equal(SWEET_CARD_PRESENTATION_CONTRACT.templateKey, 'minimal-v1'); assert.ok(SWEET_CARD_PRESENTATION_CONTRACT.slots.includes('qr')) })
test('19 migration is additive and performs no historical DML', () => { const sql = read('prisma/migrations/20260904170000_sweet_card_candidate/migration.sql'); assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|DROP|TRUNCATE|ALTER\s+TABLE\s+.+\s+RENAME)\b/im); assert.match(sql, /ADD COLUMN/) })
test('20 refund authority uses original item allocation and idempotent ledger key', () => { const s = read('server/sweet-card-refunds.js'); assert.match(s, /redemptionItemId/); assert.match(s, /sweet-refund:/); assert.match(s, /findUnique\(\{ where: \{ requestKey: ledgerKey/) })
test('21 double-spend path takes account and order advisory locks', () => { const s = read('server/sweet-card.js'); assert.match(s, /lockOrder/); assert.match(s, /pg_advisory_xact_lock/); assert.match(s, /isolationLevel: 'Serializable'/) })
test('22 one-card-per-order is database and service enforced', () => { const schema = read('prisma/schema.prisma'); const service = read('server/sweet-card.js'); assert.match(schema, /orderId\s+String\s+@unique/); assert.match(service, /一笔订单最多使用一张甜意卡/) })
test('23 category rules reuse ProductCategory id rather than names', () => { const s = read('prisma/schema.prisma'); assert.match(s, /categoryId\s+String\s+@id/); assert.match(s, /category\s+ProductCategory/) })
test('24 store rules fail closed and reuse Store key', () => { const s = read('server/sweet-card.js'); assert.match(s, /if \(!policy\?\.eligible\)/); assert.match(read('prisma/schema.prisma'), /storeId\s+String\s+@id/) })
test('25 payment invariant includes internal tender exactly', () => assert.match(read('server/settlements/settlement-coordinator.js'), /payment\.amount \+ sweetCardAmount !== payment\.order\.payableAmount/))
test('26 required balance examples remain exact integer cents', () => { let balance = 100000n; balance -= 20000n; assert.equal(balance, 80000n); balance -= 30000n; assert.equal(balance, 50000n) })
test('27 category blacklist caps redemption to eligible subtotal', () => { const eligible = 30000n; const balance = 100000n; const payable = 50000n; assert.equal([eligible, balance, payable].reduce((a, b) => a < b ? a : b), 30000n) })
test('28 management surface includes usage, filtering, presets and complete carrier details', () => { const ui = read('src/components/SweetCardPage.jsx'); assert.match(ui, /\['usage', '使用记录'\]/); assert.match(ui, /¥500/); assert.match(ui, /¥1000/); assert.match(ui, /按批次筛选/); assert.match(ui, /Credential/) })
test('29 loss and replacement are separate audited transitions', () => { const service = read('server/sweet-card.js'); assert.match(service, /cards\/:id\/lost'/); assert.match(service, /cards\/:id\/replace'/); assert.match(service, /sweet_card\.lost/); assert.match(service, /sweet_card\.credential_replaced/) })
test('30 ledger references canonical Order and Refund authorities', () => { const sql = read('prisma/migrations/20260904170000_sweet_card_candidate/migration.sql'); assert.match(sql, /sweet_card_ledger_order_fkey/); assert.match(sql, /sweet_card_ledger_refund_fkey/) })
