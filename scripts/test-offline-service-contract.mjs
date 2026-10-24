import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import express from 'express'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'
import { serviceConversion, serviceReportRange } from '../server/store-service-conversion.js'
import { serviceTemplates, createServiceWechatSender } from '../server/store-service-notifications.js'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'
const uuid = () => crypto.randomUUID()
const appId = 'wxfce0a3c4bb430023', envId = 'budu-test-d8gwb4xwy41dc6c61'
const secret = 'synthetic-gateway-key-never-production-12345'
const markerKey = 'synthetic-session-marker-never-production'
const DEV = { id: 'http-dev', username: 'http-dev', role: 'developer', status: 'active', storeKeys: [], permissions: {} }
const require = createRequire(import.meta.url)
const mpRoot = process.env.OFFLINE_SERVICE_MP_REPO
if (!mpRoot) throw Error('OFFLINE_SERVICE_MP_REPO_REQUIRED')
const { createServiceRequestHandler } = require(mpRoot + '/cloudfunctions/orders/service-request-handler.js')
const { createServiceRequestTransport } = require(mpRoot + '/cloudfunctions/orders/service-request-transport.js')

test('real PostgreSQL + real HTTP + companion MiniProgram gateway contract', async t => {
  const url = await createDisposablePgDatabase('offline_http')
  process.env.DATABASE_URL = url
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ datasourceUrl: url }); globalThis.__buduPrisma = db
  const { createStoreServiceCustomerRouter, createStoreServiceStaffRouter, generateStoreServiceCode } = await import('../server/store-service-api.js')
  const { createCustomerSession } = await import('../server/customer-auth.js')
  const { createCustomerServiceRequest } = await import('../server/customer-requests.js')
  const { confirmService } = await import('../server/store-service-core.js')
  const config = { enabled: true, mode: 'test', appId, cloudBaseEnvId: envId, gatewaySecret: secret, markerKey, appSecret: 'synthetic-app-secret' }
  const env = { STORE_SERVICE_SUBMISSIONS_ENABLED: '1', STORE_SERVICE_RUNTIME_ENABLED: '1', STORE_SERVICE_QR_ENABLED: '1' }
  await db.user.createMany({ data: [{ ...DEV, passwordHash: 'synthetic' }, ...['a', 'b'].map(id => ({ id: `http-${id}`, username: `http-${id}`, role: 'customer', passwordHash: 'synthetic' }))] })
  await db.store.create({ data: { key: 'http-store', name: '合成门店' } })
  await db.weChatAuthIdentity.createMany({ data: ['a', 'b'].map(id => ({ id: uuid(), userId: `http-${id}`, openId: `synthetic-${id}`, provider: 'WECHAT_MINIPROGRAM', appId })) })
  const sessions = {}
  for (const id of ['a', 'b']) sessions[id] = (await createCustomerSession({ userId: `http-${id}`, markerKey, db })).rawToken
  const app = express(), prefix = '/api/v2/test-sc11a/customer/store-services'
  app.use(prefix, express.json(), createStoreServiceCustomerRouter({ db, config, env, deliverInternal: false }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const port = server.address().port
  const request = (options, callback) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port }, callback)
  const handler = id => {
    const context = { OPENID: `synthetic-${id}`, APPID: appId, ENV: envId }
    return createServiceRequestHandler({ context, send: createServiceRequestTransport({ context, env: { TCB_ENV: envId, STORE_SERVICE_TEST_GATEWAY_SECRET: secret } }, { request }) })
  }
  const a = handler('a'), b = handler('b')
  const call = (client, id, action, args = {}) => client({ action, customerSession: sessions[id], ...args })
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(140)])
  let generatedScene = '', providerCalls = 0
  const qrFetch = async (endpoint, input) => {
    providerCalls++
    if (endpoint.includes('stable_token')) return { ok: true, json: async () => ({ access_token: 'synthetic-token', expires_in: 7200 }) }
    const body = JSON.parse(input.body); generatedScene = body.scene
    assert.equal(body.page, 'pages/store-service/form'); assert.equal(body.env_version, 'develop')
    return { ok: true, arrayBuffer: async () => png }
  }
  try {
    const f = await createCustomerServiceRequest({ prismaClient: db, user: DEV, origin: 'https://synthetic.invalid', input: { type: 'INVOICE', storeKey: 'http-store', amountCents: 1200, category: '食品' } })
    await t.test('QR off fails closed without contacting provider; TEST QR is developer-only', async () => {
      await assert.rejects(generateStoreServiceCode({ db, requestId: f.request.id, user: DEV, config, env: {}, fetchImpl: qrFetch }), { status: 503 })
      assert.equal(providerCalls, 0)
      await assert.rejects(generateStoreServiceCode({ db, requestId: f.request.id, user: { ...DEV, role: 'admin' }, config, env, fetchImpl: qrFetch }), { status: 403 })
    })
    await generateStoreServiceCode({ db, requestId: f.request.id, user: DEV, config, env, fetchImpl: qrFetch })
    const scene = generatedScene
    await generateStoreServiceCode({ db, requestId: f.request.id, user: DEV, config, env, fetchImpl: qrFetch })
    assert.equal(generatedScene, scene, 'QR retries preserve the same unconsumed scene')
    await t.test('official QR adapter sends bounded random scene and stores only hash', async () => {
      assert.match(scene, /^[a-f0-9]{32}$/)
      const stored = await db.customerServiceRequestToken.findFirst({ where: { requestId: f.request.id } })
      assert.equal(stored.miniSceneHash, crypto.createHash('sha256').update(scene).digest('hex'))
      assert.ok(!JSON.stringify(stored).includes(scene))
    })
    await t.test('unsigned, cross-user, expired session and forged identity fail closed', async () => {
      const unsigned = await fetch(`http://127.0.0.1:${port}${prefix}/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(unsigned.status, 401)
      const mismatch = await b({ action: 'serviceList', customerSession: sessions.a })
      assert.equal(mismatch.ok, false); assert.equal(mismatch.code, 'CUSTOMER_SESSION_DENIED')
      const forged = await call(a, 'a', 'serviceResolve', { scene, openId: 'synthetic-b', storeKey: 'evil', userId: 'http-b' })
      assert.equal(forged.ok, true); assert.equal(forged.result.request.storeKey, 'http-store')
      assert.ok(!JSON.stringify(forged).includes(DEV.username))
    })
    await t.test('new customer with zero orders submits, gets immediate receipt, and owns it by verified session', async () => {
      const result = await call(a, 'a', 'serviceSubmit', { scene, payload: { confirmedAccurate: true, titleType: 'PERSONAL', invoiceTitle: '合成个人', email: 'test@example.invalid' }, subscription: { status: 'reject' } })
      assert.equal(result.ok, true); assert.equal(result.result.requestId, f.request.id)
      assert.equal(await db.onlineSettlement.count(), 0)
      const detail = await call(a, 'a', 'serviceDetail', { requestId: f.request.id })
      assert.equal(detail.result.invoice.status, 'pending'); assert.equal(detail.result.invoice.receivedAt, null)
      assert.equal((await call(b, 'b', 'serviceDetail', { requestId: f.request.id })).code, 'SERVICE_NOT_FOUND')
      assert.equal((await call(b, 'b', 'serviceResolve', { scene })).code, 'SERVICE_CODE_USED')
    })
    await t.test('admissions OFF preserves recovery/list/detail/mall and does not create new records', async () => {
      env.STORE_SERVICE_SUBMISSIONS_ENABLED = '0'
      assert.equal((await call(a, 'a', 'serviceSubmit', { scene, payload: {} })).result.requestId, f.request.id)
      assert.equal((await call(a, 'a', 'serviceList')).result.rows.length, 1)
      assert.equal((await call(a, 'a', 'serviceCapabilities')).result.enabled, false)
      assert.equal((await call(a, 'a', 'serviceVisitMall', { requestId: f.request.id })).ok, true)
      await call(a, 'a', 'serviceVisitMall', { requestId: f.request.id })
      assert.equal(await db.storeServiceVisit.count({ where: { requestId: f.request.id, event: 'MALL' } }), 1)
    })
    await t.test('independent receipt fact preserves existing done invoice and hides employee identity from customer', async () => {
      const row = await db.customerServiceRequest.findUnique({ where: { id: f.request.id } })
      await db.invoice.update({ where: { id: row.linkedBusinessRecordId }, data: { status: 'done' } })
      await confirmService(db, { requestId: f.request.id, user: DEV, action: 'receipt' })
      const detail = await call(a, 'a', 'serviceDetail', { requestId: f.request.id })
      assert.equal(detail.result.invoice.status, 'done'); assert.ok(detail.result.invoice.receivedAt)
      assert.ok(!JSON.stringify(detail).includes(DEV.username))
      assert.equal(detail.result.notification.status, 'BLOCKED_CONFIG')
    })
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.$disconnect(); await dropDisposablePgDatabase(url)
  }
})

test('attribution uses global latest source, verified provider time, cumulative exact windows, dedupe and settled refunds', () => {
  const at = s => new Date(s), start = at('2026-10-01T00:00:00Z')
  const r = (id, day, storeKey = 'a') => ({ id, customerUserId: 'customer', status: 'SUBMITTED', submittedAt: new Date(+start + day * 86400000), storeKey, type: 'MAILING' })
  const p = (id, day, extra = {}) => ({ id, userId: 'customer', status: 'PAID', paidAt: new Date(+start + day * 86400000), totalCents: 100n, wechatCents: 0n, ...extra })
  const requests = [r('first', 0), r('latest', 1, 'b')]
  const pay = p('order', 8, { refunds: [{ status: 'SETTLED', totalCents: 20n, settledAt: at('2026-10-10') }, { status: 'PENDING', totalCents: 30n }] })
  const payments = [pay, pay, p('before', -1), p('after7', 8.00001), p('exact30', 31), p('after30', 31.00001), p('delayed', 3, { wechatCents: 100n, tenders: [{ type: 'WECHAT', providerSuccessAt: at('2026-09-30') }] })]
  const range = { start, end: at('2026-10-03'), storeKey: '', type: '' }, now = at('2026-11-15')
  const result = serviceConversion({ requests, visits: [], payments, range, now })
  assert.equal(result.windows[0].orders, 1); assert.equal(result.windows[0].paidCents, '100'); assert.equal(result.windows[0].refundCents, '20')
  assert.equal(result.windows[1].orders, 3); assert.equal(result.windows[1].paidCents, '300')
  assert.equal(serviceConversion({ requests, visits: [], payments, range: { ...range, storeKey: 'a' }, now }).windows[1].orders, 0)
  assert.equal(serviceConversion({ requests, visits: [], payments, range: { ...range, storeKey: 'b' }, now }).windows[1].orders, 3)
  assert.equal(result.windows[0].returningCustomers, 1); assert.equal(result.windows[0].firstPurchaseCustomers, null)
  assert.throws(() => serviceReportRange({ from: '2026-02-30', to: '2026-03-02' }), { status: 400 })
  assert.throws(() => serviceReportRange({ from: ['2026-10-01'], to: '2026-10-02' }), { status: 400 })
  assert.equal(+serviceReportRange({ from: '2026-10-01', to: '2026-10-01' }).start, +at('2026-09-30T16:00:00Z'))
})

test('sender distinguishes platform acceptance, permission rejection, definite config error and ambiguous network; no fabricated templates', async () => {
  const template = { id: 'synthetic-template-received', verified: true, semantic: 'INVOICE_RECEIVED', fields: { thing1: 'storeName', phrase2: 'status' } }
  const templates = serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ INVOICE: template }) })
  assert.equal(serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ INVOICE: { ...template, semantic: 'INVOICE_ISSUED' } }) }).INVOICE, undefined)
  const config = { enabled: true, appId, appSecret: 'synthetic', cloudBaseEnvId: envId }
  const d = { templateId: template.id, event: 'INVOICE_RECEIVED', openId: 'synthetic-a', appId, envId }
  const r = { id: 'csr-' + uuid(), type: 'INVOICE' }
  for (const [response, expected] of [[0, 'ACCEPTED'], [43101, 'NO_PERMISSION'], [47003, 'BLOCKED_CONFIG'], [40003, 'FAILED'], [null, 'UNKNOWN']]) {
    _resetMiniprogramTokenAuthority()
    let sends = 0
    const send = createServiceWechatSender({ config, templates, envVersion: 'developer', fetchImpl: async (url, input) => {
      if (url.includes('stable_token')) return { ok: true, json: async () => ({ access_token: 'synthetic-token', expires_in: 7200 }) }
      sends++; const message = JSON.parse(input.body)
      assert.equal(message.data.phrase2.value, '已收到'); assert.equal(message.page, `pages/store-service/detail?id=${r.id}`)
      if (response === null) throw Error('synthetic timeout after request write')
      return { ok: true, json: async () => ({ errcode: response }) }
    } })
    assert.equal((await send(d, r, '合成门店')).status, expected); assert.equal(sends, 1)
  }
})
