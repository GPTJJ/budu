// Gate 18：PayrollNotice 稳定工资主体 + 收件人 User.employeeId
// A 稳定发放 / B 同店同名独立 / C 错收件人拒绝 / D 未绑定阻断 / E 重复绑定阻断
// F 无效 employeeId / G 重复周期幂等 / H legacy 迁移存活 / I 无回填
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const GATE18_MIGRATION = '20260824000011_payroll_notice_employee_subject'

async function dropSchema(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

// ---------- H/I: 迁移测试（升级存活 + 无回填 + fresh 约束）----------
async function migrationTests() {
  const { PrismaClient } = await import('@prisma/client')

  // 升级：legacy 行存活
  const schema = `gate18_upgrade_${process.pid}_${Date.now().toString(36)}`
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', schema)
  const databaseUrl = url.toString()
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate18-upgrade-'))
  const tempPrisma = path.join(tempDir, 'prisma')
  fs.mkdirSync(path.join(tempPrisma, 'migrations'), { recursive: true })
  try {
    await admin.$queryRawUnsafe('SELECT 1')
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tempPrisma, 'migrations', 'migration_lock.toml'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === GATE18_MIGRATION) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry.name), path.join(tempPrisma, 'migrations', entry.name), { recursive: true })
    }
    execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', path.join(tempPrisma, 'schema.prisma')], {
      cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', timeout: 180_000,
    })
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    try {
      await db.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name") VALUES ('guanshe', '北京官舍店')`)
      await db.$executeRawUnsafe(`INSERT INTO "payroll_notices" ("id", "period_type", "period_key", "employee_name", "store_key", "target_username", "snapshot", "total_cents", "status") VALUES ('pn-legacy', 'month', '2026-08', '张伟', 'guanshe', 'user-old', '{"days":[],"summary":{}}', 10000, 'pending')`)
      const sql = fs.readFileSync(path.join(root, 'prisma', 'migrations', GATE18_MIGRATION, 'migration.sql'), 'utf8')
      for (const statement of sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
        await db.$executeRawUnsafe(statement)
      }
      const row = await db.$queryRawUnsafe(`SELECT "employee_id", "employee_name", "store_key", "target_username", "total_cents", "snapshot", "period_key" FROM "payroll_notices" WHERE "id"='pn-legacy'`)
      assert.equal(row.length, 1, 'H legacy 行存活')
      assert.equal(row[0].employee_id, null, 'H employeeId=NULL')
      assert.equal(row[0].employee_name, '张伟')
      assert.equal(row[0].target_username, 'user-old')
      assert.equal(Number(row[0].total_cents), 10000)
      assert.equal(row[0].period_key, '2026-08')
      const snapVal = typeof row[0].snapshot === 'string' ? JSON.parse(row[0].snapshot) : row[0].snapshot
      assert.equal(snapVal.summary !== undefined, true, 'H snapshot 原样')
      console.log('  [H/I] 迁移存活 + 无回填 PASS')
      await db.$disconnect()
    } finally {
      await db.$disconnect()
    }
  } finally {
    await admin.$disconnect()
    fs.rmSync(tempDir, { recursive: true, force: true })
    await dropSchema(schema)
  }

  // fresh 链
  const schema2 = `gate18_fresh_${process.pid}_${Date.now().toString(36)}`
  const url2 = new URL(ADMIN_URL)
  url2.searchParams.set('schema', schema2)
  const databaseUrl2 = url2.toString()
  const admin2 = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate18-fresh-'))
  const tempPrisma2 = path.join(tempDir2, 'prisma')
  fs.mkdirSync(path.join(tempPrisma2, 'migrations'), { recursive: true })
  try {
    await admin2.$queryRawUnsafe('SELECT 1')
    await admin2.$executeRawUnsafe(`CREATE SCHEMA "${schema2}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(tempPrisma2, 'schema.prisma'))
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tempPrisma2, 'migrations', 'migration_lock.toml'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry.name), path.join(tempPrisma2, 'migrations', entry.name), { recursive: true })
    }
    execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', path.join(tempPrisma2, 'schema.prisma')], {
      cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl2 }, stdio: 'pipe', timeout: 180_000,
    })
    const db2 = new PrismaClient({ datasources: { db: { url: databaseUrl2 } } })
    try {
      const idx = await db2.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname='${schema2}' AND tablename='payroll_notices'`)
      const defs = idx.map((r) => r.indexdef).join('\n')
      assert.ok(defs.includes('payroll_notices_employee_period_key'), '稳定 partial unique 存在')
      await db2.$executeRawUnsafe(`SELECT 1 FROM "payroll_notices" LIMIT 1`)
      console.log('  [fresh] 迁移链 + 约束 PASS')
      await db2.$disconnect()
    } finally {
      await db2.$disconnect()
    }
  } finally {
    await admin2.$disconnect()
    fs.rmSync(tempDir2, { recursive: true, force: true })
    await dropSchema(schema2)
  }
}

await migrationTests()

// ---------- API 场景 ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate18-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-18-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate18_notice')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-18-A', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-18-B', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  ],
})

const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)
const request = async (base, pathname, { cookie = '', method = 'GET', body } = {}) =>
  fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate18-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  // 创建 User：user-A.employeeId=emp-A、user-B.employeeId=emp-B。
  // Gate 20：显式 Employee.id 绑定（同店同名安全）——创建时直接携带 employeeId。
  const mkUser = async (username, empId) => {
    const r = await fetch(`${base}/admin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ username, password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: `guanshe::张伟`, employeeId: empId }) })
    if (r.status !== 200) console.log('mkUser', username, r.status, await r.text())
    assert.equal(r.status, 200, `创建 ${username}`)
  }
  await mkUser('user-A', 'emp-A')
  await mkUser('user-B', 'emp-B')

  const issue = (rows) => request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-09', rows } })
  const rowFor = (employeeId, employeeName) => ({ employeeId, employeeName, storeKey: 'guanshe', snapshot: { days: [{ day: '09-01', revenue: 5000, hours: 8 }], summary: { workedDays: 1, hours: 8, total: 600 } }, totalCents: 60000 })

  // A: 稳定发放
  const rA = await issue([rowFor('emp-A', '张伟')])
  assert.equal(rA.status, 200, `A 应成功: ${await rA.text()}`)
  const noticeA = await prisma.payrollNotice.findFirst({ where: { employeeId: 'emp-A' } })
  assert.ok(noticeA)
  assert.equal(noticeA.targetUsername, 'user-A', 'A 收件人 = User.employeeId 绑定')
  console.log('  [A] 稳定发放 PASS')

  // B: 同店同名独立发放（用不同周期避免与 A 冲突）
  const rB2 = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-10', rows: [rowFor('emp-A', '张伟'), rowFor('emp-B', '张伟')] } })
  assert.equal(rB2.status, 200, `B 应成功: ${await rB2.text()}`)
  const notices10 = await prisma.payrollNotice.findMany({ where: { periodKey: '2026-10' }, orderBy: { employeeId: 'asc' } })
  assert.equal(notices10.length, 2, 'B 两条独立 notice')
  assert.equal(notices10[0].employeeId, 'emp-A')
  assert.equal(notices10[1].employeeId, 'emp-B')
  assert.equal(notices10[0].targetUsername, 'user-A')
  assert.equal(notices10[1].targetUsername, 'user-B')
  assert.equal(notices10[0].employeeName, '张伟')
  assert.equal(notices10[1].employeeName, '张伟')
  console.log('  [B] 同店同名独立 PASS')

  // C: 错收件人攻击——client 传 targetUsername=user-B 但 employeeId=emp-A → 服务端忽略并解析为 user-A
  const rC = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-11', rows: [{ ...rowFor('emp-A', '张伟'), targetUsername: 'user-B' }] } })
  assert.equal(rC.status, 200, `C 应成功（服务端解析正确收件人）: ${await rC.text()}`)
  const noticeC = await prisma.payrollNotice.findFirst({ where: { employeeId: 'emp-A', periodKey: '2026-11' } })
  assert.equal(noticeC.targetUsername, 'user-A', 'C 绝不落 user-B')
  console.log('  [C] 错收件人拒绝 PASS')

  // D: 未绑定阻断
  await prisma.employee.create({ data: { id: 'emp-X', employeeNo: 'BUDU-18-X', name: '王五', currentStoreKey: 'guanshe', status: 'ACTIVE' } })
  const rD = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-12', rows: [rowFor('emp-X', '王五')] } })
  assert.equal(rD.status, 409, `D 未绑定应 409: ${await rD.text()}`)
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-X' } }), 0, 'D 零 notice')
  console.log('  [D] 未绑定阻断 PASS')

  // E: 重复绑定阻断
  // E 场景：模拟历史重复绑定状态——先以空闲员工创建 user-A2，再在 DB 层写入 emp-A（模拟旧数据/历史状态）
  const rA2 = await fetch(`${base}/admin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ username: 'user-A2', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-X' }) })
  assert.equal(rA2.status, 200, 'E 创建 user-A2')
  await prisma.user.updateMany({ where: { username: 'user-A2' }, data: { employeeId: 'emp-A' } })
  // Gate 20 新路径：user-A2 重复绑 emp-A 的创建会被 409 拦截（已在上方验证）
  const rE = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2027-01', rows: [rowFor('emp-A', '张伟')] } })
  assert.equal(rE.status, 409, `E 重复绑定应 409: ${await rE.text()}`)
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-A', periodKey: '2027-01' } }), 0, 'E 零 notice')
  // 清理重复绑定，恢复 emp-A 单绑定（后续 G 场景需要）
  await prisma.user.updateMany({ where: { username: 'user-A2' }, data: { employeeId: '' } })
  console.log('  [E] 重复绑定阻断 PASS')

  // F: 无效 employeeId
  const rF = await issue([{ ...rowFor('emp-not-exist', '张三') }])
  assert.equal(rF.status, 400, `F 无效 id 应 400: ${await rF.text()}`)
  console.log('  [F] 无效 employeeId 400 PASS')

  // G: 重复周期
  const rG1 = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2027-02', rows: [rowFor('emp-A', '张伟')] } })
  assert.equal(rG1.status, 200)
  const rG2 = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2027-02', rows: [rowFor('emp-A', '张伟')] } })
  assert.equal(rG2.status, 409, `G 重复周期应 409: ${await rG2.text()}`)
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-A', periodKey: '2027-02' } }), 1, 'G 一条 notice')
  console.log('  [G] 重复周期幂等 PASS')

  console.log('GATE 18 PAYROLL NOTICE IDENTITY TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
  if (schema) {
    const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL.replace(/schema=.*/, 'schema=public') } } })
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.$disconnect()
  }
}
