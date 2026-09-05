import assert from 'node:assert/strict'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

process.env.DATABASE_URL = await createDisposablePgSchema('sweet_card_purpose')
process.env.SWEET_CARD_ENABLED = '1'
process.env.XIDAN_SWEET_CARD_COMMERCIAL = '1'
process.env.SWEET_CARD_CREDENTIAL_KEY = '11'.repeat(32)

const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const server = createApp().listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const register = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'purpose-developer', password: '123456' }) })
assert.equal(register.status, 200)
const cookie = register.headers.get('set-cookie').split(';')[0]

const seed = async (businessPurpose, cents, suffix) => prisma.sweetCardBatch.create({ data: {
  id: `batch-${suffix}`, name: `Batch ${suffix}`, purpose: 'descriptive note', businessPurpose,
  faceValueCents: cents, cardCount: 1, totalInitialAmountCents: cents,
  validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'NONE', createdById: 'seed',
  accounts: { create: { id: `account-${suffix}`, publicCardNo: `SC-${suffix}`, initialAmountCents: cents, balanceCents: cents,
    validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'NONE',
    ledger: { create: { id: `ledger-${suffix}`, type: 'ISSUE', amountCents: cents, balanceAfterCents: cents, requestKey: `issue-${suffix}`, actorId: 'seed' } },
  } },
} })

await seed('ACCEPTANCE_TEST', 50000n, 'test')
await seed('COMMERCIAL', 1000n, 'commercial')
const call = async (path) => {
  const response = await fetch(`${origin}/api/v2${path}`, { headers: { Cookie: cookie } })
  return { status: response.status, body: await response.json() }
}

const [commercial, acceptance, all, reconciliation, batches] = await Promise.all([
  call('/sweet-cards/overview'),
  call('/sweet-cards/overview?businessPurpose=ACCEPTANCE_TEST'),
  call('/sweet-cards/overview?businessPurpose=ALL'),
  call('/sweet-cards/reconciliation'),
  call('/sweet-cards/batches'),
])
assert.equal(commercial.status, 200); assert.equal(commercial.body.businessPurpose, 'COMMERCIAL'); assert.equal(commercial.body.balanceCents, '1000')
assert.equal(acceptance.status, 200); assert.equal(acceptance.body.balanceCents, '50000')
assert.equal(all.status, 200); assert.equal(all.body.balanceCents, '51000')
assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.all.ledgerCents, '51000'); assert.equal(reconciliation.body.all.deltaCents, '0')
assert.equal(reconciliation.body.byPurpose.COMMERCIAL.balanceCents, '1000'); assert.equal(reconciliation.body.byPurpose.ACCEPTANCE_TEST.balanceCents, '50000')
assert.equal(batches.status, 200); assert.equal(batches.body.businessPurpose, 'COMMERCIAL'); assert.deepEqual(batches.body.batches.map((row) => row.id), ['batch-commercial'])

const rejected = await fetch(`${origin}/api/v2/sweet-cards/batches`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No purpose', cardCount: 1, faceValueCents: '1', validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'NONE' }) })
assert.equal(rejected.status, 400)
console.log(JSON.stringify({ result: 'SWEET_CARD_PURPOSE_REPORT_PASS', commercialOutstanding: '1000', acceptanceOutstanding: '50000', allLedger: '51000', delta: '0' }))

server.close()
await prisma.$disconnect()
