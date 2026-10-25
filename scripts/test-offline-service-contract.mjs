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
const testPublicPrefix = '/api/v2/test-sc11a'
const servicePath = '/customer/store-services'
const productionEnvId = 'budu-d6gz358ixe39faf43'
const listenLocal = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server) })
})
const closeLocal = async server => {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
const requestLocal = (port, { path, method = 'POST', body = {}, headers = {} }) => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify(body))
  const request = http.request({ hostname: '127.0.0.1', port, path, method,
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('error', reject)
    response.on('end', () => {
      let decoded = null
      try { decoded = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* unmatched routes may return HTML */ }
      resolve({ status: response.statusCode, body: decoded })
    })
  })
  request.on('error', reject)
  request.setTimeout(5000, () => request.destroy(Error('LOCAL_CONTRACT_HTTP_TIMEOUT')))
  request.end(payload)
})

// Reproduce only the observed location/proxy_pass prefix replacement. This is
// not a model of Nginx URI normalization: ambiguous paths below are the exact
// non-canonical bytes that reach Express, never client-supplied URL headers.
function createTestPrefixProxy(upstreamPort, forwarded) {
  return http.createServer((request, response) => {
    if (!request.url.startsWith(testPublicPrefix + '/')) { response.writeHead(404); response.end(); return }
    const path = '/api/' + request.url.slice(testPublicPrefix.length + 1)
    const headers = { ...request.headers, 'x-budu-test-gateway': '1' }
    forwarded.push({ path, method: request.method, testGateway: headers['x-budu-test-gateway'] })
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path, method: request.method, headers }, result => {
      response.writeHead(result.statusCode, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    upstream.setTimeout(5000, () => upstream.destroy(Error('LOCAL_CONTRACT_PROXY_TIMEOUT')))
    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  })
}

test('real PostgreSQL + real HTTP + companion MiniProgram gateway contract', async t => {
  const url = await createDisposablePgDatabase('offline_http')
  process.env.DATABASE_URL = url
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ datasourceUrl: url }); globalThis.__buduPrisma = db
  const { createStoreServiceRuntime, generateStoreServiceCode } = await import('../server/store-service-api.js')
  const { createWechatTestLoginRouter } = await import('../server/wechat-test-login.js')
  const { createCustomerSession } = await import('../server/customer-auth.js')
  const { createCustomerServiceRequest } = await import('../server/customer-requests.js')
  const { confirmService } = await import('../server/store-service-core.js')
  const config = { enabled: true, mode: 'test', appId, cloudBaseEnvId: envId, gatewaySecret: secret, markerKey, appSecret: 'synthetic-app-secret' }
  const env = { STORE_SERVICE_SUBMISSIONS_ENABLED: '1', STORE_SERVICE_RUNTIME_ENABLED: '1', STORE_SERVICE_QR_ENABLED: '1', STORE_SERVICE_SEND_ENABLED: '0' }
  await db.user.createMany({ data: [{ ...DEV, passwordHash: 'synthetic' }, ...['a', 'b'].map(id => ({ id: `http-${id}`, username: `http-${id}`, role: 'customer', passwordHash: 'synthetic' }))] })
  await db.store.create({ data: { key: 'http-store', name: '合成门店' } })
  await db.weChatAuthIdentity.createMany({ data: ['a', 'b'].map(id => ({ id: uuid(), userId: `http-${id}`, openId: `synthetic-${id}`, provider: 'WECHAT_MINIPROGRAM', appId })) })
  const sessions = {}
  for (const id of ['a', 'b']) sessions[id] = (await createCustomerSession({ userId: `http-${id}`, markerKey, db })).rawToken
  const app = express(), prefix = testPublicPrefix + servicePath, forwarded = []
  const noProvider = async () => { throw Error('EXTERNAL_PROVIDER_FORBIDDEN_IN_CONTRACT_TEST') }
  const runtime = createStoreServiceRuntime({ db, config, env, deliverInternal: false, fetchImpl: noProvider })
  runtime.mount(app)
  app.use('/api/customer/auth/wechat', express.json(), createWechatTestLoginRouter({ db, configLoader: () => config, exchange: noProvider }))
  const server = await listenLocal(http.createServer(app))
  const proxy = await listenLocal(createTestPrefixProxy(server.address().port, forwarded))
  const port = proxy.address().port
  const handler = (id, targetPort = port, environment = envId) => {
    const context = { OPENID: `synthetic-${id}`, APPID: appId, ENV: environment }
    const request = (options, callback) => {
      assert.equal(options.hostname, 'buducandy.cn'); assert.equal(options.protocol, 'https:')
      return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: targetPort }, callback)
    }
    const secretName = environment === envId ? 'STORE_SERVICE_TEST_GATEWAY_SECRET' : 'SWEET_CARD_PRODUCTION_GATEWAY_SECRET'
    return createServiceRequestHandler({ context, send: createServiceRequestTransport({ context, env: { TCB_ENV: environment, [secretName]: secret } }, { request }) })
  }
  const a = handler('a'), b = handler('b')
  const call = (client, id, action, args = {}) => client({ action, customerSession: sessions[id], ...args })
  const authBody = { sessionHash: crypto.createHash('sha256').update(sessions.a).digest('hex'), openId: 'synthetic-a' }
  const signed = ({ path = prefix + '/list', signedPath = path, method = 'POST', body = authBody,
    environment = envId, signedAppId = appId, timestamp = String(Date.now()), nonce = crypto.randomBytes(24).toString('base64url'), headers = {} } = {}) => {
    const fields = ['v1', timestamp, nonce, method, signedPath, crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'), environment, signedAppId]
    return { path, method, body, headers: { authorization: 'Bearer ' + sessions.a, 'x-budu-gateway-timestamp': timestamp,
      'x-budu-gateway-nonce': nonce, 'x-budu-gateway-environment': environment, 'x-budu-gateway-appid': signedAppId,
      'x-budu-gateway-signature': crypto.createHmac('sha256', secret).update(fields.join('\n')).digest('base64url'), ...headers } }
  }
  const businessSnapshot = () => Promise.all(['customerServiceRequest', 'customerServiceRequestToken', 'invoice', 'mailingRecord',
    'notification', 'notificationDelivery', 'storeServiceAudit', 'storeServiceDelivery', 'storeServiceVisit', 'onlineSettlement']
    .map(model => db[model].findMany({ orderBy: { id: 'asc' } })))
  const assertDenied = async (input, targetPort = port) => {
    const result = await requestLocal(targetPort, input)
    assert.ok([400, 401, 403, 404].includes(result.status), `must reject ${input.method || 'POST'} ${input.path}; received ${result.status}`)
    assert.notEqual(result.body?.ok, true)
  }
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
    await t.test('actual TEST runtime mount accepts public signatures after the established prefix rewrite', async () => {
      const capabilities = await call(a, 'a', 'serviceCapabilities')
      assert.equal(capabilities.ok, true); assert.equal(capabilities.result.enabled, true)
      const list = await call(a, 'a', 'serviceList')
      assert.equal(list.ok, true); assert.deepEqual(list.result.rows, [])
      assert.deepEqual(forwarded.slice(-2), [
        { path: '/api' + servicePath + '/capabilities', method: 'POST', testGateway: '1' },
        { path: '/api' + servicePath + '/list', method: 'POST', testGateway: '1' },
      ])
    })
    await t.test('existing TEST login session verification coexists at its unchanged internal mount', async () => {
      const previousAppEnv = process.env.APP_ENV
      process.env.APP_ENV = 'test'
      try {
        const before = await businessSnapshot()
        const result = await requestLocal(port, { path: testPublicPrefix + '/customer/auth/wechat/session/verify',
          headers: { authorization: 'Bearer ' + sessions.a } })
        assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.ok(result.body.customerRef)
        assert.equal(forwarded.at(-1).path, '/api/customer/auth/wechat/session/verify')
        await assertDenied({ path: '/api/customer/auth/wechat/session/verify', headers: { authorization: 'Bearer ' + sessions.a } }, server.address().port)
        assert.deepEqual(await businessSnapshot(), before)
      } finally {
        if (previousAppEnv === undefined) delete process.env.APP_ENV
        else process.env.APP_ENV = previousAppEnv
      }
    })
    await t.test('actual production runtime mount retains the public production path and signed transport', async () => {
      const productionApp = express()
      const productionRuntime = createStoreServiceRuntime({ db, config: { ...config, mode: 'production', cloudBaseEnvId: productionEnvId },
        env, deliverInternal: false, fetchImpl: noProvider })
      productionRuntime.mount(productionApp)
      const productionServer = await listenLocal(http.createServer(productionApp))
      try {
        const productionPort = productionServer.address().port, productionClient = handler('a', productionPort, productionEnvId)
        const before = await businessSnapshot()
        assert.equal((await call(productionClient, 'a', 'serviceCapabilities')).result.enabled, true)
        assert.deepEqual((await call(productionClient, 'a', 'serviceList')).result.rows, [])
        await assertDenied(signed({ path: '/api' + servicePath + '/list', signedPath: '/api/v2' + servicePath + '/list', environment: productionEnvId }), productionPort)
        await assertDenied(signed({ path: prefix + '/list', environment: productionEnvId }), productionPort)
        await assertDenied(signed({ path: '/api/v2' + servicePath + '/list', environment: envId }), productionPort)
        assert.deepEqual(await businessSnapshot(), before)
      } finally { productionRuntime.stop(); await closeLocal(productionServer) }
    })
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
    await t.test('internal signatures and forged URL headers cannot authorize requests or mutate business facts', async () => {
      const before = await businessSnapshot()
      const forwardedHeaders = { 'original-url': prefix + '/list', 'x-original-url': prefix + '/list',
        'x-original-uri': prefix + '/list', 'x-forwarded-uri': prefix + '/list', 'x-rewrite-url': prefix + '/list',
        'x-forwarded-prefix': testPublicPrefix, 'x-budu-test-gateway': '1' }
      await assertDenied(signed({ signedPath: '/api' + servicePath + '/list' }))
      await assertDenied(signed({ signedPath: prefix + '/capabilities' }))
      await assertDenied(signed({ signedPath: '/api' + servicePath + '/list', headers: forwardedHeaders }))
      await assertDenied(signed({ headers: { ...forwardedHeaders, 'x-budu-gateway-signature': 'A'.repeat(43) } }))
      await assertDenied(signed({ path: prefix + '/unknown', signedPath: prefix + '/list', headers: forwardedHeaders }))
      await assertDenied(signed({ path: prefix + '/submit', body: { ...authBody, scene,
        payload: { confirmedAccurate: true, titleType: 'PERSONAL', invoiceTitle: '不得写入', email: 'denied@example.invalid' } },
        headers: { ...forwardedHeaders, 'x-budu-gateway-signature': 'A'.repeat(43) } }))
      await assertDenied(signed({ path: '/api' + servicePath + '/list' }), server.address().port)
      await assertDenied(signed(), server.address().port)
      assert.deepEqual(await businessSnapshot(), before)
    })
    await t.test('TEST gateway rejects missing signatures, foreign scope, stale timestamps and nonce replay', async () => {
      const before = await businessSnapshot()
      await assertDenied({ path: prefix + '/list', body: authBody, headers: { authorization: 'Bearer ' + sessions.a } })
      await assertDenied(signed({ signedAppId: 'wx0000000000000000' }))
      await assertDenied(signed({ environment: productionEnvId }))
      await assertDenied(signed({ timestamp: String(Date.now() - 600000) }))
      await assertDenied(signed({ timestamp: String(Date.now() + 600000) }))
      const replay = signed()
      await assertDenied({ ...replay, headers: { ...replay.headers, 'x-budu-gateway-signature': 'A'.repeat(43) } })
      const first = await requestLocal(port, replay)
      assert.equal(first.status, 200); assert.equal(first.body.ok, true)
      await assertDenied(replay)
      assert.deepEqual(await businessSnapshot(), before)
    })
    await t.test('non-canonical paths arriving at the backend and non-POST methods fail closed', async () => {
      const before = await businessSnapshot()
      const paths = ['/list?extra=1', '/list?', '/list/', '//list', '/LIST', '/%6cist', '/list%2f', '/%2e/list', '/list%3fextra=1']
      for (const suffix of paths) {
        // Both a signature over the non-canonical public spelling and one over
        // the intended canonical action must fail for these backend paths.
        const path = prefix + suffix
        await assertDenied(signed({ path }))
        await assertDenied(signed({ path, signedPath: prefix + '/list', headers: {
          'original-url': prefix + '/list', 'x-original-url': prefix + '/list', 'x-forwarded-prefix': testPublicPrefix } }))
      }
      await assertDenied(signed({ method: 'GET' }))
      await assertDenied(signed({ method: 'PUT' }))
      assert.deepEqual(await businessSnapshot(), before)
    })
    await t.test('unsigned, cross-user, expired session and forged identity fail closed', async () => {
      const unsigned = await requestLocal(port, { path: prefix + '/list' })
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
    await t.test('signed companion resolves exactly one method template and submit ignores forged methods and template configuration', async () => {
      const definitions = {
        MAILING_EXPRESS: { id: 'synthetic-http-express-template', verified: true, semantic: 'SHIPMENT_CONFIRMED', fields: {
          character_string5: 'trackingNo', thing20: 'carrier', thing13: 'shipmentNote', time9: 'shipmentConfirmedAt' } },
        MAILING_FLASH: { id: 'synthetic-http-flash-template', verified: true, semantic: 'SHIPMENT_CONFIRMED', fields: {
          thing20: 'carrier', time9: 'shipmentConfirmedAt', thing13: 'shipmentNote' } },
        INVOICE: { id: 'synthetic-http-invoice-template', verified: true, semantic: 'INVOICE_RECEIVED', fields: {
          thing2: 'invoiceTitle', amount3: 'amount', time4: 'submittedAt', thing5: 'invoiceReceivedNote' } },
      }
      const modernEnv = { ...env, STORE_SERVICE_SUBMISSIONS_ENABLED: '1', STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify(definitions) }
      const modernApp = express(), modernRuntime = createStoreServiceRuntime({ db, config, env: modernEnv, deliverInternal: false, fetchImpl: noProvider })
      modernRuntime.mount(modernApp)
      const modernServer = await listenLocal(http.createServer(modernApp)), modernForwarded = []
      const modernProxy = await listenLocal(createTestPrefixProxy(modernServer.address().port, modernForwarded))
      const customer = handler('a', modernProxy.address().port), other = handler('b', modernProxy.address().port)
      try {
        assert.equal((await call(customer, 'a', 'serviceCapabilities')).result.templateIds.MAILING, '')
        for (const [kind, wrong] of [['MAILING_EXPRESS', false], ['MAILING_FLASH', false], ['INVOICE', false], ['MAILING_EXPRESS', true]]) {
          const type = kind === 'INVOICE' ? 'INVOICE' : 'MAILING', flash = kind === 'MAILING_FLASH'
          const created = await createCustomerServiceRequest({ prismaClient: db, user: DEV, origin: 'https://synthetic.invalid', input: {
            type, storeKey: 'http-store', ...(type === 'INVOICE' ? { amountCents: 1200, category: '食品' }
              : { method: flash ? '同城闪送' : '顺丰邮寄', postage: '包邮', shippingTier: 'STANDARD' }) } })
          await generateStoreServiceCode({ db, requestId: created.request.id, user: DEV, config, env: modernEnv, fetchImpl: qrFetch })
          const currentScene = generatedScene
          const resolved = await call(customer, 'a', 'serviceResolve', { scene: currentScene, method: 'forged', templateId: 'forged' })
          assert.equal(resolved.ok, true); assert.equal(resolved.result.subscriptionTemplateId, definitions[kind].id)
          const provided = wrong ? definitions.MAILING_FLASH.id : definitions[kind].id
          const payload = type === 'INVOICE'
            ? { titleType: 'PERSONAL', invoiceTitle: '合成HTTP个人抬头', email: 'http@example.invalid', confirmedAccurate: true }
            : { recipient: '合成HTTP收件人', phone: '13800000000', address: '合成HTTP测试地址一号', confirmedAccurate: true,
              method: flash ? '顺丰邮寄' : '同城闪送', carrier: 'forged' }
          const saved = await call(customer, 'a', 'serviceSubmit', { scene: currentScene, payload,
            method: 'forged', subscriptionTemplates: { INVOICE: { id: 'forged' } }, subscription: { status: 'accept', templateId: provided } })
          assert.equal(saved.ok, true); assert.equal(saved.result.requestId, created.request.id)
          const row = await db.customerServiceRequest.findUnique({ where: { id: created.request.id } })
          assert.equal(row.subscriptionTemplateId, provided); assert.equal(row.subscriptionChoice, wrong ? 'unavailable' : 'accept')
          assert.equal(row.requestMetadata.subscriptionValidation.matched, !wrong)
          const detail = await call(customer, 'a', 'serviceDetail', { requestId: row.id })
          assert.equal(detail.ok, true)
          if (type === 'MAILING') assert.equal(detail.result.mailing.method, flash ? '同城闪送' : '顺丰邮寄')
          else assert.equal(detail.result.invoice.status, 'pending')
          assert.equal((await call(other, 'b', 'serviceDetail', { requestId: row.id })).code, 'SERVICE_NOT_FOUND')
          await confirmService(db, { requestId: row.id, user: DEV, action: type === 'INVOICE' ? 'receipt' : 'shipment',
            templates: serviceTemplates(modernEnv), input: { carrier: '合成承运', trackingNo: 'SYNTHETICHTTP123', deliveryProof: '合成HTTP配送凭证' } })
          const notification = await db.storeServiceDelivery.findFirst({ where: { requestId: row.id } })
          assert.equal(notification.templateId, provided); assert.equal(notification.status, wrong ? 'BLOCKED_CONFIG' : 'PENDING')
          assert.equal(notification.userId, 'http-a'); assert.equal(notification.openId, 'synthetic-a')
          assert.equal(notification.attempts, 0)
          assert.equal((await call(customer, 'a', 'serviceResolve', { scene: currentScene })).result.submittedRequestId, row.id)
        }
        assert.equal(await db.onlineSettlement.count(), 0)
      } finally { modernRuntime.stop(); await closeLocal(modernProxy); await closeLocal(modernServer) }
    })
  } finally {
    runtime.stop(); await closeLocal(proxy); await closeLocal(server); await db.$disconnect(); await dropDisposablePgDatabase(url)
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
  const d = { templateId: template.id, event: 'INVOICE_RECEIVED', userId: 'synthetic-owner', openId: 'synthetic-a', appId, envId }
  const r = { id: 'csr-' + uuid(), type: 'INVOICE', linkedBusinessRecordId: 'synthetic-classification-invoice', storeKey: 'http-store',
    subscriptionChoice: 'accept', subscriptionTemplateId: template.id, customerUserId: d.userId,
    customerOpenId: d.openId, customerAppId: appId, customerEnvId: envId }
  const invoice = { id: r.linkedBusinessRecordId, storeKey: r.storeKey, companyName: '合成抬头', amountCents: 1200n, deletedAt: null }
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
    assert.equal((await send(d, r, '合成门店', invoice)).status, expected); assert.equal(sends, 1)
  }
})
