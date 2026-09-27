import assert from 'node:assert/strict'
import test from 'node:test'
import { api } from '../src/utils/api.js'

test('JSON content type is preserved when a request also supplies an idempotency key', async () => {
  const previousFetch = globalThis.fetch
  let observed
  globalThis.fetch = async (url, options) => {
    observed = { url, options }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await api('/v2/order-purpose/partner/order-1/classify', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'attempt-1' },
      body: JSON.stringify({ purpose: 'TEST', reason: '误建的测试订单' }),
    })
    assert.equal(observed.url, '/api/v2/order-purpose/partner/order-1/classify')
    assert.equal(observed.options.headers['Content-Type'], 'application/json')
    assert.equal(observed.options.headers['Idempotency-Key'], 'attempt-1')
    assert.equal(JSON.parse(observed.options.body).reason, '误建的测试订单')
  } finally {
    globalThis.fetch = previousFetch
  }
})
