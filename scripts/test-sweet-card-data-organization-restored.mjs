import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const databaseName = new URL(process.env.DATABASE_URL || '').pathname.slice(1)
if (databaseName !== 'budu_sc_data_org_isolated') throw new Error('RESTORED_ISOLATED_DATABASE_REQUIRED')
process.env.SWEET_CARD_ENABLED = '1'
process.env.XIDAN_SWEET_CARD_COMMERCIAL = '1'
process.env.SWEET_CARD_CREDENTIAL_KEY = process.env.SWEET_CARD_CREDENTIAL_KEY || '11'.repeat(32)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'isolated-sweet-card-data-organization-secret'

const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const { signToken } = await import('../server/auth.js')

const suffix = crypto.randomUUID()
const batchId = `data-org-batch-${suffix}`
const accountId = `data-org-account-${suffix}`
const credentialId = `data-org-credential-${suffix}`
const ledgerId = `data-org-ledger-${suffix}`
const server = createApp().listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const snapshot = async () => ({
  accounts: await prisma.sweetCardAccount.findMany({ orderBy: { id: 'asc' }, select: { id: true, batchId: true, initialAmountCents: true, balanceCents: true, status: true, version: true, activatedAt: true } }),
  credentials: await prisma.sweetCardCredential.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, status: true, revokedAt: true, revokeReason: true } }),
  bindings: await prisma.sweetCardBinding.findMany({ orderBy: { id: 'asc' } }),
  ledger: await prisma.sweetCardLedger.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, type: true, amountCents: true, balanceAfterCents: true, requestKey: true } }),
  redemptions: await prisma.sweetCardRedemption.findMany({ orderBy: { id: 'asc' } }),
  refunds: await prisma.sweetCardRefund.findMany({ orderBy: { id: 'asc' } }),
})

try {
  const users = await prisma.user.findMany({ where: { status: { not: 'disabled' } } })
  const developer = users.find((user) => user.role === 'developer')
  const cashier = users.find((user) => user.role === 'cashier')
  assert.ok(developer && cashier)
  const cookie = (user) => `budu_token=${signToken(user, process.env.JWT_SECRET)}`
  const request = async (user, path, { method = 'GET', body } = {}) => fetch(`${origin}/api/v2${path}`, {
    method,
    headers: { Cookie: cookie(user), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = async (user, path, options) => {
    const response = await request(user, path, options)
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  await prisma.sweetCardBatch.create({ data: {
    id: batchId,
    name: `Restored DB archive test ${suffix}`,
    purpose: 'isolated restored-database gate',
    businessPurpose: 'COMMERCIAL',
    faceValueCents: 1000n,
    cardCount: 1,
    totalInitialAmountCents: 1000n,
    validityType: 'LONG_TERM',
    carrierType: 'ELECTRONIC',
    bindingMode: 'NONE',
    createdById: 'isolated-gate',
    accounts: { create: {
      id: accountId,
      publicCardNo: `SC-RESTORED-${suffix}`,
      initialAmountCents: 1000n,
      balanceCents: 1000n,
      validityType: 'LONG_TERM',
      status: 'ACTIVE',
      carrierType: 'ELECTRONIC',
      bindingMode: 'NONE',
      credentials: { create: { id: credentialId, publicTokenId: `TOKEN-${suffix}`, tokenHash: `HASH-${suffix}`, tokenCiphertext: `CIPHER-${suffix}`, tokenIv: `IV-${suffix}`, tokenTag: `TAG-${suffix}`, status: 'ACTIVE', carrierType: 'ELECTRONIC' } },
      ledger: { create: { id: ledgerId, type: 'ISSUE', amountCents: 1000n, balanceAfterCents: 1000n, requestKey: `issue-${suffix}`, actorId: 'isolated-gate' } },
    } },
  } })

  const beforeArchive = await snapshot()
  const archive = await json(developer, `/sweet-cards/batches/${batchId}/archive`, { method: 'POST', body: { reason: 'restored isolated gate' } })
  assert.equal(archive.status, 200)
  assert.ok(archive.body.batch.archivedAt)
  assert.deepEqual(await snapshot(), beforeArchive)
  assert.equal((await json(developer, '/sweet-cards/batches')).body.batches.some((batch) => batch.id === batchId), false)
  assert.equal((await json(developer, '/sweet-cards/batches?businessPurpose=ALL&archived=true')).body.batches.some((batch) => batch.id === batchId), true)
  assert.equal(await prisma.sweetCardAuditLog.count({ where: { batchId, action: 'sweet_card.batch_archived' } }), 1)

  const restore = await json(developer, `/sweet-cards/batches/${batchId}/restore`, { method: 'POST', body: { reason: 'restored isolated gate' } })
  assert.equal(restore.status, 200)
  assert.equal(restore.body.batch.archivedAt, null)
  assert.deepEqual(await snapshot(), beforeArchive)
  assert.equal(await prisma.sweetCardAuditLog.count({ where: { batchId, action: 'sweet_card.batch_restored' } }), 1)

  assert.equal((await request(cashier, `/sweet-cards/batches/${batchId}/archive`, { method: 'POST', body: {} })).status, 403)
  assert.equal((await request(developer, `/sweet-cards/batches/${batchId}`, { method: 'DELETE' })).status, 404)
  assert.equal((await request(developer, `/sweet-cards/cards/${accountId}`, { method: 'DELETE' })).status, 404)

  const ledgerBeforeVoid = await prisma.sweetCardLedger.findMany({ where: { accountId }, orderBy: { id: 'asc' } })
  const voidResult = await json(developer, `/sweet-cards/cards/${accountId}/void`, { method: 'POST' })
  assert.equal(voidResult.status, 200)
  const voided = await prisma.sweetCardAccount.findUnique({ where: { id: accountId }, include: { credentials: true } })
  assert.equal(voided.status, 'VOID')
  assert.equal(voided.balanceCents, 1000n)
  assert.equal(voided.credentials[0].status, 'REVOKED')
  assert.equal(voided.credentials[0].revokeReason, 'CARD_VOID')
  assert.deepEqual(await prisma.sweetCardLedger.findMany({ where: { accountId }, orderBy: { id: 'asc' } }), ledgerBeforeVoid)

  const reconciliation = await json(developer, '/sweet-cards/reconciliation')
  assert.equal(reconciliation.status, 200)
  assert.equal(reconciliation.body.scope, 'ALL_REAL_FACTS')
  assert.equal(reconciliation.body.all.deltaCents, '0')
  console.log(JSON.stringify({ result: 'RESTORED_M65_TO_M66_API_INTEGRATION_PASS', archive: 'PASS', restore: 'PASS', ordinaryPosArchive: 403, hardDelete: 'NOT_AVAILABLE', cardDelete: 'DISABLED', void: 'EXISTING_CONTRACT_ONLY', ledgerDeltaCents: '0' }))
} finally {
  server.close()
  await prisma.$disconnect()
}
