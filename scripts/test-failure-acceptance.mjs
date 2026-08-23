// BUDU Data Authority 1.0 — DA-6 Failure Acceptance（进程级隔离）
// 每个场景 spawn 独立 server 进程（pg.js 构造时绑定 DATABASE_URL）：
//   A/B: KV/JSON（db.json）不可用 → 核心业务（PG 域）继续工作
//   C:   PostgreSQL 不可用 → 核心业务明确失败（无 silent fallback）
//   D:   PostgreSQL 恢复 → 接口恢复且不混入 KV 旧数据
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import jwt from 'jsonwebtoken'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const SCHEMA_OK = `fa_ok_${process.pid}`
const PORT = 3457
const JWT_SECRET = 'da6-test-secret-0123456789abcdef0123456789abcdef'

// 带权探针：签发与服务器同密钥的 JWT（PG 停机场景无法登录，但权限校验本身不依赖 PG）
function authCookie() {
  const token = jwt.sign({ sub: 'fa-user-1', name: 'fa_legacy', role: 'developer' }, JWT_SECRET, { expiresIn: '1h' })
  return `budu_token=${token}`
}
async function probe(pathname, opts = {}) {
  return fetch(`http://127.0.0.1:${PORT}/api${pathname}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-fa-'))
process.env.DATA_DIR = dataDir
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  meta: { secret: 'fa-test-secret' },
  users: [{ id: 'fa-user-1', username: 'fa_legacy', role: 'developer', status: 'active', storeKeys: [], staffKey: '', passwordHash: 'x' }],
  entries: { '2026-08|tongying|10': { inc: 9999, ord: 1, staff: [] } },
  staff: [], removedStaff: [], analysis: {}, productImages: {}, stores: [], schedules: {}, products: [], inventoryRequests: [], inventory: [],
}, null, 2))

function schemaUrl(schema) {
  const u = new URL(ADMIN_URL)
  u.searchParams.set('schema', schema)
  return u.toString()
}

async function provision(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const probe = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await probe.$queryRawUnsafe('SELECT 1')
  } catch (error) {
    await probe.$disconnect().catch(() => {})
    throw new Error(`DA6_DB_NOT_RUN — 本地 PostgreSQL 不可用：${error.message}`)
  }
  await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await probe.$disconnect()
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: schemaUrl(schema) },
    stdio: 'ignore',
    timeout: 180000,
  })
  // 播种测试账号（PG 账号权威）
  const { PrismaClient: PC } = await import('@prisma/client')
  const seed = new PC({ datasources: { db: { url: schemaUrl(schema) } } })
  await seed.user.upsert({
    where: { id: 'fa-user-1' },
    update: {},
    create: {
      id: 'fa-user-1', username: 'fa_legacy', passwordHash: 'x', role: 'developer',
      status: 'active', storeKeys: [], staffKey: '', permissions: {},
    },
  })
  await seed.$disconnect()
}

function spawnServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        APP_ENV: 'test',
        DATABASE_URL: env.dbUrl,
        DATA_DIR: env.dataDir,
        JWT_SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const started = Date.now()
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`)
        if (res.ok) {
          clearInterval(timer)
          resolve({ child, out: () => out })
        } else if (Date.now() - started > 25000) {
          clearInterval(timer)
          child.kill('SIGKILL')
          reject(new Error('health 未就绪:\n' + out.slice(-500)))
        }
      } catch { /* 服务未起，重试 */ }
    }, 400)
  })
}

async function stop(child) {
  child.kill('SIGTERM')
  await new Promise((r) => child.once('exit', r))
}

test('DA-6 前置：一次性 PG schema 就绪', async () => {
  await provision(SCHEMA_OK)
})

test('DA-6 A/B: KV/JSON 不可用 → 核心业务（PG 域）继续工作', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-fa-kv-'))
  fs.writeFileSync(path.join(dir, 'db.json'), '{corrupted json!!')
  fs.chmodSync(dir, 0o500)
  fs.chmodSync(path.join(dir, 'db.json'), 0o400)
  const { child } = await spawnServer({ dbUrl: schemaUrl(SCHEMA_OK), dataDir: dir })
  try {
    assert.equal((await probe('/v2/stores')).status, 200, '门店目录（PG）可用')
    assert.equal((await probe('/v2/daily-entries')).status, 200, '业绩（PG）可用')
    assert.equal((await probe('/v2/staff-list')).status, 200, '员工名单（PG）可用')
    assert.equal((await probe('/v2/schedules?weekStart=2026-08-24')).status, 200, '排班（PG）可用')
  } finally {
    await stop(child)
    fs.chmodSync(dir, 0o700)
  }
})

test('DA-6 C: PostgreSQL 不可用 → 核心业务明确失败（无 silent fallback）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-fa-pg-'))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    meta: { secret: 'x' },
    users: [{ id: 'fa-user-1', username: 'fa_legacy', role: 'developer', status: 'active', storeKeys: [], staffKey: '', passwordHash: 'x' }],
    entries: { '2026-08|tongying|10': { inc: 9999, ord: 1, staff: [] } },
  }))
  const { child } = await spawnServer({ dbUrl: schemaUrl('fa_nonexistent_schema'), dataDir: dir })
  try {
    const res = await probe('/v2/daily-entries')
    assert.ok(res.status >= 500, `业绩接口明确失败（实际 ${res.status}）`)
    assert.ok(!(await res.text()).includes('9999'), '不得 silent fallback 返回 KV 旧业绩')
    assert.equal((await probe('/v2/stores')).status, 500, '门店目录明确失败')
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'fa_legacy', password: 'x' }) })).status, 500, '登录（PG 账号权威）明确失败')
  } finally {
    await stop(child)
  }
})

test('DA-6 D: PostgreSQL 恢复 → 接口正常且数据来自 PG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-fa-rec-'))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    meta: { secret: 'x' },
    users: [],
    entries: { '2026-08|tongying|10': { inc: 9999, ord: 1, staff: [] } },
  }))
  const { child } = await spawnServer({ dbUrl: schemaUrl(SCHEMA_OK), dataDir: dir })
  try {
    assert.equal((await probe('/v2/stores')).status, 200, '恢复后门店目录可用')
    const res = await probe('/v2/daily-entries')
    assert.equal(res.status, 200, '恢复后业绩可用')
    assert.ok(!(await res.text()).includes('9999'), '恢复后数据来自 PG，不混入 KV 旧数据')
  } finally {
    await stop(child)
  }
})
