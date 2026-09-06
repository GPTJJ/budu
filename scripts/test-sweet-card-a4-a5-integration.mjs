import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import {
  claimSweetCard,
  getCustomerSweetCard,
  issueSweetCardClaimCredential,
  listCustomerSweetCards,
  listCustomerSweetCardStores,
  resolveSweetCardClaimExperience,
} from '../server/sweet-card-claim.js'

const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const ids = {
  admin: `a45-admin-${run}`,
  userA: `a45-user-a-${run}`,
  userB: `a45-user-b-${run}`,
  batch: `a45-batch-${run}`,
  store: `a45-store-${run}`,
}
const accountIds = []

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

async function makeCard(label, bindingMode, status = 'CREATED') {
  const id = `a45-${label}-${run}`
  accountIds.push(id)
  await prisma.sweetCardAccount.create({ data: {
    id,
    publicCardNo: `A45-${label}-${run}`.toUpperCase(),
    batchId: ids.batch,
    initialAmountCents: 1000n,
    balanceCents: 1000n,
    validityType: 'LONG_TERM',
    status,
    carrierType: 'ELECTRONIC',
    bindingMode,
    recipientLabel: '一位很重要的朋友',
    recipientNote: '愿每一个平常日子里，都有一点刚刚好的甜。',
  } })
  const credential = await issueSweetCardClaimCredential({ accountId: id, createdById: ids.admin })
  return { id, ...credential }
}

const before = await snapshot()
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, 'budu_sc11a_test')
  await prisma.user.createMany({ data: [
    { id: ids.admin, username: `a45_admin_${run}`, passwordHash: 'test-only', role: 'developer', storeKeys: [], permissions: {} },
    { id: ids.userA, username: `a45_user_a_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
    { id: ids.userB, username: `a45_user_b_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
  ] })
  await prisma.sweetCardBatch.create({ data: {
    id: ids.batch, name: 'A4 A5 isolated acceptance fixture', purpose: 'TEST_ONLY',
    businessPurpose: 'ACCEPTANCE_TEST', faceValueCents: 1000n, cardCount: 8,
    totalInitialAmountCents: 8000n, validityType: 'LONG_TERM',
    carrierType: 'ELECTRONIC', bindingMode: 'OPTIONAL', createdById: ids.admin,
  } })

  const optional = await makeCard('optional', 'OPTIONAL')
  const preview = await resolveSweetCardClaimExperience({ rawToken: optional.rawToken, rawProof: optional.rawProof })
  assert.equal(preview.state, 'AVAILABLE')
  assert.equal(preview.claimable, true)
  assert.equal(preview.bindingMode, 'OPTIONAL')
  assert.doesNotMatch(JSON.stringify(preview), /userId|openid|session_key|ledger|token|proof|credential/i)

  const optionalClaim = await claimSweetCard({
    userId: ids.userA, rawToken: optional.rawToken, rawProof: optional.rawProof,
    requestKey: `a45_optional_${run}_request`, bindIntent: false,
  })
  assert.equal(optionalClaim.bindingStatus, 'UNBOUND')
  assert.equal((await resolveSweetCardClaimExperience({ rawToken: optional.rawToken, rawProof: optional.rawProof, userId: ids.userA })).state, 'ALREADY_CLAIMED_BY_SELF')
  assert.equal((await resolveSweetCardClaimExperience({ rawToken: optional.rawToken, rawProof: optional.rawProof, userId: ids.userB })).state, 'ALREADY_CLAIMED')

  const required = await makeCard('required', 'REQUIRED')
  const requiredClaim = await claimSweetCard({
    userId: ids.userA, rawToken: required.rawToken, rawProof: required.rawProof,
    requestKey: `a45_required_${run}_request`, bindIntent: true,
  })
  assert.equal(requiredClaim.bindingStatus, 'BOUND')

  const none = await makeCard('none', 'NONE')
  const noneClaim = await claimSweetCard({
    userId: ids.userB, rawToken: none.rawToken, rawProof: none.rawProof,
    requestKey: `a45_none_${run}_request`, bindIntent: false,
  })
  assert.equal(noneClaim.bindingStatus, 'UNBOUND')

  const revoked = await makeCard('revoked', 'OPTIONAL')
  await prisma.sweetCardClaimToken.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } })
  await assert.rejects(
    resolveSweetCardClaimExperience({ rawToken: revoked.rawToken, rawProof: revoked.rawProof }),
    error => error.message === 'CLAIM_CREDENTIAL_REVOKED'
  )
  const lost = await makeCard('lost', 'OPTIONAL', 'LOST')
  await assert.rejects(
    resolveSweetCardClaimExperience({ rawToken: lost.rawToken, rawProof: lost.rawProof }),
    error => error.message === 'CARD_LOST'
  )
  await assert.rejects(
    resolveSweetCardClaimExperience({ rawToken: 'invalid', rawProof: 'invalid' }),
    error => error.message === 'CLAIM_CREDENTIAL_INVALID'
  )

  const cardsA = await listCustomerSweetCards({ userId: ids.userA })
  assert.deepEqual(new Set(cardsA.map(card => card.walletRef)), new Set([optionalClaim.walletRef, requiredClaim.walletRef]))
  assert.equal(cardsA.some(card => card.walletRef === noneClaim.walletRef), false)
  assert.equal(cardsA.find(card => card.walletRef === requiredClaim.walletRef).bindingStatus, 'BOUND')
  await assert.rejects(
    getCustomerSweetCard({ userId: ids.userB, walletRef: optionalClaim.walletRef }),
    error => error.message === 'SWEET_CARD_NOT_FOUND'
  )

  await prisma.store.create({ data: { key: ids.store, name: `A4 A5 Test Store ${run}`, active: true, operationType: 'DIRECT' } })
  await prisma.sweetCardStorePolicy.create({ data: { storeId: ids.store, eligible: true } })
  assert.equal((await listCustomerSweetCardStores()).some(store => store.storeRef === ids.store), true)
  await prisma.sweetCardStorePolicy.update({ where: { storeId: ids.store }, data: { eligible: false } })
  assert.equal((await listCustomerSweetCardStores()).some(store => store.storeRef === ids.store), false)
  await prisma.sweetCardStorePolicy.update({ where: { storeId: ids.store }, data: { eligible: true } })

  await prisma.sweetCardLedger.create({ data: {
    id: `a45-ledger-issue-${run}`, accountId: optional.id, type: 'ISSUE', amountCents: 1000n,
    balanceAfterCents: 1000n, requestKey: `a45-ledger-issue-${run}`,
  } })
  const beforeBalance = await getCustomerSweetCard({ userId: ids.userA, walletRef: optionalClaim.walletRef })
  assert.equal(beforeBalance.balanceCents, '1000')
  await prisma.$transaction(async tx => {
    await tx.sweetCardAccount.update({ where: { id: optional.id }, data: { balanceCents: 875n } })
    await tx.sweetCardLedger.create({ data: {
      id: `a45-ledger-redeem-${run}`, accountId: optional.id, type: 'REDEEM', amountCents: -125n,
      balanceAfterCents: 875n, requestKey: `a45-ledger-redeem-${run}`, metadata: { storeId: ids.store },
    } })
  })
  const refreshed = await getCustomerSweetCard({ userId: ids.userA, walletRef: optionalClaim.walletRef })
  assert.equal(refreshed.balanceCents, '875')
  assert.equal(refreshed.history[0].amountCents, '-125')
  assert.equal(refreshed.history[0].storeName, `A4 A5 Test Store ${run}`)
  assert.doesNotMatch(JSON.stringify(refreshed), /ledgerId|requestKey|userId|openid|session_key/i)

  console.log(JSON.stringify({
    status: 'SWEET_CARD_A4_A5_INTEGRATION_PASS', database: database.name,
    claimExperience: 'PASS', bindingModesUxContract: 'PASS', ownCardAuthorization: 'PASS',
    balanceAuthorityRefresh: 'PASS', storeAvailabilityDynamic: 'PASS', historySafe: 'PASS',
    economicMutation: 'ISOLATED_TEST_FIXTURE_ONLY', productionWrite: 'NO',
  }))
} finally {
  await prisma.sweetCardAuditLog.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardLedger.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardBinding.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardClaim.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardClaimToken.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.sweetCardBatch.deleteMany({ where: { id: ids.batch } })
  await prisma.sweetCardStorePolicy.deleteMany({ where: { storeId: ids.store } })
  await prisma.store.deleteMany({ where: { key: ids.store } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB, ids.admin] } } })
  assert.deepEqual(await snapshot(), before)
  await prisma.$disconnect()
}
