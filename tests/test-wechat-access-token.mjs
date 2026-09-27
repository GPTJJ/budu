import test from 'node:test'
import assert from 'node:assert/strict'
import {
  miniprogramAccessToken, mpAccessToken,
  invalidateMiniprogramToken, _resetMiniprogramTokenAuthority,
} from '../server/wechat-access-token.js'

const okBody = (token = 'TOKEN-A', expiresIn = 7200) => ({ errcode: 0, errmsg: 'ok', access_token: token, expires_in: expiresIn })

function fetchStub(bodies) {
  const calls = []
  let i = 0
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    const body = bodies[Math.min(i, bodies.length - 1)]
    i += 1
    return { ok: body !== null, json: async () => body ?? {} }
  }
  return { fetchImpl, calls }
}

const config = { appId: 'wx-test', appSecret: 'SECRET-MUST-NOT-LEAK', mode: 'production' }

test('the token authority keeps exactly one cache per appid', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl, calls } = fetchStub([okBody()])
  let clock = 1_000_000
  const now = () => clock
  const a = await miniprogramAccessToken({ config, fetchImpl, now })
  const b = await miniprogramAccessToken({ config, fetchImpl, now })
  const viaAdapter = await mpAccessToken(config.appId, config.appSecret, { fetchImpl, now })
  assert.equal(a, 'TOKEN-A')
  assert.equal(b, 'TOKEN-A')
  assert.equal(viaAdapter, 'TOKEN-A')
  // one network call for three asks, including the legacy adapter
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'POST')
  assert.ok(calls[0].url.includes('/cgi-bin/stable_token'))
})

test('the token is refetched once it has expired', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl, calls } = fetchStub([okBody('TOKEN-1', 7200), okBody('TOKEN-2', 7200)])
  let clock = 2_000_000
  const now = () => clock
  assert.equal(await miniprogramAccessToken({ config, fetchImpl, now }), 'TOKEN-1')
  clock += 7200 * 1000
  assert.equal(await miniprogramAccessToken({ config, fetchImpl, now }), 'TOKEN-2')
  assert.equal(calls.length, 2)
})

test('an invalidated token is refetched instead of replayed', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl, calls } = fetchStub([okBody('TOKEN-1'), okBody('TOKEN-2')])
  const now = () => 3_000_000
  assert.equal(await miniprogramAccessToken({ config, fetchImpl, now }), 'TOKEN-1')
  invalidateMiniprogramToken(config)
  assert.equal(await miniprogramAccessToken({ config, fetchImpl, now }), 'TOKEN-2')
  assert.equal(calls.length, 2)
})

test('missing config, a rejected appid and a broken response all yield empty, never a throw', async () => {
  _resetMiniprogramTokenAuthority()
  assert.equal(await miniprogramAccessToken({}), '')
  assert.equal(await miniprogramAccessToken({ config: { appId: 'wx-only' } }), '')
  const rejected = fetchStub([{ errcode: 40013, errmsg: 'invalid appid' }])
  assert.equal(await miniprogramAccessToken({ config, fetchImpl: rejected.fetchImpl }), '')
  const expired = fetchStub([okBody('TOO-SHORT', 60)])
  assert.equal(await miniprogramAccessToken({ config, fetchImpl: expired.fetchImpl }), '')
  const broken = fetchStub([null])
  assert.equal(await miniprogramAccessToken({ config, fetchImpl: broken.fetchImpl }), '')
  const throwing = async () => { throw new Error('network down') }
  assert.equal(await miniprogramAccessToken({ config, fetchImpl: throwing }), '')
})

test('a duration that is too short to be usable is not cached', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl, calls } = fetchStub([okBody('SHORT', 60), okBody('GOOD', 7200)])
  const now = () => 4_000_000
  assert.equal(await miniprogramAccessToken({ config, fetchImpl, now }), '')
  assert.equal(await miniprogramAccessToken({ config, fetchImpl, now }), 'GOOD')
  assert.equal(calls.length, 2)
})

test('the caller receives only the token value, never the secret', async () => {
  _resetMiniprogramTokenAuthority()
  const { fetchImpl } = fetchStub([okBody('TOKEN-A')])
  const token = await miniprogramAccessToken({ config, fetchImpl, now: () => 5_000_000 })
  assert.equal(typeof token, 'string')
  assert.equal(token, 'TOKEN-A')
  assert.ok(!token.includes(config.appSecret))
})
