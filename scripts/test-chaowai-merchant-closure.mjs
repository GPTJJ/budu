import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { createOnlineMerchantRouter } from '../server/online-merchant-api.js'
import { createOnlineRefund } from '../server/online-refund.js'
import { createOnlineFulfillment } from '../server/online-fulfillment.js'
import { signProductionGatewayRequest, gatewayBodyHash } from '../server/production-cloudbase-gateway.js'

// No DB connection, provider call, notification or external traffic. Actual
// signed loopback HTTP handlers use a transactional synthetic DB adapter.
// Lock assertions below record intent; they are not native PostgreSQL proof.
const uuid = () => crypto.randomUUID()
const gateway = { enabled: true, mode: 'production', appId: 'wx0123456789abcdef', cloudBaseEnvId: 'synthetic-env', gatewaySecret: 'synthetic-merchant-gateway-key-'.repeat(2) }
class MerchantMemory {
  constructor({ active = false, method = 'PICKUP', storeRef = 'chaowai' } = {}) {
    this.users = new Map(['customer', 'developer', 'admin', 'finance', 'staff'].map(role => [role, { id: role, role, status: 'active' }]))
    this.stores = new Map(['chaowai', 'tongying', 'guanshe', 'xidan'].map(key => [key, { key, active: key === 'chaowai' ? active : true }]))
    this.quotes = new Map([['quote', { id: 'quote', userId: 'buyer', snapshot: { namespace: 'cloudbase-miniprogram', fulfillment: method,
      commerceIntent: { storeRef }, lines: [{ productId: 'product', skuId: 'sku', name: 'Synthetic product', quantity: 1, lineAmountCents: '100', onlineEligible: true }] } }]])
    this.rows = new Map([['settlement', { id: 'settlement', quoteId: 'quote', userId: 'buyer', namespace: 'cloudbase-miniprogram', externalOrderId: 'synthetic-order',
      version: 1, status: 'PAID', currency: 'CNY', paidAt: new Date(), expiresAt: new Date(Date.now() + 600000),
      merchandiseCents: 100n, eligibleMerchandiseCents: 100n, shippingCents: 0n, totalCents: 100n, sweetCardCents: 0n, wechatCents: 100n,
      tenders: [{ id: 'tender', type: 'WECHAT', status: 'SUCCEEDED', amountCents: 100n }], compensations: [] }]])
    this.refunds = new Map(); this.authorizations = new Map(); this.outbox = new Map(); this.locks = []; this.writes = []; this.storeReads = 0; this.beforeUserLock = null; this.beforeStoreLock = null; this.identityRole = null
    const find = (map, where) => [...map.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null
    this.user = { findUnique: async ({ where }) => structuredClone(this.users.get(where.id) || null) }
    this.store = { findUnique: async ({ where }) => { this.storeReads++; return structuredClone(this.stores.get(where.key) || null) } }
    this.weChatAuthIdentity = { findUnique: async ({ where }) => {
      const id = where.provider_appId_openId?.openId?.replace('synthetic-', ''), user = this.users.get(id)
      return user ? { id: 'identity-' + id, userId: id, user: { ...user, ...(this.identityRole ? { role: this.identityRole } : {}) } } : null
    } }
    this.onlineCheckoutQuote = { findUnique: async ({ where }) => structuredClone(this.quotes.get(where.id) || null) }
    this.onlineSettlement = {
      findUnique: async ({ where }) => { const row = find(this.rows, where); return row ? { ...structuredClone(row), refunds: structuredClone([...this.refunds.values()].filter(r => r.settlementId === row.id)) } : null },
      update: async ({ where, data }) => { this.writes.push('settlement.update'); const row = this.rows.get(where.id); for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? row[key] + value.increment : value; return this.onlineSettlement.findUnique({ where }) },
    }
    const model = (map, kind, defaults) => ({
      findUnique: async ({ where }) => structuredClone(find(map, where)),
      create: async ({ data }) => { this.writes.push(kind + '.create'); const row = { ...defaults, createdAt: new Date(), ...structuredClone(data) }; map.set(row.id, row); return structuredClone(row) },
    })
    this.onlineRefund = model(this.refunds, 'refund', { status: 'PENDING' })
    this.onlineFulfillmentAuthorization = model(this.authorizations, 'authorization', {})
    this.onlineOutbox = model(this.outbox, 'outbox', {})
  }
  async $executeRaw() { return 1 }
  async $queryRaw(strings, ...values) {
    const sql = strings.join('?')
    if (sql.includes('FROM "User"') && sql.includes('FOR SHARE')) { this.locks.push('User:' + values[0]); this.beforeUserLock?.(); return [{ id: values[0] }] }
    if (sql.includes('FROM online_settlements') && sql.includes('FOR UPDATE')) { this.locks.push('settlement:' + values[0]); return [{ id: values[0] }] }
    throw Error('SYNTHETIC_SQL_UNEXPECTED')
  }
  async $queryRawUnsafe(sql, key) {
    assert.equal(sql, 'SELECT key FROM "Store" WHERE key = $1 FOR SHARE'); this.locks.push('Store:' + key); this.beforeStoreLock?.()
    return this.stores.has(key) ? [{ key }] : []
  }
  async $transaction(fn) {
    const before = structuredClone({ rows: this.rows, refunds: this.refunds, authorizations: this.authorizations, outbox: this.outbox })
    try { return await fn(this) } catch (error) { for (const [name, map] of Object.entries(before)) { this[name].clear(); for (const [key, value] of map) this[name].set(key, value) } throw error }
  }
  facts() { return structuredClone({ rows: [...this.rows.values()], refunds: [...this.refunds.values()], authorizations: [...this.authorizations.values()], outbox: [...this.outbox.values()] }) }
}
async function fixture(t, options = {}) {
  const db = new MerchantMemory(options), sync = [], logistics = []
  const app = express(); app.use(express.json())
  const mount = '/api/v2/merchant/online-checkout'
  app.use(mount, createOnlineMerchantRouter({ db, gatewayConfig: gateway,
    shippingSync: { register: async input => { assert.equal(db.authorizations.size, 1); sync.push(input); return { registered: true } } },
    logistics: { register: async input => { assert.equal(db.authorizations.size, 1); logistics.push(input); return { status: 'REGISTERED' } } },
  }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  async function send(action, actor = 'customer', extra = {}, { invalidSignature = false } = {}) {
    const body = { settlementId: 'settlement', actorOpenId: 'synthetic-' + actor, requestKey: 'original-request',
      ...(action === 'refund' ? { items: [{ productId: 'product', skuId: 'sku', quantity: 1 }], refundShipping: false, reason: 'Synthetic isolated refund' } : {}),
      ...(action === 'fulfill' ? { method: options.method || 'PICKUP', ...(options.method === 'DELIVERY' ? { carrierCode: 'SF', trackingNo: 'synthetic-tracking' } : {}) } : {}), ...extra }
    const path = mount + '/' + action, timestamp = String(Date.now()), nonce = uuid()
    const signature = signProductionGatewayRequest({ timestamp, nonce, method: 'POST', requestPath: path, bodyHash: gatewayBodyHash(body), environment: gateway.cloudBaseEnvId, appId: gateway.appId }, gateway.gatewaySecret)
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-budu-gateway-timestamp': timestamp, 'x-budu-gateway-nonce': nonce, 'x-budu-gateway-environment': gateway.cloudBaseEnvId, 'x-budu-gateway-appid': gateway.appId, 'x-budu-gateway-signature': invalidSignature ? '0'.repeat(64) : signature }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  return { db, send, sync, logistics }
}
for (const action of ['refund', 'fulfill']) {
  test(`${action}: closed PICKUP only persisted developer may create, merchant customer/admin/finance/staff cannot spoof role/store/replay`, async t => {
    for (const actor of ['customer', 'admin', 'finance', 'staff']) {
      const f = await fixture(t), before = f.db.facts()
      const result = await f.send(action, actor, { role: 'developer', storeRef: 'tongying', storeId: 'tongying', replay: true })
      assert.deepEqual(result, { status: 403, body: { ok: false, error: 'ONLINE_MERCHANT_REQUEST_FAILED' } }); assert.deepEqual(f.db.facts(), before); assert.equal(f.sync.length, 0)
    }
    const f = await fixture(t), result = await f.send(action, 'developer')
    assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.ok(f.db.locks.includes('Store:chaowai'))
    assert.equal(action === 'refund' ? [...f.db.refunds.values()][0].createdById : [...f.db.authorizations.values()][0].actorId, 'developer')
  })
  test(`${action}: active pickup stores and normal DELIVERY with closed catalogue storeRef retain merchant authority`, async t => {
    for (const storeRef of ['tongying', 'guanshe', 'xidan']) { const f = await fixture(t, { storeRef }); assert.equal((await f.send(action)).status, 200) }
    const delivery = await fixture(t, { method: 'DELIVERY' }); assert.equal((await delivery.send(action)).status, 200); assert.equal(delivery.db.storeReads, 0)
  })
  test(`${action}: original same-actor durable replay works after closure without new record or financial effect`, async t => {
    const f = await fixture(t, { active: true }); const first = await f.send(action); assert.equal(first.status, 200)
    f.db.stores.get('chaowai').active = false; const before = f.db.facts(), reads = f.db.storeReads
    const replay = await f.send(action); assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.db.facts(), before); assert.equal(f.db.storeReads, reads)
    if (action === 'fulfill') assert.equal(f.sync.length, 2)
  })
  test(`${action}: changed fingerprint, request key or settlement cannot claim closed-store replay`, async t => {
    const f = await fixture(t, { active: true }); assert.equal((await f.send(action)).status, 200); f.db.stores.get('chaowai').active = false
    const before = f.db.facts()
    const changes = action === 'refund' ? [{ reason: 'changed reason', replay: true }] : [{ requestKey: 'changed-request', replay: true }, { method: 'DELIVERY', carrierCode: 'SF', trackingNo: 'changed-tracking', replay: true }]
    for (const change of changes) assert.equal((await f.send(action, 'customer', change)).status, 403)
    const prior = [...(action === 'refund' ? f.db.refunds : f.db.authorizations).values()][0]; prior.settlementId = 'different-settlement'
    const mismatched = f.db.facts(); assert.equal((await f.send(action)).status, 403); assert.deepEqual(f.db.facts(), mismatched)
    const restoredMap = action === 'refund' ? f.db.refunds : f.db.authorizations
    restoredMap.get(prior.id).settlementId = 'settlement'; assert.deepEqual(f.db.facts(), before)
  })
  test(`${action}: original authorized cross-merchant durable replay remains legal, inactive actor still denied`, async t => {
    const f = await fixture(t, { active: true }), first = await f.send(action); assert.equal(first.status, 200)
    f.db.stores.get('chaowai').active = false; const before = f.db.facts(), reads = f.db.storeReads
    for (const actor of ['admin', 'finance', 'staff', 'developer']) {
      const replay = await f.send(action, actor); assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body)
    }
    assert.deepEqual(f.db.facts(), before); assert.equal(f.db.storeReads, reads)
    f.db.users.get('admin').status = 'disabled'; assert.equal((await f.send(action, 'admin')).status, 403)
    assert.deepEqual(f.db.facts(), before)
  })
  test(`${action}: signature and real identity precede closed check; stale developer role and revoked account cannot pass`, async t => {
    const f = await fixture(t), before = f.db.facts()
    assert.equal((await f.send(action, 'customer', {}, { invalidSignature: true })).status, 401); assert.equal(f.db.storeReads, 0)
    assert.equal((await f.send(action, 'missing')).status, 403); assert.equal(f.db.storeReads, 0)
    f.db.identityRole = 'developer'; assert.equal((await f.send(action, 'customer')).status, 403)
    f.db.beforeUserLock = () => { f.db.users.get('developer').status = 'disabled' }
    assert.equal((await f.send(action, 'developer')).status, 403); assert.deepEqual(f.db.facts(), before)
  })
  test(`${action}: closure before Store lock is rechecked; missing saved pickup ownership fails closed`, async t => {
    const f = await fixture(t, { active: true }); f.db.beforeStoreLock = () => { f.db.stores.get('chaowai').active = false }
    const before = f.db.facts(); assert.equal((await f.send(action)).status, 403); assert.deepEqual(f.db.facts(), before)
    f.db.quotes.get('quote').snapshot.commerceIntent = null; assert.equal((await f.send(action, 'developer', { storeRef: 'tongying' })).status, 409)
  })
}
test('durable fulfillment/status/logistics registration remain available after closure without inferring developer from whitelist', async t => {
  const f = await fixture(t, { active: true, method: 'DELIVERY' }); assert.equal((await f.send('fulfill')).status, 200)
  f.db.stores.get('chaowai').active = false; const before = f.db.facts()
  assert.equal((await f.send('status')).status, 200); assert.equal((await f.send('logistics', 'customer', { receiverPhone: 'synthetic-phone' })).status, 200)
  assert.equal(f.logistics.length, 1); assert.deepEqual(f.db.facts(), before)
})
test('existing generic three-argument refund authorize and fulfillment authorize callbacks remain compatible', async () => {
  const db = new MerchantMemory({ active: true }), seen = []
  const refund = createOnlineRefund(db, { authorize: async (tx, settlement, actor) => { assert.equal(actor, 'legacy-actor'); seen.push(settlement.id); return actor } })
  const input = { settlementId: 'settlement', actor: 'legacy-actor', requestKey: 'legacy-refund', items: [{ productId: 'product', skuId: 'sku', quantity: 1 }] }
  assert.equal((await refund(input)).id, (await refund(input)).id); assert.equal(db.refunds.size, 1)
  const other = new MerchantMemory({ active: true }), fulfillment = createOnlineFulfillment(other, { authorize: async (tx, { settlement }) => ({ actorId: settlement.userId }) })
  const command = { settlementId: 'settlement', requestKey: 'legacy-fulfill', method: 'PICKUP' }
  assert.equal((await fulfillment.authorize(command)).id, (await fulfillment.authorize(command)).id); assert.equal(other.authorizations.size, 1); assert.deepEqual(seen, ['settlement', 'settlement'])
})
