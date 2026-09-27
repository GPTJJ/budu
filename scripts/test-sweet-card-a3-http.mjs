import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createCustomerSession } from '../server/customer-auth.js'
import { prisma } from '../server/pg.js'
import { issueSweetCardClaimCredential } from '../server/sweet-card-claim.js'

const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const ids = {
  admin: `a3-http-admin-${run}`, user: `a3-http-user-${run}`,
  batch: `a3-http-batch-${run}`, account: `a3-http-account-${run}`,
}
const endpoint = 'http://127.0.0.1:3000/api/customer/sweet-card'

async function snapshot() {
  const [row] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM sweet_card_accounts) accounts,
      (SELECT COALESCE(SUM(balance_cents),0)::text FROM sweet_card_accounts) balance_cents,
      (SELECT COUNT(*)::int FROM sweet_card_ledger) ledger_rows,
      (SELECT COALESCE(SUM(amount_cents),0)::text FROM sweet_card_ledger) ledger_cents,
      (SELECT COUNT(*)::int FROM sweet_card_redemptions) redemptions,
      (SELECT COUNT(*)::int FROM sweet_card_refunds) refunds,
      (SELECT COUNT(*)::int FROM payments) payments,
      (SELECT COUNT(*)::int FROM sweet_card_bindings) bindings,
      (SELECT COUNT(*)::int FROM sweet_card_claims) claims
  `
  return row
}

async function post(path, session, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', 'x-budu-test-gateway': '1' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const before = await snapshot()
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, 'budu_sc11a_test')
  assert.equal(process.env.APP_ENV, 'test')
  await prisma.user.createMany({ data: [
    { id: ids.admin, username: `a3_http_admin_${run}`, passwordHash: 'test-only', role: 'developer', storeKeys: [], permissions: {} },
    { id: ids.user, username: `a3_http_user_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
  ] })
  await prisma.sweetCardBatch.create({ data: {
    id: ids.batch, name: 'A3 HTTP acceptance fixture', purpose: 'TEST_ONLY', businessPurpose: 'ACCEPTANCE_TEST',
    faceValueCents: 100n, cardCount: 1, totalInitialAmountCents: 100n,
    validityType: 'LONG_TERM', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', createdById: ids.admin,
  } })
  await prisma.sweetCardAccount.create({ data: {
    id: ids.account, publicCardNo: `A3-HTTP-${run}`.toUpperCase(), batchId: ids.batch,
    initialAmountCents: 100n, balanceCents: 100n, validityType: 'LONG_TERM',
    status: 'CREATED', carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL',
  } })
  const session = await createCustomerSession({ userId: ids.user, markerKey: process.env.JWT_SECRET })
  const credential = await issueSweetCardClaimCredential({ accountId: ids.account, createdById: ids.admin })
  const body = {
    claimToken: credential.rawToken, claimProof: credential.rawProof,
    requestKey: `a3_http_${run}_request`, bindIntent: false,
  }
  const claimed = await post('/claim', session.rawToken, body)
  assert.equal(claimed.status, 201)
  assert.equal(claimed.body.claimStatus, 'CLAIMED')
  assert.equal(claimed.body.bindingStatus, 'UNBOUND')
  assert.deepEqual(Object.keys(claimed.body).sort(), [
    'balanceCents', 'bindingMode', 'bindingStatus', 'cardPresentationStatus', 'carrierType',
    'claimStatus', 'faceValueCents', 'maskedCardNo', 'ok', 'recipient', 'status',
    'validity', 'walletRef',
  ])
  assert.doesNotMatch(JSON.stringify(claimed.body), /userId|openid|session_key|ledger|token|proof|credential/i)
  const retry = await post('/claim', session.rawToken, body)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.claimStatus, 'ALREADY_CLAIMED_BY_SELF')
  const bound = await post(`/${claimed.body.walletRef}/bind`, session.rawToken, {})
  assert.equal(bound.status, 200)
  assert.equal(bound.body.bindingStatus, 'BOUND')
  const spoof = await post('/claim', session.rawToken, { ...body, userId: 'spoof' })
  assert.equal(spoof.status, 400)
  assert.equal(spoof.body.error, 'IDENTITY_AUTHORITY_SPOOF_REJECTED')
  assert.equal(await prisma.sweetCardLedger.count({ where: { accountId: ids.account } }), 0)
  assert.equal((await prisma.sweetCardAccount.findUniqueOrThrow({ where: { id: ids.account } })).status, 'CREATED')
  assert.equal((await prisma.sweetCardAccount.findUniqueOrThrow({ where: { id: ids.account } })).balanceCents, 100n)
  console.log(JSON.stringify({
    status: 'SWEET_CARD_A3_HTTP_PASS', safeDto: true, sessionAuthority: true,
    claimRetryIdempotent: true, optionalBind: true, spoofDenied: true, economicMutation: 'NONE',
  }))
} finally {
  await prisma.sweetCardAuditLog.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardBinding.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardClaim.deleteMany({ where: { accountId: ids.account } })
  await prisma.sweetCardClaimToken.deleteMany({ where: { accountId: ids.account } })
  await prisma.customerSession.deleteMany({ where: { userId: ids.user } })
  await prisma.sweetCardAccount.deleteMany({ where: { id: ids.account } })
  await prisma.sweetCardBatch.deleteMany({ where: { id: ids.batch } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.admin] } } })
  assert.deepEqual(await snapshot(), before)
  await prisma.$disconnect()
}
