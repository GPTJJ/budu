import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alipayConfig, alipayFrontendStatus } from '../server/payments/alipay-config.js'

const ENV_KEYS = [
  'ALIPAY_ENABLED', 'ALIPAY_PROTOCOL', 'ALIPAY_APP_ID', 'ALIPAY_SELLER_ID', 'ALIPAY_ENDPOINT', 'ALIPAY_NOTIFY_URL',
  'ALIPAY_ENABLED_STORES', 'ALIPAY_PRIVATE_KEY_FILE', 'ALIPAY_PUBLIC_KEY_FILE', 'ALIPAY_REQUEST_TIMEOUT_MS', 'NODE_DEBUG',
]

async function withEnv(values, fn) {
  const before = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const key of ENV_KEYS) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
}

function keyFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-alipay-test-'))
  const app = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privatePath = path.join(dir, 'app-private.pem')
  const publicPath = path.join(dir, 'alipay-public.pem')
  fs.writeFileSync(privatePath, app.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  fs.writeFileSync(publicPath, platform.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  return { dir, privatePath, publicPath }
}

test('支付宝默认关闭，缺少配置时 fail closed', async () => {
  await withEnv({}, () => {
    const config = alipayConfig()
    assert.equal(config.enabled, false)
    assert.equal(config.configured, false)
    assert.deepEqual(alipayFrontendStatus('store-1', 'live'), { enabled: false })
  })
})

test('密钥文件、endpoint、HTTPS callback 和门店灰度全部满足才开放', async () => {
  const keys = keyFiles()
  try {
    await withEnv({
      ALIPAY_ENABLED: '1', ALIPAY_APP_ID: '2026000000000001', ALIPAY_SELLER_ID: '2088000000000001',
      ALIPAY_ENDPOINT: 'https://openapi-sandbox.dl.alipaydev.com', ALIPAY_NOTIFY_URL: 'https://candidate.example/api/payments/alipay/callback',
      ALIPAY_ENABLED_STORES: 'store-1', ALIPAY_PRIVATE_KEY_FILE: keys.privatePath, ALIPAY_PUBLIC_KEY_FILE: keys.publicPath,
    }, () => {
      const config = alipayConfig()
      assert.equal(config.configured, true)
      assert.equal(alipayFrontendStatus('store-1', 'live').enabled, true)
      assert.equal(alipayFrontendStatus('store-2', 'live').enabled, false)
      assert.equal(alipayFrontendStatus('store-1', 'mock').enabled, false)
    })
  } finally { fs.rmSync(keys.dir, { recursive: true, force: true }) }
})

test('非官方 endpoint、HTTP callback 或 SDK debug 任一存在即拒绝启用', async () => {
  const keys = keyFiles()
  try {
    const base = {
      ALIPAY_ENABLED: '1', ALIPAY_APP_ID: '2026000000000001', ALIPAY_SELLER_ID: '2088000000000001',
      ALIPAY_NOTIFY_URL: 'https://candidate.example/callback', ALIPAY_PRIVATE_KEY_FILE: keys.privatePath, ALIPAY_PUBLIC_KEY_FILE: keys.publicPath,
    }
    await withEnv({ ...base, ALIPAY_ENDPOINT: 'https://evil.example' }, () => assert.equal(alipayConfig().configured, false))
    await withEnv({ ...base, ALIPAY_NOTIFY_URL: 'http://candidate.example/callback' }, () => assert.equal(alipayConfig().configured, false))
    await withEnv({ ...base, NODE_DEBUG: 'alipay-sdk' }, () => assert.equal(alipayConfig().configured, false))
  } finally { fs.rmSync(keys.dir, { recursive: true, force: true }) }
})
