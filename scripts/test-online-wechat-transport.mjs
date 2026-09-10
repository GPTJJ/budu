import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createOnlineWechatTransport } from '../server/online-wechat-transport.js'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { mchId: '1116382351', merchantSerial: 'AB1234', merchantPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const query = '/v3/pay/transactions/out-trade-no/B123?mchid=1116382351'
function mock(run) {
  const state = { requests: 0, destroyed: false }
  state.requestImpl = (options, callback) => {
    state.requests++
    state.options = options
    const req = new EventEmitter()
    req.destroy = () => { state.destroyed = true }
    req.end = body => { state.body = body; queueMicrotask(() => run({ req, respond })) }
    function respond(statusCode = 200, headers = {}) {
      const res = new EventEmitter()
      res.statusCode = statusCode; res.headers = headers; res.complete = true
      res.destroy = () => { state.responseDestroyed = true }
      callback(res)
      return res
    }
    return req
  }
  state.transport = createOnlineWechatTransport({ ...config, requestImpl: state.requestImpl, deadlineMs: 50 })
  return state
}
function signed(state, method, path) {
  assert.equal(state.options.hostname, 'api.mch.weixin.qq.com')
  assert.equal(state.options.protocol, 'https:')
  assert.equal(state.options.rejectUnauthorized, true)
  const fields = Object.fromEntries([...state.options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map(x => [x[1], x[2]]))
  assert.equal(fields.mchid, config.mchId)
  assert.equal(fields.serial_no, config.merchantSerial)
  assert.match(fields.nonce_str, /^[0-9a-f]{48}$/)
  const message = Buffer.concat([Buffer.from(`${method}\n${path}\n${fields.timestamp}\n${fields.nonce_str}\n`), state.body, Buffer.from('\n')])
  assert.equal(crypto.verify('RSA-SHA256', message, publicKey, Buffer.from(fields.signature, 'base64')), true)
}
test('POST signs exact UTF-8 bytes and returns untouched raw response for verifier', async () => {
  const bytes = Buffer.from('{ "prepay_id" : "abc" }\n')
  const m = mock(({ respond }) => { const r = respond(); r.emit('data', bytes); r.emit('end') })
  const result = await m.transport('POST', '/v3/pay/transactions/jsapi', { description: '甜意卡', amount: { total: 1 } })
  signed(m, 'POST', '/v3/pay/transactions/jsapi')
  assert.deepEqual(result.rawBody, bytes)
  assert.equal(result.statusCode, 200)
})
test('GET signs complete query string and empty body', async () => {
  const m = mock(({ respond }) => respond().emit('end'))
  await m.transport('GET', query)
  signed(m, 'GET', query)
  assert.equal(m.body.length, 0)
})
test('only fixed payment/close/refund endpoints and own merchant query are permitted', async () => {
  const m = mock(({ respond }) => respond(204).emit('end'))
  for (const [method, path, body] of [['POST', '/v3/pay/transactions/out-trade-no/B123/close', {}], ['POST', '/v3/refund/domestic/refunds', {}], ['GET', '/v3/refund/domestic/refunds/R123']]) await m.transport(method, path, body)
  for (const [method, path, body] of [['GET', 'https://evil.test'], ['GET', query + '&x=1'], ['GET', query.replace('1116382351', '1116382352')], ['POST', '/v3/certificates', {}], ['GET', query, {}], ['GET', '/v3/refund/domestic/refunds/../x'], ['PUT', query]]) await assert.rejects(m.transport(method, path, body), /REQUEST_INVALID/)
  assert.equal(m.requests, 3)
})
test('absolute deadline bounds unresolved DNS or TLS before response headers', async () => {
  const m = mock(() => {})
  await assert.rejects(m.transport('GET', query), /DEADLINE/)
  assert.equal(m.destroyed, true)
})
test('drip feed cannot reset absolute deadline', async () => {
  let interval
  const m = mock(({ respond }) => { const r = respond(); interval = setInterval(() => r.emit('data', Buffer.from('x')), 5) })
  try { await assert.rejects(m.transport('GET', query), /DEADLINE/); assert.equal(m.responseDestroyed, true) }
  finally { clearInterval(interval) }
})
test('stream beyond 1MB is destroyed', async () => {
  const m = mock(({ respond }) => { const r = respond(); r.emit('data', Buffer.alloc(1024 * 1024)); r.emit('data', Buffer.from('x')) })
  await assert.rejects(m.transport('GET', query), /RESPONSE_TOO_LARGE/)
  assert.equal(m.destroyed, true)
})
test('oversized declared content length fails before buffering', async () => {
  const m = mock(({ respond }) => respond(200, { 'content-length': '1048577' }))
  await assert.rejects(m.transport('GET', query), /RESPONSE_TOO_LARGE/)
})
test('abort closes request without propagating caller reason', async () => {
  const m = mock(() => {}), controller = new AbortController()
  const result = m.transport('GET', query, undefined, { signal: controller.signal })
  controller.abort('SECRET')
  await assert.rejects(result, error => error.message === 'ONLINE_WECHAT_ABORTED')
  assert.equal(m.destroyed, true)
  await assert.rejects(m.transport('GET', query, undefined, { signal: controller.signal }), /ABORTED/)
  assert.equal(m.requests, 1)
})
test('native errors are redacted and never retried', async () => {
  const m = mock(({ req }) => req.emit('error', new Error('SECRET PEM request body')))
  await assert.rejects(m.transport('GET', query), error => error.message === 'ONLINE_WECHAT_NETWORK_ERROR')
  assert.equal(m.requests, 1)
})
test('redirect is denied without following Location', async () => {
  const m = mock(({ respond }) => respond(302, { location: 'https://evil.test' }))
  await assert.rejects(m.transport('GET', query), /REDIRECT_DENIED/)
  assert.equal(m.requests, 1)
})
test('truncated or premature closed response is rejected', async () => {
  for (const mode of ['length', 'close', 'aborted', 'error']) {
    const m = mock(({ respond }) => { const r = respond(200, mode === 'length' ? { 'content-length': '2' } : {}); r.emit('data', Buffer.from('x')); r.emit(mode === 'length' ? 'end' : mode, new Error('SECRET')) })
    await assert.rejects(m.transport('GET', query), /ONLINE_WECHAT_RESPONSE_/)
  }
})
test('HTTP errors remain untrusted raw signed response and are not silently retried', async () => {
  const m = mock(({ respond }) => { const r = respond(500); r.emit('data', Buffer.from('{"code":"SYSTEM_ERROR"}')); r.emit('end') })
  const response = await m.transport('GET', query)
  assert.equal(response.statusCode, 500)
  assert.equal(m.requests, 1)
})
test('key/config and oversized or unserializable request fail before network', async () => {
  assert.throws(() => createOnlineWechatTransport({ ...config, merchantPrivateKey: 'SECRET' }), /KEY_INVALID/)
  const m = mock(() => {}), circular = {}; circular.self = circular
  await assert.rejects(m.transport('POST', '/v3/pay/transactions/jsapi', circular), /REQUEST_INVALID/)
  await assert.rejects(m.transport('POST', '/v3/pay/transactions/jsapi', { x: 'x'.repeat(1024 * 1024) }), /REQUEST_TOO_LARGE/)
  assert.equal(m.requests, 0)
})
test('compressed responses and invalid paths are rejected without reinterpretation', async () => {
  const m = mock(({ respond }) => respond(200, { 'content-encoding': 'gzip' }))
  await assert.rejects(m.transport('GET', query), /ENCODING_DENIED/)
  await assert.rejects(m.transport('GET', Symbol('private')), /REQUEST_INVALID/)
  assert.equal(m.requests, 1)
})
test('fresh authorization nonce is generated for each independent invocation', async () => {
  const m = mock(({ respond }) => respond().emit('end'))
  await m.transport('GET', query)
  const first = m.options.headers.Authorization
  await m.transport('GET', query)
  assert.notEqual(m.options.headers.Authorization, first)
})
