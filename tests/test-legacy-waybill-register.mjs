import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createLegacyWaybillRegister } from '../server/legacy-waybill-register.js'
import { signProductionGatewayRequest, gatewayBodyHash } from '../server/production-cloudbase-gateway.js'

const SECRET = 's'.repeat(48)
const CONFIG = {
  enabled: true,
  mode: 'production',
  appId: 'wxfce0a3c4bb430023',
  cloudBaseEnvId: 'budu-d6gz358ixe39faf43',
  gatewaySecret: SECRET,
}
const PATH = '/api/v2/merchant/online-checkout/legacy-waybill'

function signedReq(body, secret = SECRET) {
  const timestamp = String(Date.now())
  const nonce = crypto.randomBytes(24).toString('base64url')
  const signature = signProductionGatewayRequest({
    timestamp, nonce, method: 'POST', requestPath: PATH,
    bodyHash: gatewayBodyHash(body), environment: CONFIG.cloudBaseEnvId, appId: CONFIG.appId,
  }, secret)
  const headers = {
    'x-budu-gateway-timestamp': timestamp,
    'x-budu-gateway-nonce': nonce,
    'x-budu-gateway-environment': CONFIG.cloudBaseEnvId,
    'x-budu-gateway-appid': CONFIG.appId,
    'x-budu-gateway-signature': signature,
  }
  return { method: 'POST', originalUrl: PATH, body, get: name => headers[name] }
}

function captureRes() {
  const out = { statusCode: 200, body: null }
  return {
    out,
    setHeader() {},
    status(code) { out.statusCode = code; return this },
    json(payload) { out.body = payload; return this },
  }
}

const ACTIVE_DB = { weChatAuthIdentity: { findUnique: async () => ({ user: { id: 'u1', status: 'active' } }) } }
const INACTIVE_DB = { weChatAuthIdentity: { findUnique: async () => ({ user: { id: 'u1', status: 'disabled' } }) } }

const VALID = {
  actorOpenId: 'oACTOR-1',
  payNo: 'B17899241178933971',
  openid: 'oBUYER-1',
  carrierCode: 'SF',
  trackingNo: 'SF1234567890',
  receiverPhone: '13523757594',
  goodsName: 'NO.1树莓',
  goodsImgUrl: 'https://cdn.example.com/p/s1.jpg',
  orderDetailPath: 'pages/order-detail/order-detail?payNo=B17899241178933971',
  transId: '4500000485202609206275430380',
}

function handler(db, outcome) {
  const calls = []
  const wechatLogistics = { reportWaybill: async input => { calls.push(input); return outcome } }
  return { calls, fn: createLegacyWaybillRegister({ db, gatewayConfig: CONFIG, wechatLogistics }) }
}

test('LWR-01 full facts report to WeChat and return the issued token', async () => {
  const { calls, fn } = handler(ACTIVE_DB, { status: 'SYNCED', waybillToken: 'TOKEN-64' })
  const res = captureRes()
  await fn(signedReq(VALID), res)
  assert.equal(res.out.statusCode, 200)
  assert.deepEqual(res.out.body, { ok: true, result: { status: 'SYNCED', waybillToken: 'TOKEN-64' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].deliveryId, 'SF')
  assert.equal(calls[0].waybillId, VALID.trackingNo)
  assert.equal(calls[0].transId, VALID.transId)
  assert.equal(calls[0].openid, VALID.openid)
})

test('LWR-02 missing trans_id short-circuits UNSUPPORTED without calling WeChat', async () => {
  const { calls, fn } = handler(ACTIVE_DB, { status: 'SYNCED', waybillToken: 'T' })
  const res = captureRes()
  await fn(signedReq({ ...VALID, transId: '' }), res)
  assert.equal(res.out.statusCode, 200)
  assert.deepEqual(res.out.body, { ok: true, result: { status: 'UNSUPPORTED', waybillToken: null } })
  assert.equal(calls.length, 0)
})

test('LWR-03 unknown carrier is rejected at the edge', async () => {
  const { calls, fn } = handler(ACTIVE_DB, { status: 'SYNCED', waybillToken: 'T' })
  const res = captureRes()
  await fn(signedReq({ ...VALID, carrierCode: 'UNKNOWN' }), res)
  assert.equal(res.out.statusCode, 400)
  assert.equal(calls.length, 0)
})

test('LWR-04 malformed tracking number is rejected', async () => {
  const { calls, fn } = handler(ACTIVE_DB, { status: 'SYNCED', waybillToken: 'T' })
  const res = captureRes()
  await fn(signedReq({ ...VALID, trackingNo: 'bad no!' }), res)
  assert.equal(res.out.statusCode, 400)
  assert.equal(calls.length, 0)
})

test('LWR-05 inactive merchant identity is forbidden', async () => {
  const { calls, fn } = handler(INACTIVE_DB, { status: 'SYNCED', waybillToken: 'T' })
  const res = captureRes()
  await fn(signedReq(VALID), res)
  assert.equal(res.out.statusCode, 403)
  assert.equal(calls.length, 0)
})

test('LWR-06 a wrong signature never reaches the handler logic', async () => {
  const { calls, fn } = handler(ACTIVE_DB, { status: 'SYNCED', waybillToken: 'T' })
  const res = captureRes()
  await fn(signedReq(VALID, 'x'.repeat(48)), res)
  assert.ok([401, 503].includes(res.out.statusCode))
  assert.equal(res.out.body.ok, false)
  assert.equal(calls.length, 0)
})

test('LWR-07 a WeChat-side failure surfaces status without a token', async () => {
  const { fn } = handler(ACTIVE_DB, { status: 'FAILED', code: 9300501 })
  const res = captureRes()
  await fn(signedReq(VALID), res)
  assert.equal(res.out.statusCode, 200)
  assert.deepEqual(res.out.body, { ok: true, result: { status: 'FAILED', waybillToken: null } })
})
