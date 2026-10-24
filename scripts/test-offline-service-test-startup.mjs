import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertOfflineServiceTestEnvironment } from './start-offline-service-test.mjs'

const approved = () => ({
  APP_ENV: 'test', BUDU_RUNTIME_MODE: 'active',
  DATABASE_URL: 'postgresql://synthetic:synthetic@budu-sc11a-test-pg:5432/budu_sc11a_test',
  STORE_SERVICE_RUNTIME_ENABLED: '1', STORE_SERVICE_SUBMISSIONS_ENABLED: '1',
  STORE_SERVICE_QR_ENABLED: '1', STORE_SERVICE_SEND_ENABLED: '0',
})

test('TEST entry requires the exact isolated database target and explicit switches', () => {
  assert.deepEqual(assertOfflineServiceTestEnvironment(approved()), { port: 3000 })
  assert.doesNotThrow(() => assertOfflineServiceTestEnvironment({ ...approved(), DATABASE_URL: approved().DATABASE_URL + '?schema=public' }))
  for (const changes of [
    { APP_ENV: 'prod' }, { BUDU_RUNTIME_MODE: 'standby' },
    { DATABASE_URL: 'postgresql://synthetic@127.0.0.1/budu_sc11a_test' },
    { DATABASE_URL: 'postgresql://synthetic@budu-sc11a-test-pg/budu_bj006' },
    { DATABASE_URL: 'postgresql://synthetic@budu-sc11a-test-pg/budu_sc11a_test?host=production' },
    { DATABASE_URL: 'postgresql://synthetic@budu-sc11a-test-pg/budu_sc11a_test?schema=other' },
    { DATABASE_URL: 'postgresql://synthetic@budu-sc11a-test-pg:5433/budu_sc11a_test' },
    { STORE_SERVICE_RUNTIME_ENABLED: '0' }, { STORE_SERVICE_SEND_ENABLED: undefined },
    { STORE_SERVICE_SUBMISSIONS_ENABLED: 'true' }, { PORT: 'NaN' },
  ]) assert.throws(() => assertOfflineServiceTestEnvironment({ ...approved(), ...changes }), /OFFLINE_SERVICE_TEST_/)
})

test('TEST entry rejects unrelated provider workers and notification targets', () => {
  for (const name of ['WECHAT_PAY_ENABLED', 'ALIPAY_ENABLED', 'SWEET_CARD_PRODUCTION_GATEWAY_ENABLED',
    'SWEET_CARD_ONLINE_RUNTIME_ENABLED', 'SWEET_CARD_ONLINE_PAYMENT_ENABLED', 'SWEET_CARD_ONLINE_MERCHANT_ENABLED']) {
    assert.throws(() => assertOfflineServiceTestEnvironment({ ...approved(), [name]: ' 1 ' }), /UNRELATED_RUNTIME/)
    assert.doesNotThrow(() => assertOfflineServiceTestEnvironment({ ...approved(), [name]: '0' }))
  }
  for (const name of ['SENTRY_DSN', 'CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME', 'CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID']) {
    assert.throws(() => assertOfflineServiceTestEnvironment({ ...approved(), [name]: 'synthetic' }), /UNRELATED_EXTERNAL_TARGET/)
  }
})

test('unsafe process launch exits before database, secret-file or application initialization', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./start-offline-service-test.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, APP_ENV: 'prod', DATABASE_URL: 'postgresql://synthetic-secret@example.invalid/prod' },
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), 'OFFLINE_SERVICE_TEST_MODE')
  assert.ok(!result.stderr.includes('synthetic-secret'))
})
