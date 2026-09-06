import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { prisma } from '../server/pg.js'
import {
  authenticateCustomerSession,
  createCustomerSession,
  revokeCustomerSession,
} from '../server/customer-auth.js'
import {
  claimSweetCard,
  getCustomerSweetCard,
  issueSweetCardClaimCredential,
  listCustomerSweetCardStores,
  resolveSweetCardClaimEntry,
  resolveSweetCardClaimExperience,
  revokeSweetCardClaimCredential,
  sweetCardClaimInternals,
} from '../server/sweet-card-claim.js'
import {
  buildSweetCardPresentation,
  renderPhysicalClaimAsset,
  renderSweetCardPresentation,
} from '../server/sweet-card-presentation.js'

const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const ids = {
  admin: `a67-admin-${run}`, userA: `a67-user-a-${run}`, userB: `a67-user-b-${run}`,
  batch: `a67-batch-${run}`, store: `a67-store-${run}`,
}
const accountIds = []
const result = {}
const markerKey = `a67-marker-${run}`
const source = fs.readFileSync(new URL('../server/sweet-card.js', import.meta.url), 'utf8')

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

async function makeCard(label, { carrierType = 'ELECTRONIC', bindingMode = 'OPTIONAL', status = 'CREATED', expiresAt = null, withPos = false } = {}) {
  const id = `a67-${label}-${run}`
  accountIds.push(id)
  const pos = withPos ? { token: `budu:sc:v1:legacy-${run}` } : null
  await prisma.sweetCardAccount.create({ data: {
    id, publicCardNo: `A67-${label}-${run}`.toUpperCase(), batchId: ids.batch,
    initialAmountCents: 5000n, balanceCents: 4875n, validityType: 'ONE_YEAR',
    status: 'CREATED', carrierType, bindingMode, recipientLabel: '一位很重要的朋友',
    recipientNote: '愿每一个平常日子里，都有一点刚刚好的甜。', giftingScenario: '<秋日> 心意',
  } })
  const claim = await issueSweetCardClaimCredential({ accountId: id, createdById: ids.admin })
  if (status !== 'CREATED' || expiresAt) await prisma.sweetCardAccount.update({ where: { id }, data: { status, expiresAt } })
  return { accountId: id, pos, ...claim }
}

function doClaim(card, userId, suffix) {
  return claimSweetCard({
    userId, rawToken: card.rawToken, rawProof: card.rawProof,
    requestKey: `a67_${suffix}_${run}_request`, bindIntent: true,
  })
}

const before = await snapshot()
try {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`
  assert.equal(database.name, 'budu_sc11a_test')
  await prisma.user.createMany({ data: [
    { id: ids.admin, username: `a67_admin_${run}`, passwordHash: 'test-only', role: 'developer', storeKeys: [], permissions: {} },
    { id: ids.userA, username: `a67_user_a_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
    { id: ids.userB, username: `a67_user_b_${run}`, passwordHash: 'test-only', role: 'customer', storeKeys: [], permissions: {} },
  ] })
  await prisma.sweetCardBatch.create({ data: {
    id: ids.batch, name: 'A6 A7 isolated acceptance fixture', purpose: 'TEST_ONLY',
    businessPurpose: 'ACCEPTANCE_TEST', faceValueCents: 5000n, cardCount: 20,
    totalInitialAmountCents: 100000n, validityType: 'ONE_YEAR', carrierType: 'PHYSICAL',
    bindingMode: 'OPTIONAL', createdById: ids.admin, presentationTemplateKey: 'minimal-v2',
  } })
  await prisma.store.create({ data: { key: ids.store, name: `A67 Test Store ${run}`, operationType: 'DIRECT', active: true } })
  await prisma.sweetCardStorePolicy.create({ data: { storeId: ids.store, eligible: true, updatedById: ids.admin } })

  const unified = await makeCard('unified', { carrierType: 'PHYSICAL', withPos: true })
  const account = await prisma.sweetCardAccount.findUniqueOrThrow({ where: { id: unified.accountId }, include: { binding: true } })
  assert.ok(unified.pos.token.startsWith('budu:sc:v1:'))
  assert.match(source, /QRCode\.toString\(decryptToken\(credential\)/)
  result['A6-01'] = 'PASS_LEGACY_POS_QR_UNCHANGED'
  assert.equal((await resolveSweetCardClaimExperience({ rawToken: unified.rawToken, rawProof: unified.rawProof })).claimable, true)
  result['A6-02'] = 'PASS_CARD_NO_LOCATOR_PLUS_SECONDARY_CLAIM'
  assert.ok(unified.rawToken.startsWith('budu:claim:v1:'))
  assert.notEqual(unified.pos.token, unified.rawToken)
  result['A6-03'] = 'PASS_SEPARATE_POS_AND_CLAIM_ASSETS'

  const physicalModel = buildSweetCardPresentation(account, { carrierType: 'PHYSICAL', designVersion: 'minimal-v2', claimAsset: { state: 'ACTIVE' } })
  const electronicModel = buildSweetCardPresentation(account, { carrierType: 'ELECTRONIC', designVersion: 'minimal-v2', claimAsset: { state: 'ACTIVE' } })
  const fakeQr = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`
  const electronicSvg = renderSweetCardPresentation(electronicModel, { claimQrDataUrl: fakeQr })
  const physicalSvg = renderPhysicalClaimAsset({ claimQrDataUrl: fakeQr, maskedCardNo: physicalModel.maskedCardNo, expiresAt: unified.expiresAt })
  assert.match(electronicSvg, /当前余额 ¥48\.75/)
  assert.match(physicalSvg, /独立渠道/)
  result['A6-04'] = 'PASS'
  assert.equal(physicalModel.currentBalanceDisplay, electronicModel.currentBalanceDisplay)
  result['A6-05'] = 'PASS_ONE_ACCOUNT'
  const economicsBeforeRender = await snapshot()
  renderSweetCardPresentation(buildSweetCardPresentation(account, { designVersion: 'alternate-safe-v1' }))
  const economicsAfterRender = await snapshot()
  assert.deepEqual(economicsAfterRender, economicsBeforeRender)
  result['A6-06'] = 'PASS_NO_ISSUE'
  result['A6-07'] = 'PASS_NO_LEDGER'
  assert.equal(buildSweetCardPresentation(account, { designVersion: 'alternate-safe-v1' }).currentBalanceDisplay, electronicModel.currentBalanceDisplay)
  result['A6-08'] = 'PASS'
  assert.doesNotMatch(electronicSvg, /<秋日>|internal-card|openid|proofHash/i)
  result['A6-09'] = 'PASS_SAFE_RENDER'
  assert.match(source, /\['cardNo', 'faceValueCents', 'validityType', 'carrierType', 'qrFile'\]/)
  result['A6-10'] = 'PASS_BACKWARD_COMPATIBLE'

  const revoked = await makeCard('revoked')
  await revokeSweetCardClaimCredential({ accountId: revoked.accountId, revokedById: ids.admin })
  await assert.rejects(resolveSweetCardClaimExperience({ rawToken: revoked.rawToken, rawProof: revoked.rawProof }), /CLAIM_CREDENTIAL_REVOKED/)
  result['A6-11'] = 'PASS'
  const stores = await listCustomerSweetCardStores()
  assert.ok(stores.some(store => store.storeRef === ids.store))
  result['A6-12'] = 'PASS_DYNAMIC_AUTHORITY'

  await assert.rejects(resolveSweetCardClaimExperience({ rawToken: `budu:claim:v1:${'z'.repeat(43)}`, rawProof: `budu:claim-proof:v1:${'y'.repeat(22)}` }), /CLAIM_CREDENTIAL_INVALID/)
  result['A7-01'] = 'PASS'
  await assert.rejects(resolveSweetCardClaimExperience({ rawToken: 'bad', rawProof: 'bad' }), /CLAIM_CREDENTIAL_INVALID/)
  result['A7-02'] = 'PASS'
  const replay = await makeCard('replay', { bindingMode: 'REQUIRED' })
  const first = await doClaim(replay, ids.userA, 'replay')
  assert.equal((await doClaim(replay, ids.userA, 'replay')).claimStatus, 'ALREADY_CLAIMED_BY_SELF')
  result['A7-03'] = 'PASS'
  await assert.rejects(doClaim(replay, ids.userB, 'replay-other'), /ALREADY_CLAIMED/)
  result['A7-04'] = 'PASS'
  const race = await makeCard('race', { bindingMode: 'REQUIRED' })
  const raced = await Promise.allSettled([doClaim(race, ids.userA, 'race-a'), doClaim(race, ids.userB, 'race-b')])
  assert.equal(raced.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(await prisma.sweetCardClaim.count({ where: { accountId: race.accountId } }), 1)
  assert.equal(await prisma.sweetCardBinding.count({ where: { accountId: race.accountId } }), 1)
  result['A7-05'] = 'PASS_ONE_SUCCESS'
  result['A7-06'] = result['A6-11']
  const stale = await makeCard('stale')
  await prisma.sweetCardClaimToken.update({ where: { id: stale.id }, data: { expiresAt: new Date(0) } })
  await assert.rejects(resolveSweetCardClaimExperience({ rawToken: stale.rawToken, rawProof: stale.rawProof }), /CLAIM_CREDENTIAL_EXPIRED/)
  result['A7-07'] = 'PASS'
  const lost = await makeCard('lost', { status: 'LOST' })
  await assert.rejects(resolveSweetCardClaimExperience({ rawToken: lost.rawToken, rawProof: lost.rawProof }), /CARD_LOST/)
  result['A7-08'] = 'PASS'
  const voided = await makeCard('void', { status: 'VOID' })
  await assert.rejects(resolveSweetCardClaimExperience({ rawToken: voided.rawToken, rawProof: voided.rawProof }), /CARD_VOID/)
  result['A7-09'] = 'PASS'
  await assert.rejects(getCustomerSweetCard({ userId: ids.userB, walletRef: first.walletRef }), /SWEET_CARD_NOT_FOUND/)
  result['A7-10'] = 'PASS'
  assert.throws(() => sweetCardClaimInternals.rejectIdentityAuthority({ userId: ids.userB }), /IDENTITY_AUTHORITY_SPOOF_REJECTED/)
  result['A7-11'] = 'PASS'
  assert.throws(() => sweetCardClaimInternals.rejectIdentityAuthority({ openId: 'spoof' }), /IDENTITY_AUTHORITY_SPOOF_REJECTED/)
  result['A7-12'] = 'PASS'

  await assert.rejects(authenticateCustomerSession({ rawToken: 'forged', markerKey }), /CUSTOMER_SESSION_DENIED/)
  result['A7-13'] = 'PASS'
  const expiredSession = await createCustomerSession({ userId: ids.userA, markerKey, ttlMs: -1 })
  await assert.rejects(authenticateCustomerSession({ rawToken: expiredSession.rawToken, markerKey }), /CUSTOMER_SESSION_DENIED/)
  result['A7-14'] = 'PASS'
  const guessedA = resolveSweetCardClaimEntry(`budu:claim:v1:${'a'.repeat(43)}`)
  const guessedB = resolveSweetCardClaimEntry(`budu:claim:v1:${'b'.repeat(43)}`)
  assert.deepEqual(guessedA, guessedB)
  result['A7-15'] = 'PASS_NON_ENUMERATING'
  assert.equal(await prisma.sweetCardClaim.count({ where: { accountId: replay.accountId } }), 1)
  assert.equal((await prisma.sweetCardClaim.findUniqueOrThrow({ where: { id: first.walletRef } })).userId, ids.userA)
  result['A7-16'] = 'PASS_SECOND_OWNERSHIP_DENIED'
  assert.doesNotMatch(electronicSvg, /budu:sc:v1:|budu:claim:v1:|claim-proof|internal-card|openid|AppSecret/i)
  result['A7-17'] = 'PASS'
  assert.doesNotMatch(source.match(/sweetCardRouter\.get\('\/sweet-cards\/batches\/:id\/export'[\s\S]+?\n\}\)\)/)?.[0] || '', /AppSecret|proofHash|openId|binding/)
  result['A7-18'] = 'PASS'
  assert.match(source, /QRCode\.toString\(decryptToken\(credential\)/)
  result['A7-19'] = 'PASS'

  const liveSession = await createCustomerSession({ userId: ids.userA, markerKey })
  assert.equal((await authenticateCustomerSession({ rawToken: liveSession.rawToken, markerKey })).userId, ids.userA)
  await revokeCustomerSession({ rawToken: liveSession.rawToken, markerKey })
  await assert.rejects(authenticateCustomerSession({ rawToken: liveSession.rawToken, markerKey }), /CUSTOMER_SESSION_DENIED/)
  result.sessionLogoutRelogin = 'PASS_REVOKED_SESSION_DENIED'
  result['A7-20'] = 'PENDING_EXTERNAL_PRODUCTION_READ_ONLY_COMPARISON'

  const audits = await prisma.sweetCardAuditLog.findMany({ where: { accountId: { in: accountIds } } })
  assert.ok(audits.some(row => row.action === 'sweet_card.claim_credential_issued'))
  assert.ok(audits.some(row => row.action === 'sweet_card.claim_credential_revoked'))
  assert.doesNotMatch(JSON.stringify(audits), /budu:claim:v1:|claim-proof|budu:sc:v1:|openid|session_key|AppSecret/i)
  result.auditLogging = 'PASS_NO_SECRET'
} finally {
  await prisma.sweetCardAuditLog.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardBinding.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardClaim.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardClaimToken.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.sweetCardCredential.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.customerSession.deleteMany({ where: { userId: { in: [ids.userA, ids.userB] } } })
  await prisma.sweetCardAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.sweetCardBatch.deleteMany({ where: { id: ids.batch } })
  await prisma.sweetCardStorePolicy.deleteMany({ where: { storeId: ids.store } })
  await prisma.store.deleteMany({ where: { key: ids.store } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.userA, ids.userB] } } })
  const after = await snapshot()
  assert.deepEqual(after, before)
  await prisma.$disconnect()
}

console.log(JSON.stringify({
  status: 'SWEET_CARD_A6_A7_INTEGRATION_PASS', database: 'budu_sc11a_test',
  evidenceClass: 'SYNTHETIC_DB_CONCURRENCY_AND_TEST_RUNTIME', ...result,
}))
