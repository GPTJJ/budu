import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

// Real Prisma + PostgreSQL + production HTTP handlers. Only the first completed
// pre-read is paused, so each interleaving is deterministic without timing sleeps.
// The standard test runner strips external credentials before loading this file.
if (process.env.APP_ENV !== 'test' || process.env.NODE_ENV !== 'test') {
  throw new Error('TRANSFER_CAS_TEST_REQUIRES_ISOLATED_TEST_ENV')
}
const actors = {
  developer: { username: 'developer', role: 'developer' },
  admin: { username: 'admin', role: 'admin' },
  finance: { username: 'finance', role: 'finance' },
  sender: { username: 'sender', role: 'manager', storeKeys: ['guanshe'] },
  receiver: { username: 'receiver', role: 'manager', storeKeys: ['tongying'] },
  owner: { username: 'owner', role: 'staff', storeKeys: ['tongying'] },
  outsider: { username: 'outsider', role: 'staff', storeKeys: ['xidan'] },
  delegated: { username: 'delegated', role: 'staff', permissions: { inventoryTransferAll: true } },
  blocked: { username: 'blocked', role: 'manager', storeKeys: ['guanshe'], permissions: { modules: { 'inventory-transfer': false } } },
}
const states = { ship: 'shipped', withdraw: 'canceled', reject: 'rejected' }
const include = { items: { orderBy: { id: 'asc' } } }
let db, server, origin, databaseUrl, gate, sequence = 0

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function holdRead(id) {
  assert.equal(gate, undefined)
  const entered = deferred(), released = deferred()
  gate = { id, entered, released }
  return { entered: entered.promise, release: released.resolve }
}
async function readWithBarrier({ args, query }) {
  const snapshot = await query(args)
  if (gate && args.where.id === gate.id) {
    const current = gate
    gate = undefined
    current.entered.resolve()
    await current.released.promise
  }
  return snapshot
}

before(async () => {
  databaseUrl = await createDisposablePgDatabase('transfer_cas')
  process.env.DATABASE_URL = databaseUrl
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  globalThis.__buduPrisma = db.$extends({ query: { transferRequest: {
    findUnique: readWithBarrier, findFirst: readWithBarrier,
  } } })
  const { v2Router } = await import('../server/v2.js')
  const app = express()
  app.use(express.json())
  // Session creation/module authorization are separately covered by the existing
  // role-module API suite. Inject authenticated principals only in this local app.
  app.use((req, res, next) => {
    req.user = actors[req.get('x-test-actor') || 'developer']
    if (!req.user) return res.sendStatus(401)
    next()
  })
  app.use('/api/v2', v2Router)
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  await db.store.createMany({ data: [
    { key: 'guanshe', name: '官舍' }, { key: 'tongying', name: '通盈' },
  ] })
  await db.inventoryItem.create({ data: { id: 'cas-item', name: 'CAS fixture', category: 'material', transferEnabled: true } })
})

after(async () => {
  gate?.released.resolve()
  if (server) await new Promise(resolve => server.close(resolve))
  await db?.$disconnect()
  delete globalThis.__buduPrisma
  if (databaseUrl) await dropDisposablePgDatabase(databaseUrl)
})

async function fixture(data = {}) {
  const id = `cas-${++sequence}`
  return db.transferRequest.create({ data: {
    id, fromStoreKey: 'guanshe', toStoreKey: 'tongying', createdBy: 'owner',
    ...data,
    items: { create: { id: `${id}-item`, itemId: 'cas-item', quantity: 5,
      itemNameSnapshot: 'CAS fixture', categorySnapshot: 'material',
      ...(data.status === 'shipped' ? { shippedQuantity: 3 } : {}),
    } },
  } })
}
async function action(id, name, actor = 'developer') {
  const response = await fetch(`${origin}/api/v2/transfer-requests/${id}${name === 'withdraw' ? '' : `/${name}`}`, {
    method: name === 'withdraw' ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    ...(name === 'ship' ? { body: JSON.stringify({ items: [{ itemId: 'cas-item', shippedQuantity: 3 }] }) } : {}),
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, body: await response.json() }
}
const snapshot = id => db.transferRequest.findUnique({ where: { id }, include })
const notices = id => db.notification.count({ where: { refId: id, templateKey: 'transfer_shipped' } })
async function assertWinner(id, name, actor = 'developer') {
  const row = await snapshot(id)
  assert.equal(row.status, states[name])
  assert.equal(row.items[0].quantity, 5)
  assert.equal(row.items[0].shippedQuantity, name === 'ship' ? 3 : null)
  assert.equal(row.shippedBy, name === 'ship' ? actor : '')
  assert.equal(Boolean(row.shippedAt), name === 'ship')
  assert.equal(row.withdrawnBy, name === 'withdraw' ? actor : '')
  assert.equal(Boolean(row.withdrawnAt), name === 'withdraw')
  assert.equal(await notices(id), name === 'ship' ? 1 : 0)
}

for (const name of Object.keys(states)) {
  test(`normal pending -> ${name}: serialized record and side effects`, async () => {
    const { id } = await fixture()
    const result = await action(id, name)
    assert.equal(result.status, 200)
    assert.equal(result.body.request.status, states[name])
    assert.equal(result.body.request.fromStoreKey, 'guanshe')
    assert.equal(result.body.request.storeKey, 'tongying')
    assert.equal(result.body.request.items[0].productName, 'CAS fixture')
    assert.equal(result.body.request.items[0].quantity, 5)
    await assertWinner(id, name)
  })
}

// Includes ship/reject and ship/withdraw in both orders, reject/withdraw,
// and simultaneous duplicates: every contender holds an actual pending snapshot.
for (const winner of Object.keys(states)) for (const loser of Object.keys(states)) {
  test(`${winner} wins after ${loser} read pending: loser 409, committed facts unchanged`, { timeout: 20000 }, async () => {
    const { id } = await fixture()
    const barrier = holdRead(id)
    const pending = action(id, loser)
    let committed, loserResult
    try {
      await Promise.race([barrier.entered, pending.then(() => { throw new Error('request returned before pre-read barrier') })])
      assert.equal((await action(id, winner)).status, 200)
      committed = await snapshot(id)
    } finally {
      barrier.release()
      loserResult = await pending
    }
    const final = await snapshot(id)
    console.log(`CAS_RACE winner=${winner} loser=${loser} loserHttp=${loserResult.status} final=${final.status}`)
    assert.equal(loserResult.status, 409)
    assert.deepEqual(final, committed, 'loser must not rewrite status, timestamps, actor or item quantities')
    await assertWinner(id, winner)
  })
}

for (const state of ['shipped', 'canceled', 'rejected']) for (const name of Object.keys(states)) {
  test(`existing ${state}: ${name} returns 409 without changing original facts`, async () => {
    const { id } = await fixture({ status: state,
      ...(state === 'shipped' ? { shippedBy: 'original-shipper', shippedAt: new Date('2026-01-01Z') } : {}),
      ...(state === 'canceled' ? { withdrawnBy: 'original-owner', withdrawnAt: new Date('2026-01-01Z') } : {}),
    })
    const before = await snapshot(id)
    assert.equal((await action(id, name)).status, 409)
    assert.deepEqual(await snapshot(id), before)
    assert.equal(await notices(id), 0)
  })
}
for (const name of Object.keys(states)) {
  test(`sequential duplicate ${name}: only first request succeeds`, async () => {
    const { id } = await fixture()
    assert.equal((await action(id, name)).status, 200)
    const committed = await snapshot(id)
    assert.equal((await action(id, name)).status, 409)
    assert.deepEqual(await snapshot(id), committed)
    await assertWinner(id, name)
  })
  test(`already deleted: ${name} cannot transition`, async () => {
    const { id } = await fixture({ deletedAt: new Date('2026-01-01Z'), deletedBy: 'fixture' })
    const before = await snapshot(id)
    assert.equal((await action(id, name)).status, name === 'withdraw' ? 409 : 404)
    assert.deepEqual(await snapshot(id), before)
    assert.equal(await notices(id), 0)
  })
  test(`deleted after pending pre-read: ${name} loses CAS`, { timeout: 20000 }, async () => {
    const { id } = await fixture()
    const barrier = holdRead(id), pending = action(id, name)
    let deleted, result
    try {
      await Promise.race([barrier.entered, pending.then(() => { throw new Error('missing read barrier') })])
      await db.transferRequest.update({ where: { id }, data: { deletedAt: new Date('2026-01-01Z'), deletedBy: 'fixture' } })
      deleted = await snapshot(id)
    } finally { barrier.release(); result = await pending }
    assert.equal(result.status, 409)
    assert.deepEqual(await snapshot(id), deleted)
    assert.equal(await notices(id), 0)
  })
  test(`missing transfer: ${name} preserves 404`, async () => {
    assert.equal((await action('absent-id', name)).status, 404)
  })
}

for (const [actor, allowed] of Object.entries({
  developer: ['ship', 'withdraw', 'reject'], admin: ['ship', 'withdraw', 'reject'],
  finance: ['ship', 'withdraw', 'reject'], sender: ['ship', 'reject'], receiver: [],
  owner: ['withdraw'], outsider: [], delegated: ['ship', 'withdraw', 'reject'], blocked: [],
})) for (const name of Object.keys(states)) {
  test(`permission ${actor}/${name} unchanged`, async () => {
    const { id } = await fixture()
    const before = await snapshot(id)
    const result = await action(id, name, actor)
    assert.equal(result.status, allowed.includes(name) ? 200 : 403)
    if (result.status === 200) await assertWinner(id, name, actor)
    else {
      assert.deepEqual(await snapshot(id), before)
      assert.equal(await notices(id), 0)
    }
  })
}
