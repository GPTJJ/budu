import { pathToFileURL } from 'node:url'

// This entry point is exclusively for the existing isolated SC11a TEST stack.
// Migrations are an explicit operator step; importing server/index.js would
// start unrelated workers and is deliberately avoided here.
export function assertOfflineServiceTestEnvironment(env) {
  const fail = code => { throw new Error(`OFFLINE_SERVICE_TEST_${code}`) }
  if (env.APP_ENV !== 'test' || env.BUDU_RUNTIME_MODE !== 'active') fail('MODE')
  let database
  try { database = new URL(env.DATABASE_URL) } catch { fail('DATABASE') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || database.hostname !== 'budu-sc11a-test-pg'
    || !['', '5432'].includes(database.port)
    || database.pathname !== '/budu_sc11a_test'
    || (database.search && database.search !== '?schema=public') || database.hash) fail('DATABASE')
  if (env.STORE_SERVICE_RUNTIME_ENABLED !== '1') fail('RUNTIME_REQUIRED')
  for (const name of ['WECHAT_PAY_ENABLED', 'ALIPAY_ENABLED', 'SWEET_CARD_PRODUCTION_GATEWAY_ENABLED',
    'SWEET_CARD_ONLINE_RUNTIME_ENABLED', 'SWEET_CARD_ONLINE_PAYMENT_ENABLED', 'SWEET_CARD_ONLINE_MERCHANT_ENABLED']) {
    if (!['', '0'].includes(String(env[name] || '').trim())) fail('UNRELATED_RUNTIME')
  }
  // Preserve the existing TEST notification isolation, including legacy H5.
  for (const name of ['SENTRY_DSN', 'CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME', 'CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID']) {
    if (env[name]) fail('UNRELATED_EXTERNAL_TARGET')
  }
  for (const name of ['STORE_SERVICE_SUBMISSIONS_ENABLED', 'STORE_SERVICE_QR_ENABLED', 'STORE_SERVICE_SEND_ENABLED']) {
    if (!['0', '1'].includes(env[name])) fail('EXPLICIT_SERVICE_SWITCHES_REQUIRED')
  }
  const port = Number(env.PORT || 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT')
  return { port }
}

export async function startOfflineServiceTest() {
  const { port } = assertOfflineServiceTestEnvironment(process.env)
  const { validateConfig } = await import('../server/config.js')
  validateConfig()
  const { prisma } = await import('../server/pg.js')
  const { loadStoreServiceConfig, createStoreServiceRuntime } = await import('../server/store-service-api.js')
  const config = loadStoreServiceConfig()
  if (config?.mode !== 'test') throw Error('OFFLINE_SERVICE_TEST_LOGIN_REQUIRED')
  const [identity] = await prisma.$queryRaw`SELECT current_database() AS name`
  if (identity?.name !== 'budu_sc11a_test') throw Error('OFFLINE_SERVICE_TEST_DATABASE_IDENTITY')
  const migrations = await prisma.$queryRaw`SELECT migration_name, finished_at FROM _prisma_migrations WHERE rolled_back_at IS NULL`
  if (migrations.some(row => !row.finished_at)
    || !migrations.some(row => row.migration_name === '20261024120000_offline_store_services' && row.finished_at)) {
    throw Error('OFFLINE_SERVICE_TEST_MIGRATION_REQUIRED')
  }
  const { createApp } = await import('../server/app.js')
  const storeServiceRuntime = createStoreServiceRuntime({ db: prisma, config, deliverInternal: false })
  const app = createApp({ disableStartupTasks: true, storeServiceRuntime })
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '0.0.0.0', () => resolve(listener))
    listener.once('error', reject)
  })
  // This only starts the service outbox when SEND is explicitly enabled.
  storeServiceRuntime.start()
  console.log(`OFFLINE_SERVICE_TEST_READY port=${port} appTasks=${app.locals.buduRuntime.appTasksStarted} processTasks=${app.locals.buduRuntime.processTasksStarted} send=${process.env.STORE_SERVICE_SEND_ENABLED}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    storeServiceRuntime.stop()
    await new Promise(resolve => server.close(resolve))
    await prisma.$disconnect()
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10000)
    deadline.unref()
    close().then(() => process.exit(0), () => process.exit(1))
  })
  return { app, server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startOfflineServiceTest().catch(error => {
    // Driver/configuration errors can carry credentials. Emit only our codes.
    const code = /^OFFLINE_SERVICE_TEST_[A-Z_]+$/.test(error?.message || '') ? error.message : 'OFFLINE_SERVICE_TEST_START_FAILED'
    console.error(code)
    process.exit(1)
  })
}
