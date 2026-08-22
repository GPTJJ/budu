// 微信支付配置 fail-closed 校验测试（不连接外部；证书/密钥用 openssl 临时生成）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { wechatPayConfig, validateCertificate } from '../server/payments/wechat-config.js'

const VALID_KEY = '0123456789abcdef0123456789abcdef'
const VALID_ENV = {
  WECHAT_PAY_ENABLED: '1',
  WECHAT_PAY_PROTOCOL: 'v2_micropay',
  WECHAT_PAY_MCHID: '1900000109',
  WECHAT_PAY_APPID: 'wx8888888888888888',
  WECHAT_PAY_TERMINAL_IP: '203.0.113.10',
}

let fixture = null
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-wx-test-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '30', '-subj', '/CN=budu-test'], { stdio: 'ignore' })
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-wx-test2-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(other, 'key.pem'), '-out', path.join(other, 'cert.pem'), '-days', '30', '-subj', '/CN=budu-other'], { stdio: 'ignore' })
  fixture = {
    dir,
    cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
    key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
    otherCert: fs.readFileSync(path.join(other, 'cert.pem'), 'utf8'),
    otherKey: fs.readFileSync(path.join(other, 'key.pem'), 'utf8'),
  }
} catch {
  fixture = null
}

function withEnv(overrides, fn) {
  const saved = {}
  const keys = new Set([...Object.keys(VALID_ENV), ...Object.keys(overrides), 'WECHAT_PAY_API_V2_KEY_FILE', 'WECHAT_PAY_CERT_FILE', 'WECHAT_PAY_PRIVATE_KEY_FILE'])
  for (const key of keys) {
    saved[key] = process.env[key]
  }
  for (const [key, value] of Object.entries(VALID_ENV)) process.env[key] = value
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function writeSecret(dir, name, content) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content, { mode: 0o600 })
  return file
}

test('F：配置完整且密钥/证书/私钥匹配时 configured=true', { skip: !fixture }, () => {
  withEnv(
    {
      WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'apiv2.key', VALID_KEY),
      WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
      WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.key),
    },
    () => {
      const config = wechatPayConfig()
      assert.equal(config.configured, true, config.reason)
      assert.equal(config.enabled, true)
    },
  )
})

test('F：APIv2 密钥过短/非法 → configured=false', { skip: !fixture }, () => {
  withEnv(
    {
      WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'short.key', 'abc'),
      WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
      WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.key),
    },
    () => {
      const config = wechatPayConfig()
      assert.equal(config.configured, false)
      assert.match(config.reason, /APIv2 密钥无效/)
    },
  )
})

test('F：伪造证书文本 → configured=false', { skip: !fixture }, () => {
  withEnv(
    {
      WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'apiv2.key', VALID_KEY),
      WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'fake.pem', '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----'),
      WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.key),
    },
    () => {
      const config = wechatPayConfig()
      assert.equal(config.configured, false)
      assert.match(config.reason, /证书/)
    },
  )
})

test('F：伪造私钥 → configured=false', { skip: !fixture }, () => {
  withEnv(
    {
      WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'apiv2.key', VALID_KEY),
      WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
      WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'fake.key', 'not a private key'),
    },
    () => {
      const config = wechatPayConfig()
      assert.equal(config.configured, false)
      assert.match(config.reason, /私钥/)
    },
  )
})

test('F：证书与私钥不匹配 → configured=false', { skip: !fixture }, () => {
  withEnv(
    {
      WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'apiv2.key', VALID_KEY),
      WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
      WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.otherKey),
    },
    () => {
      const config = wechatPayConfig()
      assert.equal(config.configured, false)
      assert.match(config.reason, /不匹配/)
    },
  )
})

test('F：证书过期 / 尚未生效（注入时间确定性验证）', { skip: !fixture }, () => {
  const valid = validateCertificate(fixture.cert)
  assert.equal(valid.ok, true)
  const expired = validateCertificate(fixture.cert, Date.now() + 400 * 24 * 3600 * 1000)
  assert.equal(expired.ok, false)
  assert.match(expired.reason, /过期/)
  const notYet = validateCertificate(fixture.cert, Date.now() - 400 * 24 * 3600 * 1000)
  assert.equal(notYet.ok, false)
  assert.match(notYet.reason, /尚未生效/)
})

test('F：终端 IP 为空/回环 → configured=false', { skip: !fixture }, () => {
  for (const ip of ['', '127.0.0.1', '0.0.0.0', '::1', 'abc']) {
    withEnv(
      {
        WECHAT_PAY_TERMINAL_IP: ip,
        WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'apiv2.key', VALID_KEY),
        WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
        WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.key),
      },
      () => {
        const config = wechatPayConfig()
        assert.equal(config.configured, false, `IP=${ip} 不应通过`)
      },
    )
  }
})

test('F：缺失商户号 / AppID → configured=false', { skip: !fixture }, () => {
  for (const override of [{ WECHAT_PAY_MCHID: '' }, { WECHAT_PAY_APPID: '' }, { WECHAT_PAY_MCHID: 'abc' }, { WECHAT_PAY_APPID: 'wx' }]) {
    withEnv(
      {
        ...override,
        WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'apiv2.key', VALID_KEY),
        WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
        WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.key),
      },
      () => {
        const config = wechatPayConfig()
        assert.equal(config.configured, false)
      },
    )
  }
})

test('F：配置非法时即使 ENABLED=1 也保持不可用（fail closed）', { skip: !fixture }, () => {
  withEnv(
    {
      WECHAT_PAY_ENABLED: '1',
      WECHAT_PAY_API_V2_KEY_FILE: writeSecret(fixture.dir, 'short.key', 'too-short'),
      WECHAT_PAY_CERT_FILE: writeSecret(fixture.dir, 'cert.pem', fixture.cert),
      WECHAT_PAY_PRIVATE_KEY_FILE: writeSecret(fixture.dir, 'key.pem', fixture.key),
    },
    () => {
      const config = wechatPayConfig()
      assert.equal(config.configured, false)
      assert.equal(config.enabled && config.configured, false)
    },
  )
})
