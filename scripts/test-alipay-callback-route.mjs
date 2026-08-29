import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createPaymentCallbackRouter } from '../server/payment-callbacks.js'

async function withServer(service, fn) {
  const app = express()
  app.use('/api/payments', createPaymentCallbackRouter(service))
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('支付宝 callback 接受 form-urlencoded，持久化成功后返回官方 success 文本', async () => {
  let received = null
  const service = {
    async handleCallback(provider, payload) {
      received = { provider, payload }
      return { payment: { id: 'pay-1', status: 'success' } }
    },
  }
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/api/payments/alipay/callback`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ out_trade_no: 'BUDU-1', trade_status: 'TRADE_SUCCESS', sign_type: 'RSA2', sign: 'test' }),
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'success')
    assert.equal(received.provider, 'alipay')
    assert.equal(received.payload.out_trade_no, 'BUDU-1')
  })
})

test('验签或状态处理失败时 callback 返回 failure，绝不伪装成功', async () => {
  const service = { async handleCallback() { const error = new Error('invalid signature'); error.status = 400; throw error } }
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/api/payments/alipay/callback`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sign=bad',
    })
    assert.equal(response.status, 400)
    assert.equal(await response.text(), 'failure')
  })
})
