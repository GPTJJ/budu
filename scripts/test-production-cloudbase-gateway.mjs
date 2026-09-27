import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import {
  PRODUCTION_CLOUDBASE_ENV_ID,
  PRODUCTION_WECHAT_APP_ID,
  createGatewayReplayGuard,
  gatewayBodyHash,
  signProductionGatewayRequest,
  validateProductionGatewayConfig,
  verifyProductionGatewayRequest,
} from '../server/production-cloudbase-gateway.js'
import { createWechatTestLoginRouter } from '../server/wechat-test-login.js'
import { createSweetCardClaimRouter } from '../server/sweet-card-claim.js'
import { sweetCardClaimPresentationEnabled } from '../server/sweet-card.js'

const now = 1788759000000
const secret = 'production-gateway-test-secret-0123456789'
const body = { code: 'valid-login-code-123456' }
const base = {
  timestamp: String(now),
  nonce: 'nonce_1234567890123456789012',
  method: 'POST',
  requestPath: '/api/v2/customer/auth/wechat/session',
  bodyHash: gatewayBodyHash(body),
  environment: PRODUCTION_CLOUDBASE_ENV_ID,
  appId: PRODUCTION_WECHAT_APP_ID,
}

test('production claim presentation is available only for a non-empty controlled allowlist', () => {
  const controlled = {
    APP_ENV: 'prod',
    SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED: '1',
    SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY: '1',
    SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS: 'approved-user-id',
    SWEET_CARD_PRODUCTION_GATEWAY_ENABLED: '1',
  }
  assert.equal(sweetCardClaimPresentationEnabled(controlled), true)
  assert.equal(sweetCardClaimPresentationEnabled({ ...controlled, SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED: '0' }), false)
  assert.equal(sweetCardClaimPresentationEnabled({ ...controlled, SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY: '0' }), false)
  assert.equal(sweetCardClaimPresentationEnabled({ ...controlled, SWEET_CARD_MINIPROGRAM_CLAIM_USER_IDS: '' }), false)
  assert.equal(sweetCardClaimPresentationEnabled({ ...controlled, SWEET_CARD_PRODUCTION_GATEWAY_ENABLED: '0' }), false)
  assert.equal(sweetCardClaimPresentationEnabled({ ...controlled, APP_ENV: 'unknown' }), false)
  assert.equal(sweetCardClaimPresentationEnabled({
    APP_ENV: 'test', SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED: '1',
  }), true)
})

function request(fields = base, requestBody = body) {
  const signature = signProductionGatewayRequest(fields, secret)
  const headers = {
    'x-budu-gateway-timestamp': fields.timestamp,
    'x-budu-gateway-nonce': fields.nonce,
    'x-budu-gateway-environment': fields.environment,
    'x-budu-gateway-appid': fields.appId,
    'x-budu-gateway-signature': signature,
  }
  return {
    method: fields.method,
    originalUrl: fields.requestPath,
    body: requestBody,
    get: name => headers[String(name).toLowerCase()] || '',
  }
}

function config(overrides = {}) {
  return {
    enabled: true,
    mode: 'production',
    cloudBaseEnvId: PRODUCTION_CLOUDBASE_ENV_ID,
    appId: PRODUCTION_WECHAT_APP_ID,
    gatewaySecret: secret,
    ...overrides,
  }
}

function verify(req, overrides = {}) {
  return verifyProductionGatewayRequest(req, config(), {
    replayGuard: createGatewayReplayGuard({ now: () => now }),
    now: () => now,
    ...overrides,
  })
}

test('PG-01 valid production signed request passes', () => {
  assert.equal(signProductionGatewayRequest(base, secret), 'RURChqCWNKSo9gLVb19s_mSAQp_vIQDS0bl2r8ZQYBo')
  assert.equal(verify(request()).verified, true)
})

test('PG-02 no signature is denied', () => {
  const req = request()
  req.get = () => ''
  assert.throws(() => verify(req), error => error.status === 401)
})

test('PG-03 wrong signature is denied using constant-time comparison path', () => {
  const req = request()
  const get = req.get
  req.get = name => String(name).toLowerCase() === 'x-budu-gateway-signature'
    ? 'A'.repeat(43) : get(name)
  assert.throws(() => verify(req), error => error.status === 401)
})

test('PG-04 test signature cannot enter production', () => {
  const fields = { ...base, environment: 'budu-test-d8gwb4xwy41dc6c61' }
  assert.throws(() => verify(request(fields)), error => error.status === 403)
})

test('PG-05 production signature cannot enter a test-scoped verifier', () => {
  assert.throws(() => verifyProductionGatewayRequest(request(), {
    ...config(), mode: 'test', cloudBaseEnvId: 'budu-test-d8gwb4xwy41dc6c61', gatewaySecret: 'different-test-secret-01234567890123',
  }), error => error.status === 403)
})

test('PG-06 expired timestamp is denied', () => {
  const fields = { ...base, timestamp: String(now - 600000) }
  assert.throws(() => verify(request(fields)), error => error.status === 401)
})

test('PG-07 nonce replay is denied', () => {
  const replayGuard = createGatewayReplayGuard({ now: () => now })
  const options = { replayGuard, now: () => now }
  assert.equal(verifyProductionGatewayRequest(request(), config(), options).verified, true)
  assert.throws(() => verifyProductionGatewayRequest(request(), config(), options), error => error.status === 409)
})

test('PG-08 body tamper is denied', () => {
  assert.throws(() => verify(request(base, { code: 'tampered-login-code-123456' })), error => error.status === 401)
})

test('PG-09 wrong AppID is denied', () => {
  const fields = { ...base, appId: 'wx0000000000000000' }
  assert.throws(() => verify(request(fields)), error => error.status === 403)
})

test('PG-10 wrong EnvId is denied', () => {
  const fields = { ...base, environment: 'unknown-environment' }
  assert.throws(() => verify(request(fields)), error => error.status === 403)
})

test('production startup config is bound to exact app, env, DB and root-only paths', () => {
  const safeStat = { isFile: () => true, uid: 0, gid: 0, mode: 0o100440 }
  const io = { statSync: () => safeStat, readFileSync: file => file.includes('gateway') ? secret : 'approved-appsecret-value-123456789' }
  const env = {
    APP_ENV: 'prod', DATABASE_URL: 'postgresql://x:y@db:5432/budu_bj006', JWT_SECRET: 'marker-secret-long-enough',
    SWEET_CARD_PRODUCTION_GATEWAY_ENABLED: '1',
    SWEET_CARD_WECHAT_APP_ID: PRODUCTION_WECHAT_APP_ID,
    SWEET_CARD_CLOUDBASE_ENV_ID: PRODUCTION_CLOUDBASE_ENV_ID,
    SWEET_CARD_WECHAT_APP_SECRET_FILE: '/run/secrets/sweet-card/production-wechat.appsecret',
    SWEET_CARD_PRODUCTION_GATEWAY_SECRET_FILE: '/run/secrets/sweet-card/production-gateway-hmac.key',
  }
  assert.equal(validateProductionGatewayConfig(env, io).database, 'budu_bj006')
  for (const override of [
    { APP_ENV: 'test' }, { DATABASE_URL: 'postgresql://x:y@db:5432/budu_sc11a_test' },
    { SWEET_CARD_WECHAT_APP_ID: 'wrong' }, { SWEET_CARD_CLOUDBASE_ENV_ID: 'wrong' },
  ]) assert.throws(() => validateProductionGatewayConfig({ ...env, ...override }, io), /\[config\]/)
})

test('PG-11/12/13 signed login resolves existing Identity Bridge User.id and rejects spoof/reused code', async () => {
  const previousEnv = process.env.APP_ENV
  process.env.APP_ENV = 'prod'
  const identityUserId = 'customer-user-stable-id'
  const db = {
    $transaction: async fn => fn(db),
    $executeRaw: async () => 0,
    weChatAuthIdentity: {
      findUnique: async () => ({
        id: 'identity-id', userId: identityUserId, unionId: null, createdAt: new Date(),
        user: { id: identityUserId, role: 'customer', status: 'active' },
      }),
    },
    customerSession: { create: async () => ({}) },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/v2/customer/auth/wechat', createWechatTestLoginRouter({
    configLoader: () => ({
      ...config(), appSecret: 'approved-appsecret-value-123456789', markerKey: 'marker-secret-long-enough', database: 'budu_bj006',
    }),
    exchange: async ({ code }) => code.startsWith('reused')
      ? { errcode: 40163, errmsg: 'code been used' }
      : { openid: 'server-resolved-openid', session_key: 'never-return' },
    db,
  }))
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const call = async (requestBody, nonce) => {
      const fields = { ...base, timestamp: String(Date.now()), nonce, bodyHash: gatewayBodyHash(requestBody) }
      const signed = request(fields, requestBody)
      const headers = { 'content-type': 'application/json' }
      for (const name of [
        'x-budu-gateway-timestamp', 'x-budu-gateway-nonce', 'x-budu-gateway-environment',
        'x-budu-gateway-appid', 'x-budu-gateway-signature',
      ]) headers[name] = signed.get(name)
      const response = await fetch(`${origin}${fields.requestPath}`, {
        method: 'POST', headers, body: JSON.stringify(requestBody),
      })
      return { status: response.status, body: await response.json() }
    }
    const unsigned = await fetch(`${origin}${base.requestPath}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(unsigned.status, 401)
    const valid = await call(body, 'valid_1234567890123456789012')
    assert.equal(valid.status, 200)
    assert.equal(valid.body.environment, 'production')
    assert.equal(valid.body.databaseAuthority, 'budu_bj006')
    assert.match(valid.body.customerRef, /^customer-/)
    assert.doesNotMatch(JSON.stringify(valid.body), /server-resolved-openid|never-return|customer-user-stable-id/i)
    const spoof = await call({ ...body, userId: 'spoof', openid: 'spoof' }, 'spoof_1234567890123456789012')
    assert.equal(spoof.status, 400)
    assert.equal(spoof.body.error, 'IDENTITY_AUTHORITY_SPOOF_REJECTED')
    const reused = await call({ code: 'reused-login-code-123456' }, 'reused_123456789012345678901')
    assert.equal(reused.status, 401)
    assert.equal(reused.body.error, 'WECHAT_CODE_REJECTED')
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (previousEnv === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = previousEnv
  }
})

test('PG-14 production Claim flag OFF denies the complete Claim surface', async () => {
  const previous = {
    APP_ENV: process.env.APP_ENV,
    enabled: process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED,
  }
  process.env.APP_ENV = 'prod'
  process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED = '0'
  const app = express()
  app.use(express.json())
  app.use('/api/v2/customer/sweet-card', createSweetCardClaimRouter({ configLoader: () => config() }))
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise(resolve => server.once('listening', resolve))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/customer/sweet-card/claim/entry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimToken: 'invalid' }),
    })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'NOT_FOUND' })
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (previous.APP_ENV === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = previous.APP_ENV
    if (previous.enabled === undefined) delete process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED
    else process.env.SWEET_CARD_MINIPROGRAM_CLAIM_ENABLED = previous.enabled
  }
})
