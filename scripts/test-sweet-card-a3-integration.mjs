import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import {
  CLAIM_PROOF_PREFIX,
  CLAIM_TOKEN_PREFIX,
  bindClaimedSweetCard,
  claimSweetCard,
  issueSweetCardClaimCredential,
  sweetCardClaimInternals,
} from '../server/sweet-card-claim.js'

const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const ids = {
  admin: `a3-admin-${run}`, userA: `a3-user-a-${run}`, userB: `a3-user-b-${run}`,
  batch: `a3-batch-${run}`,
}
const accountIds = []
const result = {}

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

async function makeAccount(label, bindingMode, { status = 'CREATED', expiresAt = null } = {}) {
  const id = `a3-${label}-${run}`
  accountIds.push(id)
  await prisma.sweetCardAccount.create({ data: {
    id, publicCardNo: `A3-${label}-${run}`.toUpperCase(), batchId: ids.batch,
    initialAmountCents: 100n, balanceCents: 100n, validityType: 'LONG_TERM',
    expiresAt: null, status: 'CREATED', carrierType: 'ELECTRONIC', bindingMode,
  } })
  const credential = await issueSweetCardClaimCredential({ accountId: id, createdById: ids.admin })
  if (status !== 'CREATED' || expiresAt) await prisma.sweetCardAccount.update({ where: { id }, data: { status, expiresAt } })
  return { ...credential, accountId: id, bindingMode, status }
}

function claim(card, userId, suffix, extra = {}) {
  return claimSweetCard({
    userId, rawToken: card.rawToken, rawProof: card.rawProof,
    requestKey: `a3_${suffix}_${run}_request`, ...extra,
  })
}

const before = await snapshot()
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, 'budu_sc11a_test')
  await prisma.user.createMany({ data: [
    { id: ids.admin, username: `a3_admin_${run}`, passwordHash: 'test-only', role: 'developer', storeKeys: [], permissions: {} },
    { id: ids.userA, username: `a3_user_a_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
    { id: ids.userB, username: `a3_user_b_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
  ] })
  await prisma.sweetCardBatch.create({ data: {
    id: ids.batch, name: 'A3 isolated acceptance fixture', purpose: 'TEST_ONLY',
    businessPurpose: 'ACCEPTANCE_TEST', faceValueCents: 100n, cardCount: 20,
    totalInitialAmountCents: 2000n, validityType: 'LONG_TERM', carrierType: 'ELECTRONIC',
    bindingMode: 'OPTIONAL', createdById: ids.admin,
  } })

  const none = await makeAccount('none', 'NONE')
  const noneClaim = await claim(none, ids.userA, 'none')
  assert.equal(noneClaim.claimStatus, 'CLAIMED')
  assert.equal(noneClaim.bindingStatus, 'UNBOUND')
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: none.accountId } }), 0)
  result['A3-01'] = 'PASS'

  const optional = await makeAccount('optional', 'OPTIONAL')
  const optionalClaim = await claim(optional, ids.userA, 'optional')
  assert.equal(optionalClaim.bindingStatus, 'UNBOUND')
  result['A3-02'] = 'PASS'
  const optionalBound = await bindClaimedSweetCard({ userId: ids.userA, walletRef: optionalClaim.walletRef })
  assert.equal(optionalBound.bindingStatus, 'BOUND')
  assert.equal((await bindClaimedSweetCard({ userId: ids.userA, walletRef: optionalClaim.walletRef })).bindingStatus, 'BOUND')
  result['A3-03'] = 'PASS'

  const required = await makeAccount('required', 'REQUIRED')
  const requiredClaim = await claim(required, ids.userA, 'required')
  assert.equal(requiredClaim.bindingStatus, 'BOUND')
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: required.accountId } }), 1)
  result['A3-04'] = 'PASS'

  await assert.rejects(claimSweetCard({ userId: ids.userA, rawToken: 'bad', rawProof: 'bad', requestKey: `a3_invalid_${run}_request` }), /CLAIM_CREDENTIAL_INVALID/)
  await assert.rejects(claimSweetCard({ userId: ids.userA, rawToken: `${CLAIM_TOKEN_PREFIX}${'a'.repeat(43)}`, rawProof: `${CLAIM_PROOF_PREFIX}${'b'.repeat(22)}`, requestKey: `a3_unknown_${run}_request` }), /CLAIM_CREDENTIAL_DENIED/)
  result['A3-05'] = 'PASS'

  const revoked = await makeAccount('revoked', 'OPTIONAL')
  await prisma.sweetCardClaimToken.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } })
  await assert.rejects(claim(revoked, ids.userA, 'revoked'), /CLAIM_CREDENTIAL_DENIED/)
  result['A3-06'] = 'PASS'

  await assert.rejects(claim(required, ids.userB, 'other-replay'), /ALREADY_CLAIMED/)
  result['A3-07'] = 'PASS'
  const requiredRetry = await claim(required, ids.userA, 'required')
  assert.equal(requiredRetry.claimStatus, 'ALREADY_CLAIMED_BY_SELF')
  result['A3-08'] = 'PASS'

  const twoUser = await makeAccount('two-user', 'REQUIRED')
  const two = await Promise.allSettled([
    claim(twoUser, ids.userA, 'two-user-a'), claim(twoUser, ids.userB, 'two-user-b'),
  ])
  assert.equal(two.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(two.filter(item => item.status === 'rejected' && item.reason?.status === 409).length, 1)
  assert.equal(await prisma.sweetCardClaim.count({ where: { accountId: twoUser.accountId } }), 1)
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: twoUser.accountId } }), 1)
  result['A3-09'] = 'PASS_SYNTHETIC_IDENTITY_CONCURRENCY_TEST'

  const sameUser = await makeAccount('same-user', 'REQUIRED')
  const same = await Promise.allSettled([
    claim(sameUser, ids.userA, 'same-user'), claim(sameUser, ids.userA, 'same-user'),
  ])
  assert.equal(same.filter(item => item.status === 'fulfilled').length, 2)
  assert.equal(await prisma.sweetCardClaim.count({ where: { accountId: sameUser.accountId } }), 1)
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: sameUser.accountId } }), 1)
  result['A3-10'] = 'PASS'

  assert.throws(() => sweetCardClaimInternals.rejectIdentityAuthority({ userId: ids.userB }), /IDENTITY_AUTHORITY_SPOOF_REJECTED/)
  result['A3-11'] = 'PASS'
  assert.throws(() => sweetCardClaimInternals.rejectIdentityAuthority({ openId: 'spoof' }), /IDENTITY_AUTHORITY_SPOOF_REJECTED/)
  result['A3-12'] = 'PASS'

  const lost = await makeAccount('lost', 'OPTIONAL', { status: 'LOST' })
  await assert.rejects(claim(lost, ids.userA, 'lost'), /CLAIM_CREDENTIAL_DENIED/)
  result['A3-13'] = 'PASS'
  const voided = await makeAccount('void', 'OPTIONAL', { status: 'VOID' })
  await assert.rejects(claim(voided, ids.userA, 'void'), /CLAIM_CREDENTIAL_DENIED/)
  result['A3-14'] = 'PASS'
  const expired = await makeAccount('expired', 'OPTIONAL', { status: 'ACTIVE', expiresAt: new Date(Date.now() - 60000) })
  await assert.rejects(claim(expired, ids.userA, 'expired'), /CLAIM_CREDENTIAL_DENIED/)
  result['A3-15'] = 'PASS'

  assert.equal((await claim(required, ids.userA, 'required-same-bound')).claimStatus, 'ALREADY_CLAIMED_BY_SELF')
  result['A3-16'] = 'PASS'
  const otherBound = await makeAccount('other-bound', 'OPTIONAL')
  await prisma.sweetCardBinding.create({ data: {
    id: `scbind-${crypto.randomUUID()}`, accountId: otherBound.accountId, userId: ids.userB,
    memberId: null, channel: 'MINIPROGRAM', boundById: ids.userB,
  } })
  await assert.rejects(claim(otherBound, ids.userA, 'other-bound'), /ALREADY_BOUND/)
  result['A3-17'] = 'PASS'

  const rollbackClaim = await makeAccount('rollback-claim', 'REQUIRED')
  await assert.rejects(claim(rollbackClaim, ids.userA, 'rollback-claim', {
    faultInjector: stage => { if (stage === 'AFTER_CLAIM_WRITE') throw new Error('FORCED_AFTER_CLAIM') },
  }), /FORCED_AFTER_CLAIM/)
  assert.equal(await prisma.sweetCardClaim.count({ where: { accountId: rollbackClaim.accountId } }), 0)
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: rollbackClaim.accountId } }), 0)
  assert.equal((await prisma.sweetCardClaimToken.findUniqueOrThrow({ where: { id: rollbackClaim.id } })).consumedAt, null)
  result['A3-18'] = 'PASS'

  const rollbackBinding = await makeAccount('rollback-binding', 'REQUIRED')
  await assert.rejects(claim(rollbackBinding, ids.userA, 'rollback-binding', {
    faultInjector: stage => { if (stage === 'AFTER_BINDING_STAGE') throw new Error('FORCED_AFTER_BINDING') },
  }), /FORCED_AFTER_BINDING/)
  assert.equal(await prisma.sweetCardClaim.count({ where: { accountId: rollbackBinding.accountId } }), 0)
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: rollbackBinding.accountId } }), 0)
  assert.equal((await prisma.sweetCardClaimToken.findUniqueOrThrow({ where: { id: rollbackBinding.id } })).consumedAt, null)
  result['A3-19'] = 'PASS'

  assert.equal(await prisma.sweetCardLedger.count({ where: { accountId: { in: accountIds } } }), 0)
  assert.equal(await prisma.sweetCardRedemption.count({ where: { accountId: { in: accountIds } } }), 0)
  assert.equal(await prisma.sweetCardRefund.count({ where: { accountId: { in: accountIds } } }), 0)
  assert.equal((await prisma.sweetCardAccount.findUniqueOrThrow({ where: { id: none.accountId } })).status, 'CREATED')
  assert.equal((await prisma.sweetCardAccount.findUniqueOrThrow({ where: { id: none.accountId } })).balanceCents, 100n)

  const audits = await prisma.sweetCardAuditLog.findMany({ where: { accountId: { in: accountIds } } })
  assert.ok(audits.length >= 5)
  assert.ok(audits.every(row => row.actorId && row.metadata?.channel === 'MINIPROGRAM'))
  assert.doesNotMatch(JSON.stringify(audits), /budu:claim:|budu:sc:v1:|session_key|openid/i)
  result.audit = 'PASS'
  result.noEconomicMutation = 'PASS'
} finally {
  await prisma.sweetCardAuditLog.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardBinding.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardClaim.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardClaimToken.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.sweetCardBatch.deleteMany({ where: { id: ids.batch } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB, ids.admin] } } })
  const after = await snapshot()
  assert.deepEqual(after, before)
  await prisma.$disconnect()
}

result['A3-20'] = 'PENDING_PRODUCTION_READ_ONLY_VERIFICATION'
console.log(JSON.stringify({
  status: 'SWEET_CARD_A3_INTEGRATION_PASS',
  database: 'budu_sc11a_test',
  evidenceClass: 'SYNTHETIC_IDENTITY_CONCURRENCY_TEST',
  ...result,
}))
