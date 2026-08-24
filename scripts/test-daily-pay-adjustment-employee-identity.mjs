// Gate 9：DailyPayAdjustment 稳定 Employee.id
// A 新稳定写 / B 重复保存幂等 / C 无效 employeeId 400 / D legacy 写 / E migration 安全
// F 无启发式回填 / G 稳定唯一 (employeeId,date) / 重名边界（legacy unique 保留）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const GATE9_MIGRATION = '20260824000008_daily_pay_adjustment_employee_identity'

async function dropSchema(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

// ---------- E: migration 安全（disposable schema，先建旧表再跑 migration） ----------
async function migrationSafety() {
  const { PrismaClient } = await import('@prisma/client')
  const schema = `gate9_migration_${process.pid}_${Date.now().toString(36)}`
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', schema)
  const databaseUrl = url.toString()
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate9-migration-'))
  const tempPrisma = path.join(tempDir, 'prisma')
  fs.mkdirSync(path.join(tempPrisma, 'migrations'), { recursive: true })

  try {
    await admin.$queryRawUnsafe('SELECT 1')
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tempPrisma, 'migrations', 'migration_lock.toml'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === GATE9_MIGRATION) continue
      fs.cpSync(
        path.join(root, 'prisma', 'migrations', entry.name),
        path.join(tempPrisma, 'migrations', entry.name),
        { recursive: true },
      )
    }
    execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', path.join(tempPrisma, 'schema.prisma')], {
      cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', timeout: 180_000,
    })

    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    try {
      // 旧表形态（无 employee_id）插入 legacy 行
      await db.$executeRawUnsafe(`INSERT INTO "daily_pay_adjustments" ("id", "staff_name", "date", "auto_pay_cents_snapshot", "adjusted_pay_cents", "reason", "active", "version", "created_by", "updated_by") VALUES ('legacy-g9', '张伟', DATE '2026-08-20', 10000, 12000, 'test', true, 1, 't', 't')`)
      // 跑 Gate 9 migration
      const sql = fs.readFileSync(path.join(root, 'prisma', 'migrations', GATE9_MIGRATION, 'migration.sql'), 'utf8')
      for (const statement of sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
        await db.$executeRawUnsafe(statement)
      }
      const row = await db.$queryRawUnsafe(`SELECT "employee_id", "staff_name", "auto_pay_cents_snapshot", "adjusted_pay_cents" FROM "daily_pay_adjustments" WHERE "id"='legacy-g9'`)
      assert.equal(row.length, 1, '迁移必须保留 legacy 行')
      assert.equal(row[0].employee_id, null, 'legacy 行保持 employee_id=NULL')
      assert.equal(Number(row[0].auto_pay_cents_snapshot), 10000, '金额快照不变')
      assert.equal(Number(row[0].adjusted_pay_cents), 12000, '调整金额不变')
      console.log('  [E] migration 安全 PASS')
    } finally {
      await db.$disconnect()
    }
  } finally {
    await admin.$disconnect()
    fs.rmSync(tempDir, { recursive: true, force: true })
    await dropSchema(schema)
  }
}

await migrationSafety()

// ---------- API 场景 ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate9-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-9-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate9_adjustment')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }, { key: 'chaowai', name: '北京朝外店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-G9-A', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-G9-B', name: '张伟', currentStoreKey: 'chaowai', status: 'ACTIVE' },
  ],
})
// 值班记录（PUT 校验需要：员工当天有值班 → dailyEntry.staffNames 含姓名）
await prisma.dailyEntry.createMany({
  data: [
    { id: 'de-g9-1', storeKey: 'guanshe', date: new Date('2026-09-01T00:00:00Z'), staffNames: ['张伟'], status: 'draft' },
    { id: 'de-g9-2', storeKey: 'chaowai', date: new Date('2026-09-02T00:00:00Z'), staffNames: ['张伟'], status: 'draft' },
    { id: 'de-g9-3', storeKey: 'guanshe', date: new Date('2026-09-03T00:00:00Z'), staffNames: ['张伟'], status: 'draft' },
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
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate9-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  const put = (body) => request(base, '/v2/daily-pay-adjustments', { cookie, method: 'PUT', body })

  // A: 新稳定写
  const rA = await put({ employeeId: 'emp-A', staffName: '张伟', date: '2026-09-01', autoPayCentsSnapshot: 10000, adjustedPayCents: 12000, reason: 'A' })
  assert.equal(rA.status, 200, `A 应成功: ${await rA.text()}`)
  let row = await prisma.dailyPayAdjustment.findFirst({ where: { employeeId: 'emp-A', date: new Date('2026-09-01T00:00:00Z') } })
  assert.ok(row, 'A 行存在')
  assert.equal(row.employeeId, 'emp-A')
  assert.equal(row.staffName, '张伟')
  console.log('  [A] 新稳定写 PASS')

  // B: 重复保存（同 employeeId+date）→ 同一行，幂等
  const rB1 = await put({ employeeId: 'emp-A', staffName: '张伟', date: '2026-09-01', autoPayCentsSnapshot: 10000, adjustedPayCents: 13000, reason: 'B1', version: row.version })
  const b1json = await rB1.json()
  assert.equal(rB1.status, 200, `B1 应成功`)
  const rB2 = await put({ employeeId: 'emp-A', staffName: '张伟', date: '2026-09-01', autoPayCentsSnapshot: 10000, adjustedPayCents: 13000, reason: 'B2', version: b1json.adjustment.version })
  assert.equal(rB2.status, 200, `B2 应成功: ${await rB2.text()}`)
  const rowsB = await prisma.dailyPayAdjustment.findMany({ where: { employeeId: 'emp-A', date: new Date('2026-09-01T00:00:00Z') } })
  assert.equal(rowsB.length, 1, '重复保存必须仍是 1 行')
  console.log('  [B] 重复保存幂等 PASS')

  // C: 无效 employeeId → 400，无姓名回退
  const rC = await put({ employeeId: 'emp-not-exist', staffName: '张伟', date: '2026-09-02', autoPayCentsSnapshot: 0, adjustedPayCents: 10000, reason: 'C' })
  assert.equal(rC.status, 400, `C 应 400: ${await rC.text()}`)
  assert.equal(await prisma.dailyPayAdjustment.count({ where: { date: new Date('2026-09-02T00:00:00Z') } }), 0, 'C 不得落库')
  console.log('  [C] 无效 employeeId 400 PASS')

  // D: legacy 写（无 employeeId）→ staffName/date 语义继续
  const rD = await put({ staffName: '张伟', date: '2026-09-02', autoPayCentsSnapshot: 8000, adjustedPayCents: 9000, reason: 'D' })
  assert.equal(rD.status, 200, `D 应成功: ${await rD.text()}`)
  row = await prisma.dailyPayAdjustment.findFirst({ where: { staffName: '张伟', date: new Date('2026-09-02T00:00:00Z') } })
  assert.ok(row)
  assert.equal(row.employeeId, null, 'legacy 写 employeeId=NULL')
  console.log('  [D] legacy 写 PASS')

  // F: 无启发式回填——legacy 行保持 NULL（存在名为张伟的当前员工也不回填）
  assert.equal(row.employeeId, null)
  console.log('  [F] 无启发式回填 PASS')

  // G: 稳定唯一 (employeeId, date)——同员工同日不能两条稳定行
  // 直接 DB 插入第二条同 (emp-A, 09-01) → P2002
  let g409 = false
  try {
    await prisma.dailyPayAdjustment.create({
      data: { id: 'g9-dup', employeeId: 'emp-A', staffName: '张伟', date: new Date('2026-09-01T00:00:00Z'), autoPayCentsSnapshot: 1n, adjustedPayCents: 2n, reason: 'dup' },
    })
  } catch (e) {
    g409 = e.code === 'P2002'
  }
  assert.ok(g409, '稳定唯一约束必须拒绝重复 (employeeId,date)')
  console.log('  [G] 稳定唯一 PASS')

  // 重名边界：emp-A 与 emp-B 同名张伟——稳定字段可区分两个 id
  const rB2b = await put({ employeeId: 'emp-B', staffName: '张伟', date: '2026-09-03', autoPayCentsSnapshot: 5000, adjustedPayCents: 6000, reason: 'B2' })
  assert.equal(rB2b.status, 200, `emp-B 应成功: ${await rB2b.text()}`)
  const empBrow = await prisma.dailyPayAdjustment.findFirst({ where: { employeeId: 'emp-B', date: new Date('2026-09-03T00:00:00Z') } })
  assert.equal(empBrow.employeeId, 'emp-B', 'emp-B 的调整归属 emp-B')
  console.log('  [重名边界] 稳定身份可区分两个同名 Employee.id PASS')
  // 同日同名 end-to-end：emp-A 与 emp-B 同日各自调整 → legacy (staffName,date) unique 阻止
  await prisma.dailyEntry.create({ data: { id: 'de-g9-4', storeKey: 'guanshe', date: new Date('2026-09-04T00:00:00Z'), staffNames: ['张伟'], status: 'draft' } })
  const rSameDayA = await put({ employeeId: 'emp-A', staffName: '张伟', date: '2026-09-04', autoPayCentsSnapshot: 100, adjustedPayCents: 200, reason: 'sameA' })
  assert.equal(rSameDayA.status, 200, `同日 emp-A 应成功: ${await rSameDayA.text()}`)
  const rSameDayB = await put({ employeeId: 'emp-B', staffName: '张伟', date: '2026-09-04', autoPayCentsSnapshot: 100, adjustedPayCents: 300, reason: 'sameB' })
  assert.equal(rSameDayB.status, 409, '同日同名第二人应被 legacy (staffName,date) 唯一阻止（EXPECTED DEFERRED）')

  console.log('GATE 9 DAILY PAY ADJUSTMENT EMPLOYEE ID TEST OK')
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
