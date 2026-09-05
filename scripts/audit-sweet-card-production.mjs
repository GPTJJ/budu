import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import { hasSweetCardPosRedeem } from '../shared/accountPermissions.js'

const normalize = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
const hash = (value) => crypto.createHash('sha256').update(normalize(value)).digest('hex')
const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key]), 0n)

try {
  const [database, migrations, failed, batches, accounts, credentials, bindings, ledger, redemptions, refunds, audits, users, paymentStates, refundCount, archiveColumn] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE started_at IS NOT NULL AND finished_at IS NULL AND rolled_back_at IS NULL'),
    prisma.sweetCardBatch.findMany({ orderBy: { createdAt: 'asc' }, include: { accounts: { select: { status: true, initialAmountCents: true, balanceCents: true, activatedAt: true, binding: true } } } }),
    prisma.sweetCardAccount.findMany({ orderBy: { id: 'asc' }, select: { id: true, batchId: true, initialAmountCents: true, balanceCents: true, status: true, validFrom: true, expiresAt: true, activatedAt: true, version: true } }),
    prisma.sweetCardCredential.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, status: true, activatedAt: true, revokedAt: true, revokeReason: true, replacedByCredentialId: true } }),
    prisma.sweetCardBinding.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, memberId: true, verificationMethod: true, boundAt: true } }),
    prisma.sweetCardLedger.findMany({ orderBy: { id: 'asc' }, select: { id: true, accountId: true, type: true, amountCents: true, balanceAfterCents: true, orderId: true, redemptionId: true, refundId: true, requestKey: true, createdAt: true } }),
    prisma.sweetCardRedemption.findMany({ orderBy: { id: 'asc' }, select: { id: true, orderId: true, accountId: true, credentialId: true, amountCents: true, requestKey: true, storeIdSnapshot: true, createdAt: true } }),
    prisma.sweetCardRefund.findMany({ orderBy: { id: 'asc' }, select: { id: true, refundId: true, redemptionId: true, accountId: true, amountCents: true, requestKey: true, createdAt: true } }),
    prisma.sweetCardAuditLog.count(),
    prisma.user.findMany({ where: { status: { not: 'disabled' } } }),
    prisma.payment.groupBy({ by: ['provider', 'status'], _count: { _all: true } }),
    prisma.refund.count(),
    prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='sweet_card_batches' AND column_name='archived_at'`),
  ])
  const archived = archiveColumn[0].count === 1
    ? Number((await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "sweet_card_batches" WHERE "archived_at" IS NOT NULL'))[0].count)
    : null
  const issue = ledger.filter((entry) => entry.type === 'ISSUE').reduce((total, entry) => total + entry.amountCents, 0n)
  const redeemed = -ledger.filter((entry) => entry.type === 'REDEEM').reduce((total, entry) => total + entry.amountCents, 0n)
  const refunded = ledger.filter((entry) => entry.type === 'REFUND').reduce((total, entry) => total + entry.amountCents, 0n)
  const reversal = ledger.filter((entry) => entry.type === 'REVERSAL').reduce((total, entry) => total + entry.amountCents, 0n)
  const balance = sum(accounts, 'balanceCents')
  const ledgerSum = sum(ledger, 'amountCents')
  const batchSummary = batches.map((batch) => ({
    id: batch.id,
    name: batch.name,
    businessPurpose: batch.businessPurpose,
    cards: batch.accounts.length,
    issuedCents: String(sum(batch.accounts, 'initialAmountCents')),
    balanceCents: String(sum(batch.accounts, 'balanceCents')),
    statuses: Object.fromEntries([...new Set(batch.accounts.map((account) => account.status))].sort().map((status) => [status, batch.accounts.filter((account) => account.status === status).length])),
    activated: batch.accounts.filter((account) => account.activatedAt).length,
    bindings: batch.accounts.filter((account) => account.binding).length,
  }))
  console.log(normalize({
    database: database[0].name,
    migrations: migrations[0].count,
    failed: failed[0].count,
    runtimeSha: process.env.GIT_SHA,
    commercialFlag: process.env.XIDAN_SWEET_CARD_COMMERCIAL,
    batches: batchSummary,
    archived,
    counts: { accounts: accounts.length, credentials: credentials.length, bindings: bindings.length, ledger: ledger.length, redemptions: redemptions.length, refunds: refunds.length, audits },
    totals: { issue: String(issue), redeem: String(redeemed), refund: String(refunded), reversal: String(reversal), balance: String(balance), ledger: String(ledgerSum), delta: String(ledgerSum - balance) },
    byPurpose: Object.fromEntries(['COMMERCIAL', 'ACCEPTANCE_TEST'].map((purpose) => {
      const purposeAccounts = accounts.filter((account) => batches.find((batch) => batch.id === account.batchId)?.businessPurpose === purpose)
      return [purpose, { cards: purposeAccounts.length, issuedCents: String(sum(purposeAccounts, 'initialAmountCents')), balanceCents: String(sum(purposeAccounts, 'balanceCents')) }]
    })),
    authorizedOperators: users.filter(hasSweetCardPosRedeem).length,
    economicDigest: hash({ accounts, credentials, bindings, ledger, redemptions, refunds }),
    paymentDigest: hash({ paymentStates, refundCount }),
  }))
} finally {
  await prisma.$disconnect()
}
