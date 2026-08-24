import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const GATE6_MIGRATION = '20260824000007_daily_store_staff_employee_identity'

async function dropSchema(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

async function migrationPreservesLegacyRows() {
  const { PrismaClient } = await import('@prisma/client')
  const schema = `gate6_migration_${process.pid}_${Date.now().toString(36)}`
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', schema)
  const databaseUrl = url.toString()
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate6-migration-'))
  const tempPrisma = path.join(tempDir, 'prisma')
  fs.mkdirSync(path.join(tempPrisma, 'migrations'), { recursive: true })

  try {
    await admin.$queryRawUnsafe('SELECT 1')
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tempPrisma, 'migrations', 'migration_lock.toml'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === GATE6_MIGRATION) continue
      fs.cpSync(
        path.join(root, 'prisma', 'migrations', entry.name),
        path.join(tempPrisma, 'migrations', entry.name),
        { recursive: true },
      )
    }
    execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', path.join(tempPrisma, 'schema.prisma')], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
      timeout: 180_000,
    })

    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    try {
      await db.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name") VALUES ('chaowai', '北京朝外店')`)
      await db.$executeRawUnsafe(`INSERT INTO "employees" ("id", "employee_no", "name", "current_store_key") VALUES ('emp-migration', 'BUDU-G6-M', '迁移员工', 'chaowai')`)
      await db.$executeRawUnsafe(`INSERT INTO "daily_store_staff" ("id", "store_id", "date", "staff_id", "staff_name_snapshot") VALUES ('legacy-before-g6', 'chaowai', DATE '2026-08-20', 'st-chaowai-legacy', '历史姓名')`)
      assert.equal(Number((await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "daily_store_staff" WHERE "id"='legacy-before-g6'`))[0].count), 1)

      const sql = fs.readFileSync(path.join(root, 'prisma', 'migrations', GATE6_MIGRATION, 'migration.sql'), 'utf8')
      const statements = sql
        .split(';')
        .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
        .filter(Boolean)
      for (const statement of statements) await db.$executeRawUnsafe(statement)

      const legacy = await db.$queryRawUnsafe(`SELECT "staff_id", "staff_name_snapshot", "employee_id" FROM "daily_store_staff" WHERE "id"='legacy-before-g6'`)
      assert.equal(legacy.length, 1, '迁移必须保留既有 legacy 行')
      assert.equal(legacy[0].staff_id, 'st-chaowai-legacy')
      assert.equal(legacy[0].staff_name_snapshot, '历史姓名')
      assert.equal(legacy[0].employee_id, null, '既有行必须保持未解析 NULL')

      await db.$executeRawUnsafe(`UPDATE "daily_store_staff" SET "employee_id"='emp-migration' WHERE "id"='legacy-before-g6'`)
      const linked = await db.$queryRawUnsafe(`SELECT "employee_id" FROM "daily_store_staff" WHERE "id"='legacy-before-g6'`)
      assert.equal(linked[0].employee_id, 'emp-migration', '新稳定引用必须可写')
    } finally {
      await db.$disconnect()
    }
  } finally {
    await admin.$disconnect()
    fs.rmSync(tempDir, { recursive: true, force: true })
    await dropSchema(schema)
  }
}

await migrationPreservesLegacyRows()

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate6-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-6-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate6_attendance')
const disposableSchema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.create({ data: { key: 'chaowai', name: '北京朝外店' } })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-G6-A', name: '张伟', currentStoreKey: 'chaowai', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-G6-B', name: '张伟', currentStoreKey: 'chaowai', status: 'ACTIVE' },
  ],
})
await prisma.dailyStoreStaff.create({
  data: {
    id: 'legacy-upgrade-row', storeId: 'chaowai', date: new Date('2026-08-25T00:00:00Z'),
    employeeId: null, staffId: 'st-chaowai-legacy', staffNameSnapshot: '历史张伟', actualHours: 4,
  },
})

const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)

const request = async (base, pathname, { cookie = '', method = 'GET', body } = {}) =>
  fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const attendanceItem = (overrides = {}) => ({
  employeeId: 'emp-A',
  staffId: 'st-chaowai-a',
  staffName: '张伟',
  breakMinutes: 0,
  actualHours: 8,
  attendanceStatus: 'normal',
  ...overrides,
})

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await request(base, '/auth/register', { method: 'POST', body: { username: 'gate6-developer', password: '123456' } })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  const save = (date, items) => request(base, '/v2/daily-staff', {
    cookie,
    method: 'PUT',
    body: { storeKey: 'chaowai', date, items, reason: 'Gate 6 regression' },
  })

  // A: new stable write preserves stable ID, legacy ID and historical snapshot.
  assert.equal((await save('2026-08-24', [attendanceItem()])).status, 200)
  let stableRows = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'chaowai', date: new Date('2026-08-24T00:00:00Z') } })
  assert.equal(stableRows.length, 1)
  assert.equal(stableRows[0].employeeId, 'emp-A')
  assert.equal(stableRows[0].staffId, 'st-chaowai-a')
  assert.equal(stableRows[0].staffNameSnapshot, '张伟')

  // B: employee profile reads the canonical employeeId relation.
  const summaryResponse = await request(base, '/v2/employees/emp-A/summary', { cookie })
  assert.equal(summaryResponse.status, 200)
  const summary = await summaryResponse.json()
  assert.equal(summary.attendance.days, 1)
  assert.equal(summary.attendance.totalHours, 8)

  // C: legacy rows and legacy clients remain valid without a stable ID.
  assert.equal((await save('2026-08-25', [attendanceItem({ employeeId: undefined, staffId: 'st-chaowai-legacy', staffName: '客户端姓名', actualHours: 5 })])).status, 200)
  let legacy = await prisma.dailyStoreStaff.findUnique({ where: { id: 'legacy-upgrade-row' } })
  assert.equal(legacy.employeeId, null)
  assert.equal(legacy.staffNameSnapshot, '历史张伟', 'legacy 重存不得覆盖历史姓名快照')

  // D: exact legacy staffId can be upgraded in place by an explicit Employee.id.
  assert.equal((await save('2026-08-25', [attendanceItem({ staffId: 'st-chaowai-legacy', actualHours: 6 })])).status, 200)
  legacy = await prisma.dailyStoreStaff.findUnique({ where: { id: 'legacy-upgrade-row' } })
  assert.equal(legacy.employeeId, 'emp-A')
  assert.equal(legacy.actualHours, 6)
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'chaowai', date: new Date('2026-08-25T00:00:00Z') } }), 1)

  // E: repeated stable writes keep one logical row.
  // E 场景 = 两次顺序 HTTP PUT（A 首次保存 2026-08-24，此处第二次 PUT 同店同日同员工）。
  // 先做严格 identical replay：完全相同 payload 再发一次 → 必须 SUCCESS、仍 1 行、identity 不变。
  const replayResponse = await save('2026-08-24', [attendanceItem()])
  assert.equal(replayResponse.status, 200, 'identical replay 必须成功（upsert，不 409）')
  stableRows = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'chaowai', date: new Date('2026-08-24T00:00:00Z') } })
  assert.equal(stableRows.length, 1, 'identical replay 后仍必须恰好 1 行')
  assert.equal(stableRows[0].employeeId, 'emp-A', 'replay 不得改变 employeeId')
  assert.equal(stableRows[0].staffId, 'st-chaowai-a', 'replay 不得改变 staffId')
  // 然后同逻辑状态（仅工时变化）的再次保存也须成功，仍 1 行。
  assert.equal((await save('2026-08-24', [attendanceItem({ actualHours: 7 })])).status, 200)
  stableRows = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'chaowai', date: new Date('2026-08-24T00:00:00Z') } })
  assert.equal(stableRows.length, 1)
  assert.equal(stableRows[0].actualHours, 7)

  // F: invalid stable IDs are rejected; no name-based fallback is attempted.
  assert.equal((await save('2026-08-26', [attendanceItem({ employeeId: 'emp-does-not-exist' })])).status, 400)
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'chaowai', date: new Date('2026-08-26T00:00:00Z') } }), 0)

  // G: an exact legacy row already linked to another Employee cannot be reassigned.
  await prisma.dailyStoreStaff.create({
    data: {
      id: 'identity-conflict-row', storeId: 'chaowai', date: new Date('2026-08-27T00:00:00Z'),
      employeeId: 'emp-A', staffId: 'st-chaowai-conflict', staffNameSnapshot: '张伟', actualHours: 8,
    },
  })
  assert.equal((await save('2026-08-27', [attendanceItem({ employeeId: 'emp-B', staffId: 'st-chaowai-conflict' })])).status, 409)
  const conflict = await prisma.dailyStoreStaff.findUnique({ where: { id: 'identity-conflict-row' } })
  assert.equal(conflict.employeeId, 'emp-A')

  // Known legacy constraint: same-store/date same-name rows still share the synthetic staffId.
  assert.equal((await save('2026-08-28', [
    attendanceItem({ employeeId: 'emp-A', staffId: 'st-chaowai-same-name' }),
    attendanceItem({ employeeId: 'emp-B', staffId: 'st-chaowai-same-name' }),
  ])).status, 409)

  console.log('GATE 6 DAILY STORE STAFF EMPLOYEE ID TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
  if (disposableSchema) await dropSchema(disposableSchema)
}
