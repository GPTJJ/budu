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
assert.equal(caseName, 'ALL')
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

function holdPendingRead(id, status) {
  assert.equal(gate, undefined)
  const entered = deferred()
  const released = deferred()
  gate = { id, status, entered, released }
  return { entered: entered.promise, release: released.resolve }
}

async function readWithBarrier({ args, query }) {
  const row = await query(args)
  if (gate && args.where.id === gate.id) {
    const current = gate
    gate = undefined
    assert.equal(row?.status, current.status, 'contenders must start from the authorized state')
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
  await db.notificationTemplate.upsert({ where: { key: 'approval_todo' }, create: { key: 'approval_todo', name: 'CAS todo', titleTpl: '{title}', contentTpl: '{title}', target: 'approval' }, update: {} })
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

async function fixture(status = 'draft') {
  const id = `approval-cas-${crypto.randomUUID()}`
  await db.approvalRequest.create({ data: {
    id, requestNo: id, templateKey: 'approval-cas-expense', title: 'Native CAS test',
    status, formData: {}, amountCents: 100n,
    submitterUsername: actors.submitter.username, submitterName: actors.submitter.displayName,
    ...(status === 'rejected' || status === 'approved' ? { nodes: { create: { id: `node-${id}`, nodeIndex: 1, approverUsername: actors.approver.username, status } } } : {}),
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
    db.approvalRequest.findUnique({ where: { id }, select: { status: true, title: true } }),
    db.approvalNode.findMany({ where: { requestId: id }, select: { status: true } }),
    db.approvalLog.findMany({ where: { requestId: id }, select: { action: true } }),
    db.approvalNotification.findMany({ where: { requestId: id }, select: { type: true } }),
    db.approvalComment.findMany({ where: { requestId: id }, select: { content: true } }),
    db.notification.findMany({ where: { refId: id }, select: { id: true } }),
  ])
  return {
    status: request?.status, title: request?.title,
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

const submit = id => post(id, 'submit', 'submitter')
const archive = id => post(id, 'archive', 'approver')
async function change(id, method, actor = 'submitter', body = {}) {
  const response = await fetch(`${origin}/api/v2/approvals/requests/${id}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, body: await response.json() }
}
const edit = id => change(id, 'PUT', 'submitter', { title: 'Changed draft', formData: {} })
const remove = id => change(id, 'DELETE')
async function settle() { await new Promise(resolve => setTimeout(resolve, 150)) }

async function race(label, initial, loserAction, winnerAction) {
  const id = await fixture(initial)
  const barrier = holdPendingRead(id, initial)
  const losing = loserAction(id)
  let winnerFacts, loser
  try {
    await Promise.race([barrier.entered, losing.then(() => { throw new Error(`${label}: barrier bypassed`) })])
    assert.equal((await winnerAction(id)).status, 200, `${label}_WINNER`)
    await settle()
    winnerFacts = await facts(id)
  } finally {
    barrier.release()
    loser = await losing
  }
  await settle()
  assert.equal(loser.status, 409, `${label}_CONFLICT`)
  assert.deepEqual(await facts(id), winnerFacts, `${label}_NO_LOSER_SIDE_EFFECTS`)
  console.log(`${label}=PASS loser=409 winner-state-and-side-effects-preserved`)
}

test('L1 duplicate submit has one node/log/notification set', async () => race('L1', 'draft', submit, submit))
test('L2 archive loses to resubmit', async () => race('L2', 'rejected', archive, submit))
test('L3 resubmit loses to archive', async () => race('L3', 'rejected', submit, archive))
test('L4 staff draft delete loses to submit', async () => race('L4', 'draft', remove, submit))
test('L5 edit cannot overwrite submitted contents', async () => race('L5', 'draft', edit, submit))
test('L6 submit with stale draft contents loses to edit', async () => race('L6', 'draft', submit, edit))
test('L7 submit loses to authorized draft delete', async () => race('L7', 'draft', submit, remove))
test('L8 duplicate archive logs only once', async () => race('L8', 'approved', archive, archive))
test('L9 duplicate draft delete returns conflict', async () => race('L9', 'draft', remove, remove))
test('L10 old resubmit cannot reset a newly approved request', async () => race('L10', 'rejected', submit, async id => {
  assert.equal((await submit(id)).status, 200)
  return decide(id, 'approve')
}))
test('L11 old rejected snapshot cannot overwrite a later rejected cycle', async () => race('L11', 'rejected', submit, async id => {
  assert.equal((await submit(id)).status, 200)
  return decide(id, 'reject')
}))
test('L12 state permissions and administrator delete remain unchanged', async () => {
  const pending = await fixture('pending')
  for (const op of [submit, archive, remove, edit]) assert.equal((await op(pending)).status, 403)
  assert.equal((await change(pending, 'DELETE', 'approver')).status, 200)
  const draft = await fixture()
  assert.equal((await post(draft, 'submit', 'approver')).status, 403)
  assert.equal((await edit(draft)).status, 200)
  assert.equal((await remove(draft)).status, 200)
  const approved = await fixture('approved')
  assert.equal((await archive(approved)).status, 200)
})
test('L13 failed submit log rolls back claim, nodes, cc and notifications', async () => {
  const id = await fixture()
  const before = await facts(id)
  await db.$executeRawUnsafe(`ALTER TABLE approval_logs ADD CONSTRAINT lifecycle_test_log_failure CHECK (action <> 'submit') NOT VALID`)
  let response
  try { response = await submit(id) }
  finally { await db.$executeRawUnsafe('ALTER TABLE approval_logs DROP CONSTRAINT lifecycle_test_log_failure') }
  assert.equal(response.status, 500)
  await settle()
  assert.deepEqual(await facts(id), before, 'L13_TRANSACTION_ROLLBACK')
  assert.equal(await db.approvalCc.count({ where: { requestId: id } }), 0)
})
