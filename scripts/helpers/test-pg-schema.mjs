// 测试辅助：创建一次性 PostgreSQL database 并在标准 public schema 应用全部迁移。
// 历史函数名保留给现有调用方；返回值现在是独立 database URL，不再是临时 schema URL。
// 必须在动态 import server 模块之前调用（pg.js 构造时绑定 DATABASE_URL）。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const createdDatabases = new Map()
let cleanupRunning = false
let cleanupHooksRegistered = false
let sequence = 0

const syncCleanupScript = `
  import { PrismaClient } from '@prisma/client'
  const admin = new PrismaClient({ datasources: { db: { url: process.env.BUDU_TEST_ADMIN_URL } } })
  const database = process.env.BUDU_TEST_DATABASE_NAME
  const quoted = '"' + database.replaceAll('"', '""') + '"'
  try {
    await admin.$queryRawUnsafe('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', database)
    await admin.$executeRawUnsafe('DROP DATABASE ' + quoted)
  } finally {
    await admin.$disconnect().catch(() => {})
  }
`

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function safeAdminUrl() {
  let url
  try {
    url = new URL(ADMIN_URL)
  } catch {
    throw new Error('PG_DATABASE_TEST_BLOCKED — TEST_DATABASE_URL 不是有效 PostgreSQL URL')
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error('PG_DATABASE_TEST_BLOCKED — TEST_DATABASE_URL 必须使用 PostgreSQL')
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('PG_DATABASE_TEST_BLOCKED — 只允许 loopback 隔离 PostgreSQL test instance')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database || database.toLowerCase() === 'budu_bj006' || /(^|[_-])prod(uction)?([_-]|$)/i.test(database)) {
    throw new Error('PG_DATABASE_TEST_BLOCKED — 管理连接可能指向 active production database')
  }
  url.searchParams.delete('schema')
  return url
}

function printTarget(url, database, classification) {
  console.log(`[PG_TEST_TARGET] host=${url.hostname} port=${url.port || '5432'} database=${database} environment=${classification}`)
}

async function dropExactDatabase(database) {
  const adminUrl = createdDatabases.get(database)
  if (!adminUrl) throw new Error(`PG_DATABASE_CLEANUP_BLOCKED — ${database} 不是本进程创建的 exact database`)
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  try {
    await admin.$queryRawUnsafe('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', database)
    await admin.$executeRawUnsafe(`DROP DATABASE ${quotedIdentifier(database)}`)
    createdDatabases.delete(database)
    console.log(`[PG_TEST_CLEANUP] database=${database} result=DROPPED`)
  } finally {
    await admin.$disconnect().catch(() => {})
  }
}

async function cleanupAllCreatedDatabases() {
  if (cleanupRunning || createdDatabases.size === 0) return
  cleanupRunning = true
  try {
    for (const database of [...createdDatabases.keys()]) await dropExactDatabase(database)
  } finally {
    cleanupRunning = false
  }
}

function registerCleanupHooks() {
  if (cleanupHooksRegistered) return
  cleanupHooksRegistered = true
  process.on('beforeExit', cleanupAllCreatedDatabases)
  process.on('exit', cleanupAllCreatedDatabasesSync)
  process.once('SIGINT', () => { cleanupAllCreatedDatabasesSync(); process.exit(130) })
  process.once('SIGTERM', () => { cleanupAllCreatedDatabasesSync(); process.exit(143) })
}

function cleanupAllCreatedDatabasesSync() {
  for (const [database, adminUrl] of createdDatabases) {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', syncCleanupScript], {
        cwd: root,
        env: { ...process.env, BUDU_TEST_ADMIN_URL: adminUrl, BUDU_TEST_DATABASE_NAME: database },
        stdio: 'inherit',
        timeout: 30000,
      })
      createdDatabases.delete(database)
      console.log(`[PG_TEST_CLEANUP] database=${database} result=DROPPED_ON_EXIT`)
    } catch (error) {
      console.error(`[PG_TEST_CLEANUP] database=${database} result=FAILED_ON_EXIT message=${error.message}`)
    }
  }
}

export async function createDisposablePgDatabase(prefix = 'fullcritical', { applyMigrations = true } = {}) {
  const adminUrl = safeAdminUrl()
  const normalizedPrefix = String(prefix).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'fullcritical'
  const unique = `${process.pid}_${Date.now().toString(36)}_${sequence++}`
  const database = `budu_fullcritical_${normalizedPrefix}_${unique}`.slice(0, 63)
  if (!database.startsWith('budu_fullcritical_') || database === decodeURIComponent(adminUrl.pathname.slice(1))) {
    throw new Error('PG_DATABASE_TEST_BLOCKED — disposable database identity 无效')
  }

  const { PrismaClient } = await import('@prisma/client')
  const adminUrlString = adminUrl.toString()
  const probe = new PrismaClient({ datasources: { db: { url: adminUrlString } } })
  printTarget(adminUrl, decodeURIComponent(adminUrl.pathname.slice(1)), 'ISOLATED_TEST_ADMIN')
  printTarget(adminUrl, database, 'EPHEMERAL_TEST_DATABASE')
  try {
    await probe.$queryRawUnsafe('SELECT 1')
    await probe.$executeRawUnsafe(`CREATE DATABASE ${quotedIdentifier(database)} WITH TEMPLATE template0 ENCODING 'UTF8'`)
  } catch (error) {
    throw new Error(`PG_DATABASE_TEST_NOT_RUN — 隔离 PostgreSQL 不可用或无法创建database：${error.message}`)
  } finally {
    await probe.$disconnect().catch(() => {})
  }

  createdDatabases.set(database, adminUrlString)
  registerCleanupHooks()
  const databaseUrl = new URL(adminUrlString)
  databaseUrl.pathname = `/${database}`
  databaseUrl.searchParams.delete('schema')
  if (applyMigrations) {
    try {
      execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
        stdio: 'inherit',
        timeout: 180000,
      })
    } catch (error) {
      await dropExactDatabase(database).catch(() => {})
      throw error
    }
  }
  return databaseUrl.toString()
}

export async function createDisposablePgSchema(prefix = 'fullcritical') {
  return createDisposablePgDatabase(prefix)
}

export async function dropDisposablePgDatabase(databaseUrl) {
  const url = new URL(databaseUrl)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  await dropExactDatabase(database)
}

export function disposablePgDatabaseName(databaseUrl) {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''))
}
