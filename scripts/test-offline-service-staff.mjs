// Independent HTTP authorization review for the actual employee routers.
// Authentication is supplied by synthetic actors; all records live in a new,
// loopback-only disposable PostgreSQL database. No external delivery is invoked.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

test('offline service staff HTTP permissions and old-UI compatibility', async t => {
  const databaseUrl = await createDisposablePgDatabase('offline_staff')
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ datasourceUrl: databaseUrl })
  globalThis.__buduPrisma = db
  const { v2Router } = await import('../server/v2.js')
  const { createStoreServiceStaffRouter } = await import('../server/store-service-api.js')
  const actors = Object.fromEntries([
    ['developer', 'developer', []], ['admin', 'admin', []], ['finance', 'finance', []],
    ['manager-a', 'manager', ['staff-review-a']], ['staff-a', 'staff', ['staff-review-a']],
    ['staff-b', 'staff', ['staff-review-b']], ['unbound-staff', 'staff', []],
  ].map(([key, role, storeKeys]) => [key, { id: `staff-review-${key}`, username: `staff-review-${key}`, role, status: 'active', storeKeys, permissions: {} }]))
  let server
  try {
    await db.user.createMany({ data: [...Object.values(actors).map(actor => ({ ...actor, passwordHash: 'synthetic-not-a-login' })),
      { id: 'staff-review-customer', username: 'staff-review-customer', role: 'customer', passwordHash: 'synthetic-not-a-login' }] })
    await db.store.createMany({ data: ['a', 'b'].map(key => ({ key: `staff-review-${key}`, name: `合成门店${key}`, active: true })) })
    const mailing = (id, storeKey) => ({ id, storeKey, method: '顺丰邮寄', postage: '包邮', recipient: '合成顾客',
      phone: '13800000000', address: '合成地址示例路一号', createdBy: actors.developer.username })
    await db.mailingRecord.createMany({ data: [mailing('bound-a', 'staff-review-a'), mailing('bound-b', 'staff-review-b'),
      mailing('legacy-a', 'staff-review-a'), mailing('legacy-no-store', null)] })
    await db.invoice.createMany({ data: ['a', 'b'].map(key => ({ id: `invoice-${key}`, storeKey: `staff-review-${key}`,
      companyName: '合成企业', email: 'synthetic@example.invalid', amountCents: 12900n, status: key === 'a' ? 'done' : 'pending' })) })
    const request = (id, type, storeKey, linkedBusinessRecordId) => ({ id, type, storeKey, linkedBusinessRecordId,
      createdByUserId: actors.developer.id, createdByUsername: actors.developer.username, handlerUsername: actors.developer.username,
      status: 'SUBMITTED', submittedAt: new Date(), expiresAt: new Date(Date.now() - 1000),
      customerUserId: 'staff-review-customer', customerAppId: 'wx0123456789abcdef', customerEnvId: 'synthetic-environment',
      customerOpenId: 'synthetic-openid', requestMetadata: type === 'INVOICE' ? { amountCents: 12900, category: '食品' } : { method: '顺丰邮寄', postage: '包邮' } })
    await db.customerServiceRequest.createMany({ data: [
      request('service-mail-a', 'MAILING', 'staff-review-a', 'bound-a'), request('service-mail-b', 'MAILING', 'staff-review-b', 'bound-b'),
      request('service-invoice-a', 'INVOICE', 'staff-review-a', 'invoice-a'), request('service-invoice-b', 'INVOICE', 'staff-review-b', 'invoice-b'),
    ] })
    const app = express()
    const capabilityEnv = { STORE_SERVICE_RUNTIME_ENABLED: '1', STORE_SERVICE_SUBMISSIONS_ENABLED: '1', STORE_SERVICE_QR_ENABLED: '1' }
    let capabilityConfig = { enabled: true, mode: 'test' }
    app.use('/capability-review', createStoreServiceStaffRouter({ db, env: capabilityEnv, configLoader: () => {
      if (capabilityConfig instanceof Error) throw capabilityConfig
      return capabilityConfig
    } }))
    app.use(express.json())
    app.use('/api/v2', (req, res, next) => {
      req.user = actors[req.get('x-synthetic-actor')]
      if (!req.user) return res.status(401).json({ error: 'SYNTHETIC_ACTOR_REQUIRED' })
      next()
    }, createStoreServiceStaffRouter({ db, env: {} }), v2Router)
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
    const call = async (actor, path, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'x-synthetic-actor': actor, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    }
    await t.test('actual mailing list only returns assigned stores despite manipulated filter', async () => {
      for (const path of ['/mailing-records', '/mailing-records?store=staff-review-b', '/mailing-records?storeKey=staff-review-b']) {
        const result = await call('staff-a', path)
        assert.equal(result.status, 200)
        assert.deepEqual(result.body.rows.map(row => row.id).sort(), ['bound-a', 'legacy-a'])
        assert.ok(result.body.rows.every(row => row.storeKey === 'staff-review-a'))
      }
      assert.equal((await call('unbound-staff', '/mailing-records')).body.rows.length, 0)
      assert.equal((await call('developer', '/mailing-records')).body.rows.length, 4)
    })
    await t.test('mailing list exposes stable association only for the permitted records', async () => {
      const result = await call('staff-a', '/mailing-records')
      const bound = result.body.rows.find(row => row.id === 'bound-a'), legacy = result.body.rows.find(row => row.id === 'legacy-a')
      assert.equal(bound.serviceRequestId, 'service-mail-a'); assert.equal(bound.customerBound, true)
      assert.equal(legacy.serviceRequestId, null); assert.equal(legacy.customerBound, false)
      assert.ok(!JSON.stringify(result.body).includes('synthetic-openid'))
    })
    await t.test('old ship API rejects bound applications for every employee role without side effects', async () => {
      for (const actor of ['developer', 'admin', 'finance', 'manager-a', 'staff-a']) {
        const result = await call(actor, '/mailing-records/bound-a/ship', {})
        assert.equal(result.status, 409)
      }
      assert.equal((await db.mailingRecord.findUnique({ where: { id: 'bound-a' } })).status, 'pending')
      assert.equal(await db.storeServiceDelivery.count(), 0)
      assert.equal(await db.storeServiceAudit.count(), 0)
    })
    await t.test('old unbound ship API preserves own-store handling and rejects other stores', async () => {
      assert.equal((await call('staff-a', '/mailing-records/bound-b/ship', {})).status, 403)
      assert.equal((await call('staff-a', '/mailing-records/legacy-a/ship', {})).status, 200)
      assert.equal((await db.mailingRecord.findUnique({ where: { id: 'legacy-a' } })).status, 'shipped')
      assert.equal(await db.storeServiceDelivery.count(), 0)
    })
    await t.test('staff can inspect own invoice service, but cross-store IDs return 403', async () => {
      const own = await call('staff-a', '/customer-requests/service-invoice-a/service')
      assert.equal(own.status, 200); assert.equal(own.body.request.id, 'service-invoice-a')
      assert.equal(own.body.invoice.status, 'done'); assert.equal(own.body.request.receiptConfirmedAt, null)
      assert.equal((await call('staff-a', '/customer-requests/service-invoice-b/service')).status, 403)
      assert.equal((await call('staff-b', '/customer-requests/service-invoice-a/service')).status, 403)
      assert.equal((await call('unbound-staff', '/customer-requests/service-invoice-a/service')).status, 403)
    })
    await t.test('non-developers cannot confirm even with correct store, payload or forged role fields', async () => {
      for (const actor of ['admin', 'finance', 'manager-a', 'staff-a']) {
        assert.equal((await call(actor, '/customer-requests/service-mail-a/confirm-shipment', { carrier: '顺丰速运', trackingNo: 'SF000000001', role: 'developer' })).status, 403)
        assert.equal((await call(actor, '/customer-requests/service-invoice-a/confirm-receipt', { role: 'developer' })).status, 403)
      }
      assert.equal(await db.storeServiceDelivery.count(), 0)
      assert.equal(await db.storeServiceAudit.count(), 0)
    })
    await t.test('developer confirmations match the UI contract and keep existing done invoice', async () => {
      assert.equal((await call('developer', '/customer-requests/service-mail-a/confirm-shipment', { carrier: '顺丰速运', trackingNo: 'SF000000001' })).status, 200)
      assert.equal((await call('developer', '/customer-requests/service-invoice-a/confirm-receipt', {})).status, 200)
      const mailingDetail = await call('developer', '/customer-requests/service-mail-a/service')
      assert.ok(mailingDetail.body.request.shipmentConfirmedAt)
      assert.equal(mailingDetail.body.request.carrier, '顺丰速运'); assert.equal(mailingDetail.body.request.trackingNo, 'SF000000001')
      assert.equal(mailingDetail.body.request.notifications[0].status, 'BLOCKED_CONFIG')
      const invoiceDetail = await call('developer', '/customer-requests/service-invoice-a/service')
      assert.ok(invoiceDetail.body.request.receiptConfirmedAt); assert.equal(invoiceDetail.body.invoice.status, 'done')
      assert.equal(await db.storeServiceDelivery.count(), 2); assert.equal(await db.storeServiceAudit.count(), 2)
    })
    await t.test('staff capabilities do not advertise a QR before runtime, safe config and release path are ready', async () => {
      const read = async () => (await fetch(`http://127.0.0.1:${server.address().port}/capability-review/customer-requests/service-capabilities`)).json()
      capabilityEnv.STORE_SERVICE_RUNTIME_ENABLED = '0'
      assert.equal((await read()).qrEnabled, false)
      capabilityEnv.STORE_SERVICE_RUNTIME_ENABLED = '1'; capabilityConfig = null
      assert.equal((await read()).qrEnabled, false)
      capabilityConfig = new Error('synthetic invalid configuration')
      assert.equal((await read()).qrEnabled, false)
      capabilityConfig = { enabled: true, mode: 'production' }; capabilityEnv.APP_ENV = 'prod'
      assert.equal((await read()).qrEnabled, false)
      capabilityEnv.STORE_SERVICE_RELEASE_PATH_READY = '1'
      assert.equal((await read()).qrEnabled, true)
    })
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await db.$disconnect()
    await dropDisposablePgDatabase(databaseUrl)
  }
})
