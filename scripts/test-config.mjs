import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const probe = `
  import { validateConfig } from './server/config.js'
  validateConfig()
`

function validate(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: 'prod',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    POSTGRES_USER: 'test',
    POSTGRES_PASSWORD: 'test',
    ...overrides,
  }
  return spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
}

test('prod 配置：显式文件存储允许自建服务器持久卷', () => {
  const result = validate({ DATA_STORE: 'file', DATA_DIR: '/app/server/data' })
  assert.equal(result.status, 0, result.stderr)
})

test('prod 配置：未显式选择文件存储时必须有完整 Redis/KV 配置', () => {
  const missing = validate()
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /必须配置 Redis\/KV/)

  const kv = validate({ KV_REST_API_URL: 'https://example.invalid', KV_REST_API_TOKEN: 'test-token' })
  assert.equal(kv.status, 0, kv.stderr)

  const upstash = validate({ DATA_STORE: 'redis', UPSTASH_REDIS_REST_URL: 'https://example.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-token' })
  assert.equal(upstash.status, 0, upstash.stderr)
})

test('prod 配置：文件存储要求显式 DATA_DIR，非法模式拒绝启动', () => {
  const missingDir = validate({ DATA_STORE: 'file' })
  assert.notEqual(missingDir.status, 0)
  assert.match(missingDir.stderr, /DATA_DIR/)

  const invalid = validate({ DATA_STORE: 'unknown', DATA_DIR: '/tmp/test' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /仅支持 file\/redis/)
})
