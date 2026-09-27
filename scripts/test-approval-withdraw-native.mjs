import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { PrismaClient } from '@prisma/client'

// Real Approval HTTP route + Prisma transactions on a runner-local PostgreSQL 16.
// The companion script creates, migrates, and destroys the exact test database.
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(process.env.APP_ENV, 'test')
const databaseUrl = process.env.TEST_APPROVAL_DATABASE_URL || ''
const target = new URL(databaseUrl)
assert.equal(target.protocol, 'postgresql:')
assert.equal(target.hostname, '127.0.0.1')
assert.equal(decodeURIComponent(target.pathname.slice(1)), 'budu_test_approval_cas')
assert.notEqual(target.pathname.slice(1), 'budu_bj006')
assert.equal(process.env.DATABASE_URL, databaseUrl)
console.log('NATIVE_PG_TARGET host=localhost database=budu_test_approval_cas')

const caseName = process.env.TEST_APPROVAL_CASE || 'ALL'
assert.ok(['ALL', 'N1'].includes(caseName))
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
let server
let origin
let gate
const actors = {
  submitter: { id: 'approval-cas-submitter', username: 'approval-cas-submitter', role: 'staff', displayName: 'CAS Submitter', storeKeys: [], permissions: {} },
  approver: { id: 'approval-cas-approver', username: 'approval-cas-approver', role: 'admin', displayName: 'CAS Approver', storeKeys: [], permissions: {} },
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function holdPendingRead(id) {
  assert.equal(gate, undefined)
  const entered = deferred()
  const released = deferred()
  gate = { id, entered, released }
  return { entered: entered.promise, release: released.resolve }
}

async function readWithBarrier({ args, query }) {
  const row = await query(args)
  if (gate && args.where.id === gate.id) {
    const current = gate
    gate = undefined
    assert.equal(row?.status, 'pending', 'both contenders must start from pending')
    current.entered.resolve()
    await current.released.promise
  }
  return row
}

before(async () => {
  await db.$queryRaw`SELECT 1`
  await db.approvalTemplate.upsert({
    where: { key: 'approval-cas-expense' },
    create: { key: 'approval-cas-expense', name: 'CAS expense', schema: [], approverRule: { type: 'role', role: 'admin' }, ccRule: [] },
    update: {},
  })
  await db.user.createMany({ data: [
    { id: actors.submitter.id, username: actors.submitter.username, passwordHash: 'test-only', role: 'staff', displayName: actors.submitter.displayName },
    { id: actors.approver.id, username: actors.approver.username, passwordHash: 'test-only', role: 'admin', displayName: actors.approver.displayName },
  ], skipDuplicates: true })
  await db.notificationTemplate.upsert({
    where: { key: 'approval_result' },
    create: { key: 'approval_result', name: 'CAS result', titleTpl: '{result}', contentTpl: '{resultText}', target: 'approval' },
    update: {},
  })
  process.env.DATABASE_URL = databaseUrl
  globalThis.__buduPrisma = db.$extends({ query: { approvalRequest: { findUnique: readWithBarrier } } })
  const { approvalRouter } = await import('../server/approvals.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.user = actors[req.get('x-test-actor')]
    if (!req.user) return res.sendStatus(401)
    next()
  })
  app.use('/api/v2', approvalRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  gate?.released.resolve()
  if (server) await new Promise(resolve => server.close(resolve))
  delete globalThis.__buduPrisma
  await db.$disconnect()
})

async function fixture() {
  const id = `approval-cas-${crypto.randomUUID()}`
  await db.approvalRequest.create({ data: {
    id, requestNo: id, templateKey: 'approval-cas-expense', title: 'Native CAS test',
    status: 'pending', formData: {}, amountCents: 100n,
    submitterUsername: actors.submitter.username, submitterName: actors.submitter.displayName,
    nodes: { create: { id: `node-${id}`, nodeIndex: 1, approverUsername: actors.approver.username } },
  } })
  return id
}

async function post(id, endpoint, actor, body = {}) {
  const response = await fetch(`${origin}/api/v2/approvals/requests/${id}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, body: await response.json() }
}
const withdraw = id => post(id, 'withdraw', 'submitter')
const decide = (id, action) => post(id, 'decide', 'approver', { action, comment: action === 'reject' ? 'Native reject reason' : 'Native approval' })

async function facts(id) {
  const [request, nodes, logs, notifications, comments, center] = await Promise.all([
    db.approvalRequest.findUnique({ where: { id }, select: { status: true } }),
    db.approvalNode.findMany({ where: { requestId: id }, select: { status: true } }),
    db.approvalLog.findMany({ where: { requestId: id }, select: { action: true } }),
    db.approvalNotification.findMany({ where: { requestId: id }, select: { type: true } }),
    db.approvalComment.findMany({ where: { requestId: id }, select: { content: true } }),
    db.notification.findMany({ where: { refId: id, templateKey: 'approval_result' }, select: { id: true } }),
  ])
  return {
    status: request?.status,
    nodes: nodes.map(row => row.status),
    logs: logs.map(row => row.action),
    notifications: notifications.map(row => row.type),
    comments: comments.map(row => row.content),
    centerResults: center.length,
  }
}

async function waitForCenterResult(id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await facts(id)).centerResults === 1) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await facts(id)).centerResults, 1, 'winner decision must send one result notification')
}

async function decisionWins(label, action) {
  const id = await fixture()
  const barrier = holdPendingRead(id)
  const losing = withdraw(id)
  let loser
  try {
    await Promise.race([barrier.entered, losing.then(() => { throw new Error('withdraw returned before pending read barrier') })])
    const winner = await decide(id, action)
    assert.equal(winner.status, 200, `${label}_WINNER_DECIDE`)
  } finally {
    barrier.release()
    loser = await losing
  }
  assert.equal(loser.status, 409, `${label}_WITHDRAW_CONFLICT`)
  await waitForCenterResult(id)
  const final = await facts(id)
  const status = action === 'approve' ? 'approved' : 'rejected'
  assert.equal(final.status, status, `${label}_REQUEST_STATUS`)
  assert.deepEqual(final.nodes, [status], `${label}_CROSS_TABLE_NODES`)
  assert.deepEqual(final.logs, [action], `${label}_CROSS_TABLE_LOGS`)
  assert.deepEqual(final.notifications, ['result'], `${label}_CROSS_TABLE_NOTIFICATIONS`)
  assert.equal(final.comments.length, 1, `${label}_CROSS_TABLE_COMMENTS`)
  assert.equal(final.centerResults, 1, `${label}_CENTER_NOTIFICATION`)
  console.log(`${label}=PASS winner=${action} loser=withdraw http=${loser.status}`)
}

async function withdrawWins(label, action) {
  const id = await fixture()
  const barrier = holdPendingRead(id)
  const losing = decide(id, action)
  let loser
  try {
    await Promise.race([barrier.entered, losing.then(() => { throw new Error('decide returned before pending read barrier') })])
    const winner = await withdraw(id)
    assert.equal(winner.status, 200, `${label}_WINNER_WITHDRAW`)
  } finally {
    barrier.release()
    loser = await losing
  }
  assert.equal(loser.status, 409, `${label}_DECIDE_CONFLICT`)
  const final = await facts(id)
  assert.deepEqual(final, {
    status: 'withdrawn', nodes: ['pending'], logs: ['withdraw'],
    notifications: [], comments: [], centerResults: 0,
  }, `${label}_CROSS_TABLE_ATOMICITY`)
  console.log(`${label}=PASS winner=withdraw loser=${action} http=${loser.status}`)
}

test('N1 approve wins after withdraw saw pending', async () => decisionWins('N1', 'approve'))
if (caseName === 'ALL') {
  test('N2 reject wins after withdraw saw pending', async () => decisionWins('N2', 'reject'))
  test('N3 withdraw wins after approve saw pending', async () => withdrawWins('N3', 'approve'))
  test('N4 withdraw wins after reject saw pending', async () => withdrawWins('N4', 'reject'))

  test('N5 actual PostgreSQL row lock contention has one CAS winner', { timeout: 20000 }, async () => {
    const id = await fixture()
    const competitor = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    const holderReady = deferred()
    const releaseHolder = deferred()
    const competitorPid = deferred()
    let holder, loser, lockObserved = false
    try {
      assert.equal((await db.approvalRequest.findUnique({ where: { id } })).status, 'pending')
      assert.equal((await competitor.approvalRequest.findUnique({ where: { id } })).status, 'pending')
      holder = db.$transaction(async tx => {
        const claim = await tx.approvalRequest.updateMany({ where: { id, status: 'pending' }, data: { status: 'approved' } })
        holderReady.resolve()
        await releaseHolder.promise
        return claim.count
      }, { timeout: 15000 })
      await holderReady.promise
      loser = competitor.$transaction(async tx => {
        const rows = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
        competitorPid.resolve(Number(rows[0].pid))
        const claim = await tx.approvalRequest.updateMany({ where: { id, status: 'pending' }, data: { status: 'withdrawn' } })
        return claim.count
      }, { timeout: 15000 })
      const pid = await competitorPid.promise
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`
        if (rows[0]?.wait_event_type === 'Lock') { lockObserved = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(lockObserved, true, 'N5_LOCK_CONTENTION_OBSERVED')
    } finally {
      releaseHolder.resolve()
      if (holder) await holder
      if (loser) await loser
      await competitor.$disconnect()
    }
    assert.equal(await holder, 1, 'N5_WINNER_COUNT')
    assert.equal(await loser, 0, 'N5_LOSER_COUNT')
    assert.equal((await facts(id)).status, 'approved', 'N5_FINAL_STATUS')
    console.log('N5=PASS LOCK_CONTENTION_OBSERVED=YES WINNER_COUNT=1 LOSER_COUNT=1')
  })

  test('withdraw log failure rolls back successful CAS', async () => {
    const id = await fixture()
    await db.$executeRawUnsafe(`ALTER TABLE approval_logs ADD CONSTRAINT approval_cas_test_log_failure CHECK (action <> 'withdraw') NOT VALID`)
    let response
    try {
      response = await withdraw(id)
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE approval_logs DROP CONSTRAINT approval_cas_test_log_failure')
    }
    assert.equal(response.status, 500, 'ROLLBACK_INJECTED_FAILURE')
    assert.deepEqual(await facts(id), {
      status: 'pending', nodes: ['pending'], logs: [],
      notifications: [], comments: [], centerResults: 0,
    }, 'WITHDRAW_TRANSACTION_ROLLBACK')
    console.log('WITHDRAW_TRANSACTION_ROLLBACK=PASS')
  })
}
