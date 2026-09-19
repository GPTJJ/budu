import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const configuredDatabaseUrl = String(process.env.SC_ISSUE_IDEMPOTENCY_DATABASE_URL || '').trim()
if (configuredDatabaseUrl) {
  const target = new URL(configuredDatabaseUrl)
  if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)
      || target.pathname !== '/budu_sc_issue_idempotency'
      || target.search) {
    throw new Error('ISOLATED_PG16_DATABASE_REQUIRED')
  }
  process.env.DATABASE_URL = target.toString()
  execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'inherit',
    timeout: 180000,
  })
} else {
  process.env.DATABASE_URL = await createDisposablePgSchema('sweet_card_issue_idempotency')
}
process.env.SWEET_CARD_CREDENTIAL_KEY = '21'.repeat(32)

const { PrismaClient } = await import('@prisma/client')
const { issueSweetCardBatch } = await import('../server/sweet-card-issue.js')
const { newCredential } = await import('../server/sweet-card-core.js')
const db = new PrismaClient()

const actorA = { id: 'issue-idem-actor-a', name: 'Issue A' }
const actorB = { id: 'issue-idem-actor-b', name: 'Issue B' }
const basePayload = {
  name: 'Idempotency Native', purpose: 'Gate 2.2', businessPurpose: 'ACCEPTANCE_TEST',
  cardCount: 3, faceValueYuan: '500.00', validityType: 'ONE_YEAR', carrierType: 'PHYSICAL',
  bindingMode: 'NONE', recipientType: 'CUSTOMER', recipientLabel: 'Native', recipientCompany: 'Budu',
  recipientNote: 'Test only', giftingScenario: 'GATE_2_2', activateNow: false,
}

const issue = (actor, requestKey, input = basePayload, options = {}) => issueSweetCardBatch({
  db, actor, requestKey, input, ...options,
})

async function assertIssuanceFacts(actorId, requestKey, expectedCards) {
  const operation = await db.sweetCardIssueOperation.findUnique({
    where: { actorId_requestKey: { actorId, requestKey } },
    include: { batch: { include: { accounts: { include: { credentials: true, ledger: true } } } } },
  })
  assert.ok(operation)
  assert.equal(await db.sweetCardBatch.count({ where: { id: operation.batchId } }), 1)
  assert.equal(operation.batch.accounts.length, expectedCards)
  assert.equal(operation.batch.accounts.reduce((count, account) => count + account.credentials.length, 0), expectedCards)
  assert.equal(operation.batch.accounts.reduce((count, account) => count + account.ledger.filter(row => row.type === 'ISSUE').length, 0), expectedCards)
  for (const account of operation.batch.accounts) {
    assert.equal(account.credentials.length, 1)
    assert.equal(account.ledger.length, 1)
    assert.equal(account.ledger[0].type, 'ISSUE')
    assert.equal(account.ledger[0].amountCents, account.initialAmountCents)
    assert.equal(account.ledger[0].balanceAfterCents, account.balanceCents)
    assert.equal(account.balanceCents, account.initialAmountCents)
  }
  const balance = operation.batch.accounts.reduce((sum, account) => sum + account.balanceCents, 0n)
  const ledger = operation.batch.accounts.flatMap(account => account.ledger).reduce((sum, row) => sum + row.amountCents, 0n)
  assert.equal(balance, ledger)
  assert.equal(balance, operation.batch.totalInitialAmountCents)
  return operation
}

async function valueCounts() {
  const [operations, batches, cards, credentials, issueLedger, audits] = await Promise.all([
    db.sweetCardIssueOperation.count(), db.sweetCardBatch.count(), db.sweetCardAccount.count(),
    db.sweetCardCredential.count(), db.sweetCardLedger.count({ where: { type: 'ISSUE' } }),
    db.sweetCardAuditLog.count({ where: { action: 'sweet_card.batch_created' } }),
  ])
  return { operations, batches, cards, credentials, issueLedger, audits }
}

async function concurrencyCase(size) {
  const requestKey = `native:concurrency:${size}`
  const payload = { ...basePayload, name: `Concurrent ${size}`, cardCount: 2 }
  const results = await Promise.all(Array.from({ length: size }, () => issue(actorA, requestKey, payload)))
  assert.equal(new Set(results.map(row => row.response.batchId)).size, 1)
  assert.ok(results.some(row => row.event === 'NEW_REQUEST'))
  assert.equal(results.filter(row => row.event === 'NEW_REQUEST').length, 1)
  assert.ok(results.every(row => ['NEW_REQUEST', 'IDEMPOTENT_REPLAY', 'IDEMPOTENT_REPLAY_AFTER_IN_PROGRESS'].includes(row.event)))
  for (const result of results) assert.deepEqual(result.response, results[0].response)
  await assertIssuanceFacts(actorA.id, requestKey, 2)
}

try {
  const [{ server_version: serverVersion }] = await db.$queryRawUnsafe('SHOW server_version')
  assert.match(serverVersion, /^16\./)
  assert.deepEqual(await valueCounts(), { operations: 0, batches: 0, cards: 0, credentials: 0, issueLedger: 0, audits: 0 })
  await db.user.createMany({ data: [
    { id: actorA.id, username: 'issue-idem-a', passwordHash: 'not-used', role: 'admin', displayName: actorA.name },
    { id: actorB.id, username: 'issue-idem-b', passwordHash: 'not-used', role: 'admin', displayName: actorB.name },
  ] })

  const sequentialKey = 'native:sequential:retry'
  const first = await issue(actorA, sequentialKey)
  const second = await issue(actorA, sequentialKey)
  assert.equal(first.event, 'NEW_REQUEST')
  assert.equal(second.event, 'IDEMPOTENT_REPLAY')
  assert.deepEqual(second.response, first.response)
  await assertIssuanceFacts(actorA.id, sequentialKey, 3)

  // Response-loss simulation: the committed first response is deliberately discarded.
  const responseLossKey = 'native:response:lost'
  await issue(actorA, responseLossKey)
  const recovered = await issue(actorA, responseLossKey)
  assert.equal(recovered.event, 'IDEMPOTENT_REPLAY')
  const recoveredFacts = await assertIssuanceFacts(actorA.id, responseLossKey, 3)
  assert.equal(recovered.response.batchId, recoveredFacts.batchId)

  await concurrencyCase(2)
  await concurrencyCase(8)
  await concurrencyCase(16)

  const conflictKey = 'native:payload:conflict'
  await issue(actorA, conflictKey)
  const beforeConflict = await valueCounts()
  await assert.rejects(
    issue(actorA, conflictKey, { ...basePayload, faceValueYuan: '501.00' }),
    error => error.status === 409 && error.publicCode === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
  )
  assert.deepEqual(await valueCounts(), beforeConflict)

  const samePayloadA = await issue(actorA, 'native:different:key:a')
  const samePayloadB = await issue(actorA, 'native:different:key:b')
  assert.notEqual(samePayloadA.response.batchId, samePayloadB.response.batchId)
  await assertIssuanceFacts(actorA.id, 'native:different:key:a', 3)
  await assertIssuanceFacts(actorA.id, 'native:different:key:b', 3)

  const sharedKey = 'native:principal:shared'
  const principalA = await issue(actorA, sharedKey)
  const principalB = await issue(actorB, sharedKey)
  assert.notEqual(principalA.response.batchId, principalB.response.batchId)
  assert.deepEqual((await issue(actorB, sharedKey)).response, principalB.response)
  assert.notDeepEqual(principalB.response, principalA.response)
  await assertIssuanceFacts(actorA.id, sharedKey, 3)
  await assertIssuanceFacts(actorB.id, sharedKey, 3)

  const beforeFailure = await valueCounts()
  let credentialCalls = 0
  await assert.rejects(issue(actorA, 'native:atomic:failure', { ...basePayload, cardCount: 3 }, {
    credentialFactory: () => {
      credentialCalls += 1
      if (credentialCalls === 2) throw new Error('SYNTHETIC_ISSUANCE_FAILURE')
      return newCredential()
    },
  }), /SYNTHETIC_ISSUANCE_FAILURE/)
  assert.deepEqual(await valueCounts(), beforeFailure)
  assert.equal(await db.sweetCardIssueOperation.count({ where: { actorId: actorA.id, requestKey: 'native:atomic:failure' } }), 0)

  console.log(JSON.stringify({
    result: 'SWEET_CARD_ISSUE_IDEMPOTENCY_NATIVE_PASS',
    postgres: serverVersion,
    sequentialRetry: 'PASS', responseLoss: 'PASS', concurrency: { 2: 'PASS', 8: 'PASS', 16: 'PASS' },
    payloadConflict: 'PASS', differentKeyControl: 'PASS', principalIsolation: 'PASS',
    failureAtomicity: 'PASS', balanceLedgerInvariant: 'PASS', finalCounts: await valueCounts(),
  }))
} finally {
  await db.$disconnect()
}
