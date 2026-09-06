import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import {
  authenticateCustomerSession,
  createCustomerSession,
  customerAuthInternals,
  resolveOrCreateCustomerIdentity,
} from '../server/customer-auth.js'
import {
  CLAIM_PROOF_PREFIX,
  CLAIM_TOKEN_PREFIX,
  issueSweetCardClaimCredential,
  resolveSweetCardClaimCredential,
} from '../server/sweet-card-claim.js'

const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const appId = 'wxfce0a3c4bb430023'
const markerKey = 'a1-a2-test-marker-key-only'
const ids = {
  admin: `a1a2-admin-${runId}`,
  batch: `a1a2-batch-${runId}`,
  accountA: `a1a2-account-a-${runId}`,
  accountB: `a1a2-account-b-${runId}`,
}

async function economicSnapshot(db = prisma) {
  const [rows] = await db.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM sweet_card_accounts) AS accounts,
      (SELECT COUNT(*)::int FROM sweet_card_ledger) AS ledger_rows,
      (SELECT COALESCE(SUM(amount_cents),0)::text FROM sweet_card_ledger) AS ledger_cents,
      (SELECT COUNT(*)::int FROM sweet_card_redemptions) AS redemptions,
      (SELECT COUNT(*)::int FROM sweet_card_refunds) AS refunds,
      (SELECT COUNT(*)::int FROM sweet_card_bindings) AS bindings
  `
  return rows
}

const before = await economicSnapshot()
const createdUsers = new Set()
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, 'budu_sc11a_test')

  const sameOpenId = `a1-concurrent-${runId}`
  const concurrent = await Promise.all([
    resolveOrCreateCustomerIdentity({ appId, openId: sameOpenId }),
    resolveOrCreateCustomerIdentity({ appId, openId: sameOpenId }),
  ])
  assert.equal(concurrent[0].userId, concurrent[1].userId)
  createdUsers.add(concurrent[0].userId)
  const repeated = []
  for (let index = 0; index < 10; index += 1) {
    repeated.push(await resolveOrCreateCustomerIdentity({ appId, openId: sameOpenId }))
  }
  assert.deepEqual(new Set(repeated.map(item => item.userId)), new Set([concurrent[0].userId]))
  const other = await resolveOrCreateCustomerIdentity({ appId, openId: `a1-other-${runId}` })
  createdUsers.add(other.userId)
  assert.notEqual(other.userId, concurrent[0].userId)
  assert.equal(await prisma.weChatAuthIdentity.count({ where: { appId, openId: sameOpenId } }), 1)

  const issuedSession = await createCustomerSession({ userId: concurrent[0].userId, markerKey })
  assert.match(issuedSession.rawToken, customerAuthInternals.SESSION_PATTERN)
  const verifiedSession = await authenticateCustomerSession({ rawToken: issuedSession.rawToken, markerKey })
  assert.equal(verifiedSession.userId, concurrent[0].userId)
  await assert.rejects(authenticateCustomerSession({ rawToken: `${issuedSession.rawToken}x`, markerKey }), /CUSTOMER_SESSION_DENIED/)
  const tamperedSession = `${issuedSession.rawToken.slice(0, -1)}${issuedSession.rawToken.endsWith('a') ? 'b' : 'a'}`
  await assert.rejects(authenticateCustomerSession({ rawToken: tamperedSession, markerKey }), /CUSTOMER_SESSION_DENIED/)
  const customer = await prisma.user.findUniqueOrThrow({ where: { id: concurrent[0].userId } })
  assert.equal(customer.role, 'customer')
  assert.equal(customer.employeeId, '')
  assert.deepEqual(customer.storeKeys, [])
  assert.deepEqual(customer.permissions, {})

  const a2 = await prisma.$transaction(async tx => {
    await tx.user.create({ data: {
      id: ids.admin, username: `a1a2_admin_${runId}`, passwordHash: 'test-only:unusable', role: 'developer',
      displayName: 'A1A2 Test', storeKeys: [], permissions: {},
    } })
    await tx.sweetCardBatch.create({ data: {
      id: ids.batch, name: 'A1A2 isolated fixture', purpose: 'TEST_ONLY', businessPurpose: 'ACCEPTANCE_TEST',
      faceValueCents: 50000n, cardCount: 2, totalInitialAmountCents: 100000n,
      validityType: 'ONE_YEAR', carrierType: 'PHYSICAL', bindingMode: 'OPTIONAL', createdById: ids.admin,
    } })
    for (const [id, suffix] of [[ids.accountA, '1001'], [ids.accountB, '1002']]) {
      await tx.sweetCardAccount.create({ data: {
        id, publicCardNo: `A1A2-${runId}-${suffix}`, batchId: ids.batch,
        initialAmountCents: 50000n, balanceCents: 50000n, validityType: 'ONE_YEAR',
        status: 'CREATED', carrierType: 'PHYSICAL', bindingMode: 'OPTIONAL',
      } })
    }
    const first = await issueSweetCardClaimCredential({ accountId: ids.accountA, createdById: ids.admin, db: tx })
    const second = await issueSweetCardClaimCredential({ accountId: ids.accountB, createdById: ids.admin, db: tx })
    assert.notEqual(first.rawToken, second.rawToken)
    assert.match(first.rawToken, new RegExp(`^${CLAIM_TOKEN_PREFIX}`))
    assert.match(first.rawProof, new RegExp(`^${CLAIM_PROOF_PREFIX}`))
    const dto = await resolveSweetCardClaimCredential({ rawToken: first.rawToken, rawProof: first.rawProof, db: tx })
    assert.equal(dto.claimable, true)
    assert.equal((await resolveSweetCardClaimCredential({ rawToken: first.rawToken, rawProof: first.rawProof, db: tx })).claimable, true)
    assert.doesNotMatch(JSON.stringify(dto), /redeem|credential|userId|openid|ledger|token|proof/i)
    await assert.rejects(resolveSweetCardClaimCredential({ rawToken: 'bad', rawProof: 'bad', db: tx }), /CLAIM_CREDENTIAL_INVALID/)
    await assert.rejects(resolveSweetCardClaimCredential({
      rawToken: `${CLAIM_TOKEN_PREFIX}${'a'.repeat(43)}`, rawProof: `${CLAIM_PROOF_PREFIX}${'b'.repeat(22)}`, db: tx,
    }), /CLAIM_CREDENTIAL_DENIED/)
    await tx.sweetCardClaimToken.update({ where: { id: first.id }, data: { revokedAt: new Date() } })
    await assert.rejects(resolveSweetCardClaimCredential({ rawToken: first.rawToken, rawProof: first.rawProof, db: tx }), /CLAIM_CREDENTIAL_DENIED/)
    await tx.sweetCardClaimToken.update({ where: { id: second.id }, data: { expiresAt: new Date(0) } })
    await assert.rejects(resolveSweetCardClaimCredential({ rawToken: second.rawToken, rawProof: second.rawProof, db: tx }), /CLAIM_CREDENTIAL_DENIED/)
    const stored = await tx.sweetCardClaimToken.findMany({ where: { accountId: { in: [ids.accountA, ids.accountB] } } })
    assert.equal(stored.some(row => row.tokenHash === first.rawToken || row.proofHash === first.rawProof), false)
    assert.equal(await tx.sweetCardBinding.count({ where: { accountId: { in: [ids.accountA, ids.accountB] } } }), 0)
    assert.equal(await tx.sweetCardLedger.count({ where: { accountId: { in: [ids.accountA, ids.accountB] } } }), 0)
    await tx.sweetCardClaimToken.deleteMany({ where: { accountId: { in: [ids.accountA, ids.accountB] } } })
    await tx.sweetCardAuditLog.deleteMany({ where: { accountId: { in: [ids.accountA, ids.accountB] } } })
    await tx.sweetCardAccount.deleteMany({ where: { id: { in: [ids.accountA, ids.accountB] } } })
    await tx.sweetCardBatch.delete({ where: { id: ids.batch } })
    await tx.user.delete({ where: { id: ids.admin } })
    return { tokens: stored.length, dto }
  })
  assert.equal(a2.tokens, 2)
  assert.equal(a2.dto.claimable, true)
} finally {
  await prisma.customerSession.deleteMany({ where: { userId: { in: [...createdUsers] } } })
  await prisma.weChatAuthIdentity.deleteMany({ where: { userId: { in: [...createdUsers] } } })
  await prisma.user.deleteMany({ where: { id: { in: [...createdUsers] } } })
  const after = await economicSnapshot()
  assert.deepEqual(after, before)
  await prisma.$disconnect()
}

console.log(JSON.stringify({
  result: 'SWEET_CARD_A1_A2_INTEGRATION_PASS',
  database: 'budu_sc11a_test',
  sameIdentityStable: true,
  concurrentIdentityRows: 1,
  differentSyntheticIdentityDifferentUser: true,
  claimCredentialSeparated: true,
  claimOrBindingCreated: false,
  economicSnapshotUnchanged: true,
}))
