import test from 'node:test'
import assert from 'node:assert/strict'
import { createServiceWechatSender, serviceTemplates } from '../server/store-service-notifications.js'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'

// No real database or platform access: these tests inspect the final provider
// request produced by the sender and by the actual runtime wiring.
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_unreachable'
const { createStoreServiceRuntime, generateStoreServiceCode } = await import('../server/store-service-api.js')
const appId = 'wxfce0a3c4bb430023'
const template = { id: 'synthetic-received-template', verified: true, semantic: 'INVOICE_RECEIVED',
  fields: { thing1: 'storeName', phrase2: 'status' } }
const templateEnv = { STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ INVOICE: template }) }
const templates = serviceTemplates(templateEnv)
const configFor = mode => ({ enabled: true, mode, appId, appSecret: 'synthetic-only',
  cloudBaseEnvId: mode === 'production' ? 'budu-d6gz358ixe39faf43' : 'budu-test-d8gwb4xwy41dc6c61',
  gatewaySecret: 'synthetic-gateway-key-never-production-12345' })
function fixture(mode = 'production') {
  const config = configFor(mode)
  const delivery = { id: 'synthetic-delivery', templateId: template.id, event: 'INVOICE_RECEIVED',
    openId: 'synthetic-requester', userId: 'synthetic-owner', appId, envId: config.cloudBaseEnvId, attempts: 1 }
  const request = { id: 'csr-synthetic-invoice', type: 'INVOICE', storeKey: 'synthetic-store', linkedBusinessRecordId: 'synthetic-invoice',
    subscriptionChoice: 'accept', subscriptionTemplateId: template.id, customerUserId: delivery.userId,
    customerOpenId: delivery.openId, customerAppId: appId, customerEnvId: delivery.envId, store: { name: '合成门店' } }
  const calls = []
  const fetchImpl = async (url, input) => {
    calls.push({ url, body: JSON.parse(input.body) })
    return url.includes('/stable_token')
      ? { ok: true, json: async () => ({ access_token: 'synthetic-token', expires_in: 7200 }) }
      : { ok: true, json: async () => ({ errcode: 0 }) }
  }
  const invoice = { id: request.linkedBusinessRecordId, storeKey: request.storeKey, companyName: '合成开票抬头', amountCents: 1200n, deletedAt: null }
  return { config, delivery, request, invoice, calls, fetchImpl }
}
function assertMessage(f, state) {
  const messages = f.calls.filter(c => c.url.includes('/message/subscribe/send?'))
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].body, { touser: f.delivery.openId, template_id: template.id,
    page: `pages/store-service/detail?id=${f.request.id}`, miniprogram_state: state, lang: 'zh_CN',
    data: { thing1: { value: '合成门店' }, phrase2: { value: '已收到' } } })
  assert.equal(Object.hasOwn(messages[0].body, 'env_version'), false)
}

test('subscription sender defaults to formal and builds the exact final request', async () => {
  _resetMiniprogramTokenAuthority()
  const f = fixture()
  const send = createServiceWechatSender({ config: f.config, templates, fetchImpl: f.fetchImpl })
  assert.equal((await send(f.delivery, f.request, f.request.store.name, f.invoice)).status, 'ACCEPTED')
  assertMessage(f, 'formal')
})

test('subscription state accepts only formal, trial and developer; QR spellings fail closed before token access', async t => {
  for (const state of ['formal', 'trial', 'developer', 'release', 'develop', '', null, 'FORMAL']) {
    await t.test(String(state), async () => {
      _resetMiniprogramTokenAuthority()
      const f = fixture()
      const send = createServiceWechatSender({ config: f.config, templates, fetchImpl: f.fetchImpl, envVersion: state })
      const result = await send(f.delivery, f.request, f.request.store.name, f.invoice)
      if (['formal', 'trial', 'developer'].includes(state)) {
        assert.equal(result.status, 'ACCEPTED'); assertMessage(f, state)
      } else {
        assert.deepEqual(result, { status: 'BLOCKED_CONFIG', code: 'CONFIG' }); assert.equal(f.calls.length, 0)
      }
    })
  }
})

test('actual runtime maps production to formal and TEST to developer', async t => {
  for (const [mode, expected] of [['production', 'formal'], ['test', 'developer']]) {
    await t.test(mode, async () => {
      _resetMiniprogramTokenAuthority()
      const f = fixture(mode), saved = []
      const tx = { $queryRawUnsafe: async () => [{ id: f.delivery.id }],
        storeServiceDelivery: { update: async () => f.delivery } }
      const db = { $transaction: async fn => fn(tx),
        storeServiceDelivery: { updateMany: async input => { saved.push(input); return { count: 1 } } },
        customerServiceRequest: { findUnique: async () => f.request }, invoice: { findUnique: async () => f.invoice } }
      const runtime = createStoreServiceRuntime({ db, config: f.config,
        env: { ...templateEnv, STORE_SERVICE_SEND_ENABLED: '1' }, fetchImpl: f.fetchImpl, deliverInternal: false })
      try { await runtime.tick() } finally { runtime.stop() }
      assertMessage(f, expected)
      assert.equal(saved.at(-1).data.status, 'ACCEPTED')
      assert.equal(saved.at(-1).where.claimId.length > 0, true)
    })
  }
})

test('QR generation independently retains env_version release/develop and its path gate', async t => {
  for (const [mode, expected] of [['production', 'release'], ['test', 'develop']]) {
    await t.test(mode, async () => {
      _resetMiniprogramTokenAuthority()
      const f = fixture(mode), row = { id: 'csr-synthetic-qr', type: 'INVOICE', storeKey: 'synthetic-store',
        status: 'WAITING_CUSTOMER', expiresAt: new Date(Date.now() + 60000) }
      const tx = { $queryRawUnsafe: async () => [{ id: 'synthetic-scene' }],
        customerServiceRequest: { findUnique: async () => row },
        customerServiceRequestToken: { findUnique: async () => ({ miniSceneHash: null }), update: async () => ({}) } }
      const db = { customerServiceRequest: tx.customerServiceRequest, $transaction: async fn => fn(tx) }
      let qrBody = null
      const fetchImpl = async (url, input) => {
        if (url.includes('/stable_token')) return f.fetchImpl(url, input)
        qrBody = JSON.parse(input.body)
        return { ok: true, arrayBuffer: async () => Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(120)]) }
      }
      if (mode === 'production') {
        await assert.rejects(generateStoreServiceCode({ db, requestId: row.id, config: f.config, fetchImpl,
          user: { id: 'synthetic-dev', role: 'developer', status: 'active', storeKeys: [], permissions: {} },
          env: { STORE_SERVICE_QR_ENABLED: '1', STORE_SERVICE_SUBMISSIONS_ENABLED: '1' } }), { status: 503 })
        assert.equal(qrBody, null); assert.equal(f.calls.length, 0)
      }
      const result = await generateStoreServiceCode({ db, requestId: row.id, config: f.config, fetchImpl,
        user: { id: 'synthetic-dev', role: 'developer', status: 'active', storeKeys: [], permissions: {} },
        env: { STORE_SERVICE_QR_ENABLED: '1', STORE_SERVICE_SUBMISSIONS_ENABLED: '1', STORE_SERVICE_RELEASE_PATH_READY: '1' } })
      assert.equal(qrBody.env_version, expected); assert.equal(result.envVersion, expected)
      assert.equal(qrBody.check_path, mode === 'production')
      assert.equal(qrBody.page, 'pages/store-service/form')
      assert.equal(Object.hasOwn(qrBody, 'miniprogram_state'), false)
    })
  }
})

test('proof-only shipment uses compatible fields; a required tracking number never receives the delivery proof', async () => {
  const f = fixture('test')
  f.request = { ...f.request, type: 'MAILING', carrier: '同城闪送', trackingNo: null,
    deliveryProof: '合成配送凭证：请凭交接记录向门店核对' }
  const selected = { id: 'synthetic-shipping-template', verified: true, semantic: 'SHIPMENT_CONFIRMED',
    fields: { thing1: 'storeName', phrase2: 'status', thing3: 'carrier' } }
  const delivery = { ...f.delivery, templateId: selected.id, event: 'SHIPMENT_CONFIRMED' }
  f.request.subscriptionTemplateId = selected.id; f.request.requestMetadata = { method: '同城闪送' }
  const mailing = { id: f.request.linkedBusinessRecordId, storeKey: f.request.storeKey, method: '同城闪送', deletedAt: null }
  const make = adopted => createServiceWechatSender({ config: f.config, envVersion: 'developer', fetchImpl: f.fetchImpl,
    templates: serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ MAILING: adopted }) }) })
  _resetMiniprogramTokenAuthority()
  assert.equal((await make(selected)(delivery, f.request, f.request.store.name, mailing)).status, 'ACCEPTED')
  const sent = f.calls.find(c => c.url.includes('/message/subscribe/send?')).body
  assert.deepEqual(sent.data, { thing1: { value: '合成门店' }, phrase2: { value: '已发货' }, thing3: { value: '同城闪送' } })
  assert.equal(JSON.stringify(sent).includes(f.request.deliveryProof), false)
  assert.equal(sent.page, `pages/store-service/detail?id=${f.request.id}`)
  f.calls.length = 0; _resetMiniprogramTokenAuthority()
  const needsWaybill = { ...selected, fields: { thing1: 'storeName', character_string2: 'trackingNo' } }
  assert.deepEqual(await make(needsWaybill)(delivery, f.request, f.request.store.name, mailing), { status: 'FAILED', code: 'FIELD_INVALID' })
  assert.equal(f.calls.length, 0)
})
