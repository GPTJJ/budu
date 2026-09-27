import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { posRouter } from '../server/pos.js'
import { alipayStoreAllowed } from '../server/payments/alipay-config.js'
import { wechatPayStoreAllowed } from '../server/payments/wechat-config.js'

const originalPaymentMode = process.env.PAYMENT_MODE
process.env.PAYMENT_MODE = 'mock'

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  const encoded = String(req.headers['x-test-user'] || '')
  req.user = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : null
  next()
})
app.use(posRouter)

const server = await new Promise((resolve) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
})
const origin = `http://127.0.0.1:${server.address().port}`

function userHeader(user) {
  return Buffer.from(JSON.stringify(user)).toString('base64url')
}

async function configStatus(user, storeId = 'xidan') {
  const response = await fetch(`${origin}/pos/config?storeId=${encodeURIComponent(storeId)}`, {
    headers: user ? { 'x-test-user': userHeader(user) } : {},
  })
  return { status: response.status, body: await response.json() }
}

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  if (originalPaymentMode === undefined) delete process.env.PAYMENT_MODE
  else process.env.PAYMENT_MODE = originalPaymentMode
})

test('POS 支付账号资格只由 store-pos capability 决定，不硬编码角色', async () => {
  const posModule = { modules: { 'store-pos': true } }
  const noPosModule = { modules: { 'store-pos': false } }

  for (const role of ['manager', 'staff', 'operations']) {
    const result = await configStatus({ id: `pos-${role}`, role, status: 'active', storeKeys: ['xidan'], permissions: posModule })
    assert.equal(result.status, 200, `${role} 持有 POS capability 应允许读取支付配置`)
    assert.deepEqual(result.body.channels, ['cash'])
  }

  for (const role of ['manager', 'staff', 'operations']) {
    const result = await configStatus({ id: `no-pos-${role}`, role, status: 'active', storeKeys: ['xidan'], permissions: noPosModule })
    assert.equal(result.status, 403, `${role} 无 POS capability 必须由服务端拒绝`)
  }

  assert.equal((await configStatus({ id: 'public', role: 'public', status: 'active', storeKeys: ['xidan'], permissions: posModule })).status, 403)
  assert.equal((await configStatus({ id: 'disabled', role: 'staff', status: 'disabled', storeKeys: ['xidan'], permissions: posModule })).status, 403)
  assert.equal((await configStatus(null)).status, 403)
})

test('用户 POS capability 不绕过门店 Provider kill switch', () => {
  const enabledStores = ['xidan']
  assert.equal(wechatPayStoreAllowed('xidan', { enabledStores }), true)
  assert.equal(wechatPayStoreAllowed('chaowai', { enabledStores }), false)
  assert.equal(alipayStoreAllowed('xidan', { enabledStores }), true)
  assert.equal(alipayStoreAllowed('chaowai', { enabledStores }), false)
})
