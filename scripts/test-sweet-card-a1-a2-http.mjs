import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { hashPassword } from '../server/auth.js'
import { createCustomerSession } from '../server/customer-auth.js'
import { prisma } from '../server/pg.js'
import { issueSweetCardClaimCredential } from '../server/sweet-card-claim.js'

const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const ids = {
  admin: `a1a2-http-admin-${runId}`,
  customer: `a1a2-http-customer-${runId}`,
  batch: `a1a2-http-batch-${runId}`,
  account: `a1a2-http-account-${runId}`,
}
const endpoint = 'http://127.0.0.1:3000/api/customer/sweet-card/claim/resolve'

async function snapshot() {
  const [row] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM sweet_card_accounts) AS accounts,
      (SELECT COUNT(*)::int FROM sweet_card_ledger) AS ledger_rows,
      (SELECT COALESCE(SUM(amount_cents), 0)::text FROM sweet_card_ledger) AS ledger_cents,
      (SELECT COUNT(*)::int FROM sweet_card_redemptions) AS redemptions,
      (SELECT COUNT(*)::int FROM sweet_card_refunds) AS refunds,
      (SELECT COUNT(*)::int FROM sweet_card_bindings) AS bindings,
      (SELECT COUNT(*)::int FROM sweet_card_credentials) AS pos_credentials
  `
  return row
}

async function resolve({ session, token, proof }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session}`,
      'content-type': 'application/json',
      'x-budu-test-gateway': '1',
    },
    body: JSON.stringify({ claimToken: token, claimProof: proof }),
  })
  return { status: response.status, body: await response.json() }
}

const before = await snapshot()
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, 'budu_sc11a_test')
  assert.equal(process.env.APP_ENV, 'test')

  await prisma.user.createMany({ data: [
    {
      id: ids.admin, username: `a1a2_http_admin_${runId}`, passwordHash: 'test-only:unusable',
      role: 'developer', displayName: 'A1A2 HTTP Test', storeKeys: [], permissions: {},
    },
    {
      id: ids.customer, username: `a1a2_http_customer_${runId}`,
      passwordHash: hashPassword(crypto.randomBytes(32).toString('base64url')),
      role: 'customer', displayName: '', storeKeys: [], permissions: {}, employeeId: '',
    },
  ] })
  await prisma.sweetCardBatch.create({ data: {
    id: ids.batch, name: 'A1A2 isolated HTTP fixture', purpose: 'TEST_ONLY',
    businessPurpose: 'ACCEPTANCE_TEST', faceValueCents: 50000n, cardCount: 1,
    totalInitialAmountCents: 50000n, validityType: 'ONE_YEAR', carrierType: 'PHYSICAL',
    bindingMode: 'OPTIONAL', createdById: ids.admin,
  } })
  await prisma.sweetCardAccount.create({ data: {
    id: ids.account, publicCardNo: `A1A2-HTTP-${runId}`, batchId: ids.batch,
    initialAmountCents: 50000n, balanceCents: 50000n, validityType: 'ONE_YEAR',
    status: 'CREATED', carrierType: 'PHYSICAL', bindingMode: 'OPTIONAL',
  } })

  const session = await createCustomerSession({
    userId: ids.customer,
    markerKey: process.env.JWT_SECRET,
  })
  const claim = await issueSweetCardClaimCredential({ accountId: ids.account, createdById: ids.admin })

  const first = await resolve({ session: session.rawToken, token: claim.rawToken, proof: claim.rawProof })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.claimable, true)
  assert.deepEqual(Object.keys(first.body).sort(), [
    'bindingMode', 'carrierType', 'claimable', 'faceValueCents', 'maskedCardNo', 'ok', 'validity',
  ])
  assert.doesNotMatch(JSON.stringify(first.body), /redeem|credential|userId|openid|ledger|token|proof/i)

  const repeat = await resolve({ session: session.rawToken, token: claim.rawToken, proof: claim.rawProof })
  assert.equal(repeat.status, 200)
  assert.deepEqual(repeat.body, first.body)

  const invalid = await resolve({ session: session.rawToken, token: 'invalid', proof: 'invalid' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error, 'CLAIM_CREDENTIAL_INVALID')

  const badSession = await resolve({
    session: `budu:customer-session:v1:${'a'.repeat(43)}`,
    token: claim.rawToken,
    proof: claim.rawProof,
  })
  assert.equal(badSession.status, 401)
  assert.equal(badSession.body.error, 'CUSTOMER_SESSION_DENIED')

  await prisma.sweetCardClaimToken.update({ where: { id: claim.id }, data: { revokedAt: new Date() } })
  const revoked = await resolve({ session: session.rawToken, token: claim.rawToken, proof: claim.rawProof })
  assert.equal(revoked.status, 404)
  assert.equal(revoked.body.error, 'CLAIM_CREDENTIAL_DENIED')

  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: ids.account } }), 0)
  assert.equal(await prisma.sweetCardLedger.count({ where: { accountId: ids.account } }), 0)
} finally {
  await prisma.sweetCardClaimToken.deleteMany({ where: { accountId: ids.account } })
  await prisma.customerSession.deleteMany({ where: { userId: ids.customer } })
  await prisma.sweetCardBinding.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardAccount.deleteMany({ where: { id: ids.account } })
  await prisma.sweetCardBatch.deleteMany({ where: { id: ids.batch } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.customer, ids.admin] } } })
  const after = await snapshot()
  assert.deepEqual(after, before)
  await prisma.$disconnect()
}

console.log(JSON.stringify({
  result: 'SWEET_CARD_A2_HTTP_PASS',
  database: 'budu_sc11a_test',
  authenticatedResolve: true,
  repeatedResolve: true,
  invalidCredentialDenied: true,
  invalidSessionDenied: true,
  revokedCredentialDenied: true,
  safeDtoOnly: true,
  claimOrBindingCreated: false,
  posCredentialUnchanged: true,
  economicSnapshotUnchanged: true,
}))
