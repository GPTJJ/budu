import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'

// Explicitly opted-in, owned synthetic database. No URL supplied by a shell,
// production connection, schema mutation, provider call or cleanup DELETE.
assert.equal(process.env.STORE_MANAGEMENT_NATIVE, '1')
const url = new URL('postgresql://budu_store_test@127.0.0.1:55439/budu_store_management_001')
url.searchParams.set('application_name', 'store-management-native')
url.searchParams.set('connection_limit', '12')
const db = new PrismaClient({ datasourceUrl: url.href })
const [identity] = await db.$queryRawUnsafe("SELECT current_database() AS name, current_setting('data_directory') AS directory, current_setting('server_version') AS version")
assert.equal(identity.name, 'budu_store_management_001')
assert.equal(identity.directory, '/tmp/budu-store-management-001-pg')
process.env.DATABASE_URL = url.href
globalThis.__buduPrisma = db
let externalCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { externalCalls++; throw Error('NO_EXTERNAL_IO_IN_STORE_FIXTURE') }
const { createManagedStore, updateManagedStore, setManagedStoreStatus } = await import('../server/store-management.js')
const { assertExistingStore, assertOperatingStore, readStoreDirectory } = await import('../server/store-operation-policy.js')
const prefix = `sm-${crypto.randomBytes(6).toString('hex')}`
const actor = { id: `${prefix}-developer`, username: `${prefix}-developer`, role: 'developer', status: 'active', storeKeys: [] }
await db.user.create({ data: { ...actor, passwordHash: 'synthetic-not-a-password' } })
let key, historicalFacts
const proofs = { identity, lockWaits: [], fixturesRetained: true }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const outcome = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function businessFacts() {
  const tables = await db.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('Store', 'User', 'sensitive_record_audits') ORDER BY tablename")
  const facts = {}
  for (const { tablename } of tables) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"'
    const [row] = await db.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${quoted} t`)
    facts[tablename] = row
  }
  return facts
}
async function waitForLock(fragment) {
  for (let n = 0; n < 100; n++) {
    const rows = await db.$queryRawUnsafe("SELECT query, cardinality(pg_blocking_pids(pid))::int AS blockers FROM pg_stat_activity WHERE datname=current_database() AND application_name='store-management-native' AND wait_event_type='Lock'")
    if (rows.some(row => row.query.includes(fragment) && row.blockers > 0)) {
      proofs.lockWaits.push({ fragment, observed: true }); return
    }
    await pause(20)
  }
  assert.fail(`Expected native PostgreSQL lock wait: ${fragment}`)
}
const actorReset = () => db.user.update({ where: { id: actor.id }, data: { role: 'developer', status: 'active' } })
const status = active => setManagedStoreStatus(db, { actor, key, active })
const auditCount = () => db.sensitiveRecordAudit.count({ where: { recordType: 'store', recordId: key } })

after(async () => {
  try {
    assert.equal(externalCalls, 0)
    if (historicalFacts) {
      assert.deepEqual(await businessFacts(), historicalFacts, 'historical business rows remain byte-equivalent')
      proofs.businessTablesPreserved = Object.keys(historicalFacts).length
      proofs.populatedBusinessTables = Object.entries(historicalFacts).filter(([, value]) => value.count > 0).map(([table]) => table)
      proofs.historicalHashesEqual = true
    }
    proofs.externalCalls = externalCalls
    proofs.storeKey = key
    if (process.env.STORE_MANAGEMENT_NATIVE_PROOF) fs.writeFileSync(process.env.STORE_MANAGEMENT_NATIVE_PROOF, JSON.stringify(proofs, null, 2) + '\n')
  } finally { await db.$disconnect(); globalThis.fetch = originalFetch }
})

test('native: concurrent same-key creation makes one identity and one durable audit', async () => {
  const request = { actor, name: `合成门店${prefix}`, district: '合成位置', active: true, requestKey: `${prefix}-create`, now: new Date('2026-10-01T00:00:00Z') }
  const results = await Promise.all(Array.from({ length: 6 }, () => createManagedStore(db, request)))
  assert.equal(new Set(results.map(result => result.store.key)).size, 1)
  assert.equal(results.filter(result => result.changed).length, 1)
  key = results[0].store.key
  assert.match(key, /^store-[a-f0-9]{20}$/)
  assert.equal(await auditCount(), 1)
  assert.equal(await db.store.count({ where: { name: request.name } }), 1)
  await assert.rejects(createManagedStore(db, { ...request, name: '另一合成名称' }), error => error.status === 409)
  assert.equal(await auditCount(), 1)
  const store = await db.store.findUnique({ where: { key } })
  assert.equal(store.operationType, 'UNKNOWN', 'independent financial eligibility is not copied')
  assert.equal(store.salesDataSource, 'manual')

  const date = new Date('2026-10-12T00:00:00Z'), employeeId = `${prefix}-employee`
  await db.employee.create({ data: { id: employeeId, employeeNo: prefix, name: '合成人员', currentStoreKey: key } })
  await db.dailyEntry.create({ data: { id: `${prefix}-daily`, storeKey: key, date, incCents: 360000n, ord: 12, staffNames: ['合成人员'] } })
  await db.dailyStoreStaff.create({ data: { id: `${prefix}-staff`, storeId: key, employeeId, date, staffId: `${prefix}-legacy`, staffNameSnapshot: '合成人员', actualHours: 7 } })
  await db.dailyPayAdjustment.create({ data: { id: `${prefix}-payroll`, employeeId, staffName: '合成人员', date, autoPayCentsSnapshot: 21000n, adjustedPayCents: 21200n } })
  await db.order.create({ data: { id: `${prefix}-order`, orderNo: `${prefix}-order`, storeId: key, cashierId: actor.id,
    subtotal: 10000n, payableAmount: 10000n, status: 'completed', paymentStatus: 'paid', checkoutKey: `${prefix}-checkout`, cartHash: 'synthetic' } })
  await db.transferRequest.create({ data: { id: `${prefix}-transfer`, fromStoreKey: key, status: 'shipped', fromLocationName: request.name, toLocationName: '合成历史目的地' } })
  await db.procurementOrder.create({ data: { id: `${prefix}-procurement`, storeKey: key, storeNameSnapshot: request.name,
    createdById: actor.id, createdByName: actor.username, createRequestKey: `${prefix}-procurement`, createPayloadHash: 'synthetic' } })
  historicalFacts = await businessFacts()
  proofs.concurrentCreate = { requests: 6, stores: 1, createAudits: 1, conflictingPayloadRejected: true }
})

test('native: edit/disable/retry/reopen retain identity and all historical business facts', async () => {
  const renamed = await updateManagedStore(db, { actor, key, name: '合成更名' + prefix, district: '新合成位置' })
  assert.equal(renamed.store.key, key)
  const count = await auditCount()
  const disabled = await Promise.all(Array.from({ length: 4 }, () => status(false)))
  assert.equal(disabled.filter(result => result.changed).length, 1)
  assert(disabled.every(result => result.store.active === false))
  assert.equal(await auditCount(), count + 1)
  await assert.rejects(db.$transaction(tx => assertOperatingStore(tx, key, { lock: true })), error => error.code === 'STORE_CLOSED')
  assert.equal((await assertExistingStore(db, key)).name, renamed.store.name)
  assert.deepEqual(await businessFacts(), historicalFacts)
  assert.equal((await status(true)).changed, true)
  assert.equal((await status(true)).changed, false)
  assert.equal((await assertOperatingStore(db, key)).active, true)
  const full = await readStoreDirectory(db, { includeHistory: true })
  assert.equal(full.find(store => store.key === key).statusHistory.at(-1).active, true)
  const publicRows = await readStoreDirectory(db)
  assert(publicRows.every(store => Object.keys(store).sort().join(',') === 'active,district,key,name'))
  proofs.absoluteStatusRetries = true
})

test('native: invalid identity and non-developers cause no Store or audit writes', async () => {
  const before = [await db.store.count(), await auditCount()]
  await assert.rejects(assertExistingStore(db, 'store-missing-native'), error => error.status === 404)
  await assert.rejects(setManagedStoreStatus(db, { actor, key: 'all', active: false }), error => error.status === 404)
  await assert.rejects(setManagedStoreStatus(db, { actor, key, active: 'false' }), error => error.status === 400)
  for (const role of ['admin', 'finance', 'manager', 'staff', 'cashier']) {
    await assert.rejects(setManagedStoreStatus(db, { actor: { ...actor, role }, key, active: false }), error => error.status === 403)
    await assert.rejects(createManagedStore(db, { actor: { ...actor, role }, name: '不能创建', requestKey: `${prefix}-${role}` }), error => error.status === 403)
  }
  assert.deepEqual([await db.store.count(), await auditCount()], before)
  proofs.deniedWritesZero = true
})

for (const change of [{ role: 'staff' }, { status: 'disabled' }]) test(`native: persisted ${Object.keys(change)[0]} revocation wins before the actor lock`, async () => {
  await actorReset(); await status(true)
  const count = await auditCount(), held = deferred(), release = deferred()
  const revoke = db.$transaction(async tx => {
    await tx.user.update({ where: { id: actor.id }, data: change }); held.resolve(); await release.promise
  }, { timeout: 10000 })
  await held.promise
  const attempt = outcome(status(false))
  try { await waitForLock('SELECT id FROM "User"') } finally { release.resolve() }
  await revoke
  const result = await attempt
  assert.equal(result.error?.status, 403)
  assert.equal((await db.store.findUnique({ where: { key } })).active, true)
  assert.equal(await auditCount(), count)
  proofs[`${Object.keys(change)[0]}RevocationRespected`] = true
})

test('native: existing operating transaction finishes before disable; subsequent writes see closed', async () => {
  await actorReset(); await status(true)
  const held = deferred(), release = deferred()
  const business = db.$transaction(async tx => {
    await assertOperatingStore(tx, key, { lock: true }); held.resolve(); await release.promise
  }, { timeout: 10000 })
  await held.promise
  const closing = outcome(status(false))
  try { await waitForLock('SELECT key FROM "Store"') } finally { release.resolve() }
  await business
  assert.equal((await closing).value?.store.active, false)
  await assert.rejects(db.$transaction(tx => assertOperatingStore(tx, key, { lock: true })), error => error.code === 'STORE_CLOSED')
  proofs.operatingVsDisableSerialized = true
})

test('native: actor shared lock stays held while status waits for Store; later revocation serializes', async () => {
  await actorReset(); await status(true)
  const held = deferred(), release = deferred()
  const blocker = db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT key FROM "Store" WHERE key=$1 FOR UPDATE', key); held.resolve(); await release.promise
  }, { timeout: 10000 })
  await held.promise
  const closing = outcome(status(false)); let revoke
  try {
    await waitForLock('SELECT key FROM "Store"')
    revoke = outcome(db.user.update({ where: { id: actor.id }, data: { role: 'staff' } }))
    await waitForLock('UPDATE "public"."User"')
  } finally { release.resolve() }
  await blocker
  assert.equal((await closing).value?.store.active, false)
  assert.equal((await revoke).value?.role, 'staff')
  await assert.rejects(status(true), error => error.status === 403)
  proofs.userBeforeStoreLockOrder = true
})

test('native: audit failure rolls back creation and status change atomically', async () => {
  await actorReset()
  const failAudit = { $transaction: (callback, options) => db.$transaction(tx => callback(new Proxy(tx, { get(target, property) {
    if (property === 'sensitiveRecordAudit') return new Proxy(target[property], { get(audit, method) {
      if (method === 'create') return async () => { throw Error('SYNTHETIC_AUDIT_FAILURE') }
      const value = audit[method]; return typeof value === 'function' ? value.bind(audit) : value
    } })
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value
  } })), options) }
  const before = [await db.store.count(), await auditCount(), (await db.store.findUnique({ where: { key } })).active]
  await assert.rejects(createManagedStore(failAudit, { actor, name: `${prefix}-rollback`, requestKey: `${prefix}-rollback` }), /SYNTHETIC_AUDIT_FAILURE/)
  await assert.rejects(setManagedStoreStatus(failAudit, { actor, key, active: !before[2] }), /SYNTHETIC_AUDIT_FAILURE/)
  assert.deepEqual([await db.store.count(), await auditCount(), (await db.store.findUnique({ where: { key } })).active], before)
  proofs.auditRollbackAtomic = true
})
