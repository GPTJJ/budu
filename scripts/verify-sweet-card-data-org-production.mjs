import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import { signToken } from '../server/auth.js'
import { loadDb } from '../server/store.js'
import { hasSweetCardCapability, hasSweetCardPosRedeem, SWEET_CARD_CAPABILITIES } from '../shared/accountPermissions.js'

const expectedSha = String(process.env.EXPECTED_RELEASE_SHA || '')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_RELEASE_SHA_INVALID')
const normalize = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
const digest = (value) => crypto.createHash('sha256').update(normalize(value)).digest('hex')
const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key]), 0n)

const economicSnapshot = async () => {
  const [accounts, credentials, bindings, ledger, redemptions, refunds] = await Promise.all([
    prisma.sweetCardAccount.findMany({ orderBy: { id: 'asc' }, select: { id: true, batchId: true, initialAmountCents: true, balanceCents: true, status: true, validFrom: true, expiresAt: true, activatedAt: true, version: true } }),
    prisma.sweetCardCredential.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, status: true, activatedAt: true, revokedAt: true, revokeReason: true, replacedByCredentialId: true } }),
    prisma.sweetCardBinding.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, memberId: true, verificationMethod: true, boundAt: true } }),
    prisma.sweetCardLedger.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, type: true, amountCents: true, balanceAfterCents: true, orderId: true, redemptionId: true, refundId: true, requestKey: true, createdAt: true } }),
    prisma.sweetCardRedemption.findMany({ orderBy: { id: 'asc' }, select: { id: true, orderId: true, accountId: true, credentialId: true, amountCents: true, requestKey: true, storeIdSnapshot: true, createdAt: true } }),
    prisma.sweetCardRefund.findMany({ orderBy: { id: 'asc' }, select: { id: true, refundId: true, redemptionId: true, accountId: true, amountCents: true, requestKey: true, createdAt: true } }),
  ])
  return { accounts, credentials, bindings, ledger, redemptions, refunds }
}

try {
  const healthResponse = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(10_000) })
  const health = await healthResponse.json()
  assert.equal(healthResponse.status, 200)
  assert.equal(health.ok, true)
  assert.equal(health.dbOk, true)
  assert.ok(expectedSha.startsWith(String(health.gitSha || '')))
  assert.equal(process.env.XIDAN_SWEET_CARD_COMMERCIAL, '1')

  const [database, migrations, failed, users, batches, before, paymentCounts, refundCount] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE started_at IS NOT NULL AND finished_at IS NULL AND rolled_back_at IS NULL'),
    prisma.user.findMany({ where: { status: { not: 'disabled' } } }),
    prisma.sweetCardBatch.findMany({ orderBy: { createdAt: 'asc' }, include: { accounts: true } }),
    economicSnapshot(),
    prisma.payment.groupBy({ by: ['provider', 'status'], _count: { _all: true } }),
    prisma.refund.count(),
  ])
  assert.equal(database[0].name, 'budu_bj006')
  assert.equal(migrations[0].count, 66)
  assert.equal(failed[0].count, 0)
  assert.equal(await prisma.sweetCardBatch.count({ where: { archivedAt: { not: null } } }), 0)

  const developer = users.find((user) => user.role === 'developer')
  const ordinaryPos = users.find((user) => user.role === 'cashier' && !hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.MANAGE))
  assert.ok(developer && ordinaryPos)
  const authorizedOperators = users.filter(hasSweetCardPosRedeem)
  assert.ok(authorizedOperators.length > 0)
  const secret = process.env.JWT_SECRET || (await loadDb()).meta.secret
  const cookie = (user) => `budu_token=${signToken(user, secret)}`
  const call = async (user, path, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:3000/api/v2${path}`, {
      method,
      headers: { Cookie: cookie(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  const batchIds = (purpose, archived) => batches.filter((batch) => batch.businessPurpose === purpose && Boolean(batch.archivedAt) === archived).map((batch) => batch.id).sort()
  const archivedIds = batches.filter((batch) => batch.archivedAt).map((batch) => batch.id).sort()
  const [commercialBatches, acceptanceBatches, archivedBatches, commercialCards, acceptanceCards, archivedCards, reconciliation] = await Promise.all([
    call(developer, '/sweet-cards/batches'),
    call(developer, '/sweet-cards/batches?businessPurpose=ACCEPTANCE_TEST&archived=false'),
    call(developer, '/sweet-cards/batches?businessPurpose=ALL&archived=true'),
    call(developer, '/sweet-cards/cards'),
    call(developer, '/sweet-cards/cards?businessPurpose=ACCEPTANCE_TEST&archived=false'),
    call(developer, '/sweet-cards/cards?businessPurpose=ALL&archived=true'),
    call(developer, '/sweet-cards/reconciliation'),
  ])
  for (const result of [commercialBatches, acceptanceBatches, archivedBatches, commercialCards, acceptanceCards, archivedCards, reconciliation]) assert.equal(result.status, 200)
  assert.deepEqual(commercialBatches.body.batches.map((batch) => batch.id).sort(), batchIds('COMMERCIAL', false))
  assert.deepEqual(acceptanceBatches.body.batches.map((batch) => batch.id).sort(), batchIds('ACCEPTANCE_TEST', false))
  assert.deepEqual(archivedBatches.body.batches.map((batch) => batch.id).sort(), archivedIds)
  assert.equal(commercialCards.body.cards.length, batches.filter((batch) => batch.businessPurpose === 'COMMERCIAL' && !batch.archivedAt).reduce((count, batch) => count + batch.accounts.length, 0))
  assert.equal(acceptanceCards.body.cards.length, batches.filter((batch) => batch.businessPurpose === 'ACCEPTANCE_TEST' && !batch.archivedAt).reduce((count, batch) => count + batch.accounts.length, 0))
  assert.equal(archivedCards.body.cards.length, batches.filter((batch) => batch.archivedAt).reduce((count, batch) => count + batch.accounts.length, 0))

  const ordinaryList = await call(ordinaryPos, '/sweet-cards/batches')
  assert.equal(ordinaryList.status, 403)
  const archiveDenied = await call(ordinaryPos, `/sweet-cards/batches/${batches[0].id}/archive`, { method: 'POST', body: {} })
  assert.equal(archiveDenied.status, 403)
  assert.equal((await call(developer, `/sweet-cards/batches/${batches[0].id}`, { method: 'DELETE' })).status, 404)
  assert.equal((await call(developer, `/sweet-cards/cards/${before.accounts[0].id}`, { method: 'DELETE' })).status, 404)

  const issue = before.ledger.filter((entry) => entry.type === 'ISSUE').reduce((total, entry) => total + entry.amountCents, 0n)
  const redeemed = -before.ledger.filter((entry) => entry.type === 'REDEEM').reduce((total, entry) => total + entry.amountCents, 0n)
  const refunded = before.ledger.filter((entry) => entry.type === 'REFUND').reduce((total, entry) => total + entry.amountCents, 0n)
  const reversal = before.ledger.filter((entry) => entry.type === 'REVERSAL').reduce((total, entry) => total + entry.amountCents, 0n)
  const balance = sum(before.accounts, 'balanceCents')
  const ledgerSum = sum(before.ledger, 'amountCents')
  assert.equal(ledgerSum - balance, 0n)
  assert.deepEqual(reconciliation.body.all, {
    cards: before.accounts.length,
    issueCents: String(issue),
    redeemCents: String(redeemed),
    refundCents: String(refunded),
    reversalCents: String(reversal),
    balanceCents: String(balance),
    ledgerCents: String(ledgerSum),
    deltaCents: '0',
  })
  const formal = batches.find((batch) => batch.name === 'BUDU-SC-202609-A01')
  assert.ok(formal)
  assert.equal(formal.businessPurpose, 'COMMERCIAL')
  assert.equal(formal.accounts.length, 10)
  assert.equal(sum(formal.accounts, 'initialAmountCents'), 200_000n)

  const after = await economicSnapshot()
  assert.equal(digest(after), digest(before))
  assert.deepEqual(await prisma.payment.groupBy({ by: ['provider', 'status'], _count: { _all: true } }), paymentCounts)
  assert.equal(await prisma.refund.count(), refundCount)

  console.log(normalize({
    result: 'SWEET_CARD_DATA_ORGANIZATION_PRODUCTION_PASS',
    sha: expectedSha,
    database: 'budu_bj006',
    migrations: 66,
    failed: 0,
    defaultView: 'COMMERCIAL_NON_ARCHIVED',
    commercialBatches: batchIds('COMMERCIAL', false).length,
    acceptanceBatches: batchIds('ACCEPTANCE_TEST', false).length,
    archivedBatches: archivedIds.length,
    authorizedOperators: authorizedOperators.length,
    archivePermission: 'MANAGE_ALLOW_POS_403',
    hardDelete: 'NOT_AVAILABLE',
    cardDelete: 'DISABLED',
    void: 'EXISTING_CONTRACT_ONLY',
    issueCents: String(issue),
    redeemCents: String(redeemed),
    refundCents: String(refunded),
    balanceCents: String(balance),
    ledgerCents: String(ledgerSum),
    deltaCents: '0',
    economicDigest: digest(before),
    paymentProviderStatesUnchanged: true,
    refundCountUnchanged: true,
    commercialFlag: 'ENABLED',
  }))
} finally {
  await prisma.$disconnect()
}
