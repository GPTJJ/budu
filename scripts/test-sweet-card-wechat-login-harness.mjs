import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APPROVED_TEST_SECRET_PATH,
  APPROVED_TEST_WECHAT_APP_ID,
  createWechatTestLoginRouter,
  resolveWechatTestIdentity,
  validateWechatTestLoginConfig,
} from '../server/wechat-test-login.js'

const safeStat = { isFile: () => true, uid: 0, gid: 0, mode: 0o100440 }
const safeIo = { statSync: () => safeStat, readFileSync: () => 'test-secret-value-1234567890' }
const baseEnv = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://test:secret@test-db:5432/budu_sc11a_test',
  JWT_SECRET: 'test-marker-key-that-is-long-enough',
  SWEET_CARD_WECHAT_LOGIN_HARNESS_ENABLED: '1',
  SWEET_CARD_WECHAT_APP_ID: APPROVED_TEST_WECHAT_APP_ID,
  SWEET_CARD_WECHAT_APP_SECRET_FILE: APPROVED_TEST_SECRET_PATH,
  SWEET_CARD_WECHAT_GATEWAY_PREFIX: '/api/v2/test-sc11a',
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('harness startup accepts only the exact isolated test authority', () => {
  const result = validateWechatTestLoginConfig(baseEnv, safeIo)
  assert.equal(result.enabled, true)
  assert.equal(result.database, 'budu_sc11a_test')
  assert.equal(result.appSecret, 'test-secret-value-1234567890')
})

for (const [name, override] of [
  ['production runtime', { APP_ENV: 'prod' }],
  ['production database', { DATABASE_URL: 'postgresql://x:y@prod:5432/budu_bj006' }],
  ['unapproved AppID', { SWEET_CARD_WECHAT_APP_ID: 'wx0000000000000000' }],
  ['unapproved secret path', { SWEET_CARD_WECHAT_APP_SECRET_FILE: '/tmp/appsecret' }],
  ['production gateway', { SWEET_CARD_WECHAT_GATEWAY_PREFIX: '/api/v2' }],
]) {
  test(`harness startup refuses ${name}`, () => {
    assert.throws(() => validateWechatTestLoginConfig({ ...baseEnv, ...override }, safeIo), /\[config\]/)
  })
}

test('harness startup refuses a non-root or writable secret file', () => {
  const unsafe = { ...safeIo, statSync: () => ({ ...safeStat, uid: 501, mode: 0o100600 }) }
  assert.throws(() => validateWechatTestLoginConfig(baseEnv, unsafe), /permissions are unsafe/)
})

test('resolved identity DTO contains no OpenID, session key, or AppSecret', async () => {
  const config = validateWechatTestLoginConfig(baseEnv, safeIo)
  const dto = await resolveWechatTestIdentity({
    code: 'valid-login-code-123456',
    config,
    exchange: async () => ({ openid: 'sensitive-open-id', session_key: 'sensitive-session-key' }),
  })
  assert.equal(dto.wechatIdentityResolved, true)
  assert.equal(dto.databaseAuthority, 'budu_sc11a_test')
  const serialized = JSON.stringify(dto)
  assert.doesNotMatch(serialized, /sensitive-open-id|sensitive-session-key|test-secret-value/)
})

test('missing and malformed codes are 4xx errors before upstream exchange', async () => {
  const config = validateWechatTestLoginConfig(baseEnv, safeIo)
  let calls = 0
  const exchange = async () => { calls += 1; return { openid: 'unused' } }
  await assert.rejects(resolveWechatTestIdentity({ code: '', config, exchange }), error => error.status === 400)
  await assert.rejects(resolveWechatTestIdentity({ code: 'bad code', config, exchange }), error => error.status === 400)
  assert.equal(calls, 0)
})

test('invalid or reused WeChat code fails safely without generic 500', async () => {
  const config = validateWechatTestLoginConfig(baseEnv, safeIo)
  await assert.rejects(resolveWechatTestIdentity({
    code: 'reused-login-code-123456',
    config,
    exchange: async () => ({ errcode: 40163, errmsg: 'code been used' }),
  }), error => error.status === 401 && error.message === 'WECHAT_CODE_REJECTED')
})

test('timeout and transport failures map to bounded upstream statuses', async () => {
  const config = validateWechatTestLoginConfig(baseEnv, safeIo)
  await assert.rejects(resolveWechatTestIdentity({
    code: 'timeout-login-code-123456', config,
    exchange: async () => { throw new Error('WECHAT_TIMEOUT') },
  }), error => error.status === 504)
  await assert.rejects(resolveWechatTestIdentity({
    code: 'network-login-code-123456', config,
    exchange: async () => { throw new Error('ECONNRESET') },
  }), error => error.status === 502)
})

test('HTTP harness requires the isolated gateway and returns only the safe DTO', async () => {
  const previousEnv = process.env.APP_ENV
  process.env.APP_ENV = 'test'
  const config = validateWechatTestLoginConfig(baseEnv, safeIo)
  const app = express()
  app.use(express.json())
  app.use('/api/customer/auth/wechat', createWechatTestLoginRouter({
    configLoader: () => config,
    exchange: async () => ({ openid: 'http-test-openid', session_key: 'never-return-this' }),
  }))
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const denied = await fetch(`${origin}/api/customer/auth/wechat/live-verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'valid-http-code-123456' }),
    })
    assert.equal(denied.status, 404)

    const allowed = await fetch(`${origin}/api/customer/auth/wechat/live-verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-budu-test-gateway': '1' },
      body: JSON.stringify({ code: 'valid-http-code-123456' }),
    })
    assert.equal(allowed.status, 200)
    const body = await allowed.json()
    assert.equal(body.wechatIdentityResolved, true)
    assert.doesNotMatch(JSON.stringify(body), /openid|session_key|never-return-this|test-secret-value/i)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (previousEnv === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = previousEnv
  }
})

test('container validates the hard guards and never auto-migrates on startup', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
  const command = dockerfile.match(/CMD \["sh", "-c", "([^"]+)"\]/)?.[1] || ''
  assert.ok(command.indexOf('node scripts/validate-runtime-config.mjs') >= 0)
  assert.ok(command.indexOf('node server/index.js') > command.indexOf('node scripts/validate-runtime-config.mjs'))
  assert.equal(command.includes('npx prisma migrate deploy'), false)
})
