import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const schema = `gate29n_migration_${process.pid}_${Date.now().toString(36)}`
const url = new URL(adminUrl)
url.searchParams.set('schema', schema)
const schemaUrl = url.toString()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate29n-migrations-'))
const prismaBin = path.join(root, 'node_modules', '.bin', 'prisma')
const { PrismaClient } = await import('@prisma/client')
const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
const db = new PrismaClient({ datasources: { db: { url: schemaUrl } } })

const deploy = (schemaPath) => execFileSync(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: schemaUrl },
  stdio: 'pipe',
  timeout: 180000,
})

try {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  const oldPrisma = path.join(temp, 'prisma')
  fs.mkdirSync(path.join(oldPrisma, 'migrations'), { recursive: true })
  fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(oldPrisma, 'schema.prisma'))
  for (const name of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
    if (name === '20260824000012_payroll_participant_authority') continue
    const source = path.join(root, 'prisma', 'migrations', name)
    if (fs.statSync(source).isDirectory()) fs.cpSync(source, path.join(oldPrisma, 'migrations', name), { recursive: true })
  }
  deploy(path.join(oldPrisma, 'schema.prisma'))

  await db.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name", "district") VALUES ('tongying', '北京通盈中心店', '')`)
  await db.$executeRawUnsafe(`INSERT INTO "employees" ("id", "employee_no", "name") VALUES ('emp-before', 'BEFORE-1', '迁移前员工')`)
  await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "username", "passwordHash", "role", "avatar") VALUES ('user-before', 'before', 'x', 'staff', '')`)
  await db.$executeRawUnsafe(`
    INSERT INTO "daily_store_staff"
      ("id", "store_id", "date", "employee_id", "staff_id", "staff_name_snapshot", "actual_hours", "attendance_status")
    VALUES
      ('row-stable-before', 'tongying', DATE '2026-08-20', 'emp-before', 'legacy-stable', '迁移前员工', 8, 'normal'),
      ('row-null-before', 'tongying', DATE '2026-08-21', NULL, 'legacy-null', '历史未知', 6.5, 'late')
  `)
  const before = await db.$queryRawUnsafe(`SELECT id, employee_id, staff_id, staff_name_snapshot, actual_hours, attendance_status FROM "daily_store_staff" ORDER BY id`)

  deploy(path.join(root, 'prisma', 'schema.prisma'))

  const after = await db.$queryRawUnsafe(`SELECT id, employee_id, staff_id, staff_name_snapshot, actual_hours, attendance_status, participant_type, participant_user_id FROM "daily_store_staff" ORDER BY id`)
  assert.equal(after.length, before.length)
  assert.deepEqual(after.map((row) => ({
    id: row.id,
    employee_id: row.employee_id,
    staff_id: row.staff_id,
    staff_name_snapshot: row.staff_name_snapshot,
    actual_hours: row.actual_hours,
    attendance_status: row.attendance_status,
  })), before)
  assert.ok(after.every((row) => row.participant_type === 'LEGACY_UNKNOWN'))
  assert.ok(after.every((row) => row.participant_user_id === null))
  const users = await db.$queryRawUnsafe(`SELECT operational_identity_type FROM "User" WHERE id = 'user-before'`)
  assert.equal(users[0].operational_identity_type, 'STANDARD')
  console.log(`GATE 29N MIGRATION REHEARSAL OK (${schema})`)
} finally {
  await db.$disconnect().catch(() => {})
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await admin.$disconnect().catch(() => {})
  fs.rmSync(temp, { recursive: true, force: true })
}
