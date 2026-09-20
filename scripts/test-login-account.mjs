import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loginAccount } from '../src/utils/loginAccount.js'

async function withResponses(responses, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const next = responses.shift()
    assert.ok(next, 'unexpected request')
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }
  try { await run(calls); assert.equal(responses.length, 0) } finally { globalThis.fetch = original }
}
const hint = { status: 403, body: { error: '请使用合作商入口登录', code: 'PARTNER_LOGIN_REQUIRED' } }
const credentials = { username: ' 北京森醒 ', password: 'test-password' }

test('enabled Partner is sent to the dedicated endpoint with unchanged credentials', async () => {
  await withResponses([hint, { status: 200, body: { principal: { type: 'PARTNER' } } }], async calls => {
    assert.equal((await loginAccount(credentials)).principal.type, 'PARTNER')
    assert.deepEqual(calls.map(x => x.url), ['/api/auth/login', '/api/partner/auth/login'])
    for (const call of calls) assert.deepEqual(JSON.parse(call.options.body), { username: '北京森醒', password: 'test-password' })
  })
})
test('internal login preserves the existing user response without a Partner request', async () => {
  await withResponses([{ status: 200, body: { user: { role: 'developer' } } }], async calls => {
    assert.equal((await loginAccount(credentials)).user.role, 'developer')
    assert.equal(calls.length, 1)
  })
})
for (const [name, response] of [
  ['wrong password', { status: 401, body: { error: '用户名或密码错误' } }],
  ['disabled User', { status: 403, body: { error: '账号已停用，请联系开发者' } }],
  ['unrelated error', { status: 500, body: { error: 'server error' } }],
  ['hint with wrong status', { status: 401, body: hint.body }],
]) test(`${name} is not retried as a Partner login`, async () => {
  await withResponses([response], async calls => {
    await assert.rejects(loginAccount(credentials), error => error.status === response.status)
    assert.equal(calls.length, 1)
  })
})
test('disabled binding remains denied by the canonical Partner endpoint', async () => {
  await withResponses([hint, { status: 401, body: { error: 'PARTNER_LOGIN_DENIED' } }], async () => {
    await assert.rejects(loginAccount({ ...credentials, username: '森醒vhub' }), error => error.status === 401 && error.message === 'PARTNER_LOGIN_DENIED')
  })
})
