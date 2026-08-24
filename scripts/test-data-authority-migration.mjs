import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'

test('DA migration：已有随机 id 的同门店同日期记录可被 legacy 数据幂等更新', async () => {
  const databaseUrl = await createDisposablePgSchema('da_legacy_entry')
  const schema = new URL(databaseUrl).searchParams.get('schema')
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-da-migration-'))
  const dbFile = path.join(tempDir, 'db.json')

  try {
    await prisma.store.upsert({
      where: { key: 'guanshe' },
      update: {},
      create: { key: 'guanshe', name: '北京官舍店' },
    })
    await prisma.dailyEntry.create({
      data: {
        id: 'api-generated-random-id',
        storeKey: 'guanshe',
        date: new Date('2026-08-10T00:00:00.000Z'),
        incCents: 100n,
        ord: 1,
        staffNames: [],
      },
    })
    await prisma.staff.create({
      data: {
        id: 'api-generated-staff-id',
        name: '测试员工甲',
        type: 'fulltime',
        storeKey: 'guanshe',
        salary: 100,
      },
    })
    fs.writeFileSync(dbFile, JSON.stringify({
      stores: [],
      users: [],
      staff: [
        { name: '测试员工甲', type: 'fulltime', storeKey: 'guanshe', salary: 200 },
        { name: '测试员工乙', type: 'parttime', storeKey: 'guanshe', salary: 80 },
      ],
      entries: {
        '2026-08|guanshe|08-10': { inc: 3000, ord: 20, staff: ['测试员工'] },
      },
      inventoryRequests: [],
      inventory: [],
      products: [
        { name: '中文商品甲' },
        { name: '中文商品乙' },
      ],
    }), { mode: 0o600 })

    const result = spawnSync(process.execPath, [
      'scripts/migrate-kv-to-pg.mjs',
      '--db', dbFile,
      '--reconcile',
    ], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const rows = await prisma.dailyEntry.findMany({ where: { storeKey: 'guanshe' } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'api-generated-random-id', '已有业务记录的稳定 id 不应被替换')
    assert.equal(rows[0].incCents, 300000n)
    assert.equal(rows[0].ord, 20)
    assert.deepEqual(rows[0].staffNames, ['测试员工'])

    const staffRows = await prisma.staff.findMany({ where: { storeKey: 'guanshe' } })
    assert.equal(staffRows.length, 2, '不同中文姓名不得因迁移 ID 清洗发生碰撞')
    const existingStaff = staffRows.find((row) => row.name === '测试员工甲')
    assert.equal(existingStaff?.id, 'api-generated-staff-id', '已有员工主键应保持不变')
    assert.equal(existingStaff?.salary, 200)
    assert.equal(new Set(staffRows.map((row) => row.id)).size, 2)

    const itemRows = await prisma.inventoryItem.findMany({
      where: { name: { in: ['中文商品甲', '中文商品乙'] } },
    })
    assert.equal(itemRows.length, 2, '不同中文商品不得因迁移 ID 清洗发生碰撞')
    assert.equal(new Set(itemRows.map((row) => row.id)).size, 2)

    const employeeBackfill = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'employee-backfill.mjs'),
    ], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    })
    assert.equal(employeeBackfill.status, 0, employeeBackfill.stderr || employeeBackfill.stdout)
    assert.match(employeeBackfill.stdout, /\"CREATE\":2/)

    const employees = await prisma.employee.findMany({ orderBy: { employeeNo: 'asc' } })
    assert.equal(employees.length, 2)
    assert.deepEqual(new Set(employees.map((row) => `${row.currentStoreKey}::${row.name}`)), new Set([
      'guanshe::测试员工甲',
      'guanshe::测试员工乙',
    ]))
    assert.equal(await prisma.employeeAuditLog.count({ where: { action: 'backfill.create' } }), 2)

    const rerun = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'employee-backfill.mjs'),
    ], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
    })
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout)
    assert.match(rerun.stdout, /\"CREATE\":0/)
    assert.match(rerun.stdout, /\"SKIP\":2/)
    assert.equal(await prisma.employee.count(), 2, '员工主档回填必须可重复执行')
  } finally {
    await prisma.$disconnect()
    fs.rmSync(tempDir, { recursive: true, force: true })
    if (schema) {
      const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
      try {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
      } finally {
        await admin.$disconnect()
      }
    }
  }
})
