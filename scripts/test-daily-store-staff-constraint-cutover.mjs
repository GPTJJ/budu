// Gate 16：DailyStoreStaff 稳定身份约束切换
// 同店/同日/同名员工共存；stable(employeeId) 唯一、legacy(staffId) 部分唯一；
// legacy 行不被稳定名单删除/升级；mixed payload 判重身份化
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const GATE16_MIGRATION = '20260824000010_daily_store_staff_legacy_staff_id_partial'
const POST_GATE16_MIGRATIONS = [
  '20260824000010_daily_store_staff_legacy_staff_id_partial',
  '20260824000011_payroll_notice_employee_subject',
  '20260824000012_payroll_participant_authority',
  '20260827000013_historical_payable_hours_authority',
  '20260828000014_payroll_notice_period_range',
]

async function dropSchema(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

// ---------- migration 测试（升级：既有数据存活；fresh：约束存在）----------
async function migrationTests() {
  const { PrismaClient } = await import('@prisma/client')

  // === 升级迁移：既有行逐字节保留 ===
  const schema = `gate16_upgrade_${process.pid}_${Date.now().toString(36)}`
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', schema)
  const databaseUrl = url.toString()
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate16-upgrade-'))
  const tempPrisma = path.join(tempDir, 'prisma')
  fs.mkdirSync(path.join(tempPrisma, 'migrations'), { recursive: true })
  try {
    await admin.$queryRawUnsafe('SELECT 1')
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tempPrisma, 'migrations', 'migration_lock.toml'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (!entry.isDirectory() || POST_GATE16_MIGRATIONS.includes(entry.name)) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry.name), path.join(tempPrisma, 'migrations', entry.name), { recursive: true })
    }
    execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', path.join(tempPrisma, 'schema.prisma')], {
      cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', timeout: 180_000,
    })
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    try {
      await db.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name") VALUES ('guanshe', '北京官舍店')`)
      await db.$executeRawUnsafe(`INSERT INTO "employees" ("id", "employee_no", "name", "current_store_key", "status") VALUES ('emp-A', 'BUDU-16-A', '张伟', 'guanshe', 'ACTIVE')`)
      await db.$executeRawUnsafe(`INSERT INTO "employees" ("id", "employee_no", "name", "current_store_key", "status") VALUES ('emp-B', 'BUDU-16-B', '张伟', 'guanshe', 'ACTIVE')`)
      // A. stable 行；B. legacy NULL 行；C. 多条 legacy 不同 staffId；D. 历史值
      await db.$executeRawUnsafe(`INSERT INTO "daily_store_staff" ("id", "store_id", "date", "employee_id", "staff_id", "staff_name_snapshot", "scheduled_hours", "actual_hours", "attendance_status", "source") VALUES ('dss-stable', 'guanshe', DATE '2026-09-01', 'emp-A', 'st-guanshe-a', '张伟', 8, 7.5, 'normal', 'manual')`)
      await db.$executeRawUnsafe(`INSERT INTO "daily_store_staff" ("id", "store_id", "date", "employee_id", "staff_id", "staff_name_snapshot", "actual_hours") VALUES ('dss-legacy', 'guanshe', DATE '2026-09-02', NULL, 'st-guanshe-legacy', '王五', 4)`)
      await db.$executeRawUnsafe(`INSERT INTO "daily_store_staff" ("id", "store_id", "date", "employee_id", "staff_id", "staff_name_snapshot", "actual_hours") VALUES ('dss-legacy2', 'guanshe', DATE '2026-09-03', NULL, 'st-guanshe-legacy2', '赵六', 5)`)
      // 跑 Gate 16 migration
      const sql = fs.readFileSync(path.join(root, 'prisma', 'migrations', GATE16_MIGRATION, 'migration.sql'), 'utf8')
      for (const statement of sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
        await db.$executeRawUnsafe(statement)
      }
      const rows = await db.$queryRawUnsafe(`SELECT "id", "employee_id", "staff_id", "staff_name_snapshot", "actual_hours" FROM "daily_store_staff" ORDER BY "id"`)
      assert.equal(rows.length, 3, '迁移后 3 行全存活')
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
      assert.equal(byId['dss-stable'].employee_id, 'emp-A')
      assert.equal(byId['dss-stable'].staff_id, 'st-guanshe-a')
      assert.equal(Number(byId['dss-stable'].actual_hours), 7.5)
      assert.equal(byId['dss-legacy'].employee_id, null, 'legacy 保持 NULL')
      assert.equal(byId['dss-legacy'].staff_name_snapshot, '王五')
      assert.equal(byId['dss-legacy2'].staff_id, 'st-guanshe-legacy2')
      // 约束验证：legacy partial unique 存在；全量 staffId unique 已移除
      const idx = await db.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname='${schema}' AND tablename='daily_store_staff'`)
      const defs = idx.map((r) => r.indexdef).join('\n')
      assert.ok(defs.includes('daily_store_staff_store_id_date_employee_id_key'), '稳定 unique 保留')
      assert.ok(!defs.includes('daily_store_staff_store_id_date_staff_id_key'), '全量 staffId unique 移除')
      assert.ok(defs.includes('daily_store_staff_legacy_staff_id_key') && defs.includes('WHERE (employee_id IS NULL)'), 'legacy partial unique 存在')
      // legacy partial 保护生效：同 store/date/staffId 第二条 NULL 行拒绝
      let legacyDup = false
      try {
        await db.$executeRawUnsafe(`INSERT INTO "daily_store_staff" ("id", "store_id", "date", "employee_id", "staff_id", "staff_name_snapshot") VALUES ('dss-legacy-dup', 'guanshe', DATE '2026-09-02', NULL, 'st-guanshe-legacy', '王五')`)
      } catch (e) {
        legacyDup = true
      }
      assert.ok(legacyDup, 'legacy partial unique 拒绝重复 NULL 行')
      // 稳定同 staffId 两行允许（全量 unique 已移除）
      try {
        await db.$executeRawUnsafe(`INSERT INTO "daily_store_staff" ("id", "store_id", "date", "employee_id", "staff_id", "staff_name_snapshot") VALUES ('dss-stable2', 'guanshe', DATE '2026-09-01', 'emp-B', 'st-guanshe-a', '张伟')`)
      } catch (e) {
        console.log('  stable2 insert err:', e.code)
        throw e
      }
      console.log('  [升级迁移] 数据存活 + 约束正确 PASS')
      await db.$disconnect()
    } finally {
      await db.$disconnect()
    }
  } finally {
    await admin.$disconnect()
    fs.rmSync(tempDir, { recursive: true, force: true })
    await dropSchema(schema)
  }

  // === fresh 迁移链 ===
  const schema2 = `gate16_fresh_${process.pid}_${Date.now().toString(36)}`
  const url2 = new URL(ADMIN_URL)
  url2.searchParams.set('schema', schema2)
  const databaseUrl2 = url2.toString()
  const admin2 = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate16-fresh-'))
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
      await db2.$executeRawUnsafe(`SELECT 1 FROM "daily_store_staff" LIMIT 1`)
      const idx = await db2.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname='${schema2}' AND tablename='daily_store_staff'`)
      const defs = idx.map((r) => r.indexdef).join('\n')
      assert.ok(defs.includes('daily_store_staff_store_id_date_employee_id_key'))
      assert.ok(!defs.includes('daily_store_staff_store_id_date_staff_id_key'))
      assert.ok(defs.includes('daily_store_staff_legacy_staff_id_key'))
      console.log('  [fresh 迁移] 全链应用 + 约束唯一 PASS')
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

// ---------- API 场景（disposable schema + createApp）----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate16-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-16-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate16_cutover')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-16-A', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-16-B', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  ],
})
await prisma.dailyEntry.create({ data: { id: 'de-16-1', storeKey: 'guanshe', date: new Date('2026-09-10T00:00:00Z'), staffNames: ['张伟', '张伟'], status: 'draft' } })

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
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate16-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  const save = (items) => request(base, '/v2/daily-staff', { cookie, method: 'PUT', body: { storeKey: 'guanshe', date: '2026-09-10', items, reason: 'Gate 16' } })
  const item = (employeeId, staffId, name) => ({ employeeId, staffId, staffName: name, breakMinutes: 0, scheduledHours: 8, actualHours: 8 })

  // §12: 同店同名两稳定行共存
  const r1 = await save([item('emp-A', 'st-guanshe-张伟', '张伟'), item('emp-B', 'st-guanshe-张伟', '张伟')])
  assert.equal(r1.status, 200, `同店同名应成功: ${await r1.text()}`)
  let rows = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'guanshe', date: new Date('2026-09-10T00:00:00Z') }, orderBy: { employeeId: 'asc' } })
  assert.equal(rows.length, 2, '两行共存')
  assert.equal(rows[0].employeeId, 'emp-A')
  assert.equal(rows[1].employeeId, 'emp-B')
  assert.deepEqual(rows.map((row) => row.staffId), ['employee:emp-A', 'employee:emp-B'], 'staffId 由服务器按稳定身份派生')
  console.log('  [§12] 同店同名共存 PASS')

  // §13: replay 幂等
  const r2 = await save([item('emp-A', 'st-guanshe-张伟', '张伟'), item('emp-B', 'st-guanshe-张伟', '张伟')])
  assert.equal(r2.status, 200)
  rows = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'guanshe', date: new Date('2026-09-10T00:00:00Z') } })
  assert.equal(rows.length, 2, 'replay 仍 2 行')
  console.log('  [§13] replay 幂等 PASS')

  // §14: 重复员工拒绝
  const r3 = await save([item('emp-A', 'x', '张伟'), item('emp-A', 'y', '张伟')])
  assert.equal(r3.status, 409, '重复 emp-A 应 409')
  console.log('  [§14] 重复员工 409 PASS')

  // §16: 稳定同 staffId 两行（已由 §12 证明）→ 单测已证

  // §17: legacy + stable 共存，legacy 不被改写/删除
  await prisma.dailyStoreStaff.create({
    data: { id: 'legacy-17', storeId: 'guanshe', date: new Date('2026-09-11T00:00:00Z'), employeeId: null, staffId: 'st-guanshe-张伟', staffNameSnapshot: '张伟', actualHours: 4 },
  })
  await prisma.dailyEntry.create({ data: { id: 'de-16-2', storeKey: 'guanshe', date: new Date('2026-09-11T00:00:00Z'), staffNames: ['张伟'], status: 'draft' } })
  const r17 = await save2(base, cookie, '2026-09-11', [item('emp-A', 'st-guanshe-张伟', '张伟')])
  assert.equal(r17.status, 200, `legacy+stable 提交应成功: ${await r17.text()}`)
  const legacyRow = await prisma.dailyStoreStaff.findUnique({ where: { id: 'legacy-17' } })
  assert.equal(legacyRow.employeeId, null, 'legacy 行保持 NULL（不被升级）')
  assert.equal(legacyRow.staffNameSnapshot, '张伟', 'legacy 快照不变')
  const stable17 = await prisma.dailyStoreStaff.findFirst({ where: { employeeId: 'emp-A', date: new Date('2026-09-11T00:00:00Z') } })
  assert.ok(stable17, 'stable 行独立存在')
  assert.equal(stable17.id !== 'legacy-17', true, '非同一行')
  assert.equal(await prisma.dailyStoreStaff.count({ where: { date: new Date('2026-09-11T00:00:00Z') } }), 2, 'legacy + stable 两行共存')
  console.log('  [§17] legacy+stable 共存 PASS')

  // §18: 无效 employeeId 400
  const r18 = await save([item('emp-not-exist', 'x', '张三')])
  assert.equal(r18.status, 400, '无效 employeeId 应 400')
  console.log('  [§18] 无效 employeeId 400 PASS')

  // §15: Gate 29N 后新写必须使用稳定 target；legacy partial unique 仅保护历史行。
  const r15a = await save2(base, cookie, '2026-09-12', [item(null, 'st-legacy-x', '王五')])
  assert.equal(r15a.status, 400, '无稳定 target 的 legacy 新写必须拒绝')
  const r15b = await save2(base, cookie, '2026-09-12', [item(null, 'st-legacy-x', '王五')])
  assert.equal(r15b.status, 400)
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'guanshe', date: new Date('2026-09-12T00:00:00Z') } }), 0, '拒绝不得造历史行')
  console.log('  [§15] legacy 新写 fail closed PASS')

  // §22: shadow payroll 证明——同店同名 2 员工 + share=2
  const { calculateEmployeeIdShadowPayroll } = await import(path.join(root, 'src/utils/payrollShadowCalculator.js').replaceAll('\\', '/'))
  const entries = { '2026-09|guanshe|09-10': { inc: 10000, ord: 100, staff: ['张伟', '张伟'] } }
  const staffRows = (await prisma.dailyStoreStaff.findMany({ where: { storeId: 'guanshe', date: new Date('2026-09-10T00:00:00Z') } })).map((r) => ({
    storeId: r.storeId, storeKey: r.storeId, date: '2026-09-10', employeeId: r.employeeId, staffId: r.staffId, staffNameSnapshot: r.staffNameSnapshot, actualHours: r.actualHours,
  }))
  const shadow = calculateEmployeeIdShadowPayroll(entries, staffRows)
  assert.equal(shadow.employees.length, 2, 'shadow 2 名员工')
  assert.equal(shadow.employees[0].employeeId !== shadow.employees[1].employeeId, true)
  // 同店同名：shadow 分离为 2 名（share=2 单人值）；legacy 合并为 1 名（两人加总）。
  // shadow 两人之和 == legacy 合并值（同一 calcDailyPay 公式、同一分摊基数 2）
  const { monthlyPayrollFromEntries } = await import(path.join(root, 'src/utils/payroll.js').replaceAll('\\', '/'))
  const legacy = monthlyPayrollFromEntries(entries, '2026-09')
  assert.equal(legacy.size, 1, 'legacy 合并为一名张伟')
  const shadowTotal = shadow.employees.reduce((sum, e) => sum + e.salary, 0)
  assert.equal(Math.round(shadowTotal * 100) / 100, Math.round(legacy.get('张伟').salary * 100) / 100, 'shadow 两人之和 == legacy 合并值（同一公式）')
  console.log('  [§22] shadow payroll 同店同名 2 员工 PASS（分离 2 人 = legacy 合并 1 人，总额一致）')

  console.log('GATE 16 DAILY STORE STAFF CONSTRAINT CUTOVER TEST OK')
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

async function save2(base, cookie, date, items) {
  return request(base, '/v2/daily-staff', { cookie, method: 'PUT', body: { storeKey: 'guanshe', date, items, reason: 'Gate 16' } })
}
