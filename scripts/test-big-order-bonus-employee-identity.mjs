// Gate 10：BigOrderBonus 稳定 Employee.id
// A 稳定写 / B 无效 employeeId 400 / C migration 安全 / D 跨店同名分离 / E 无双计
// F 调店后稳定读取 / G legacy 兼容 / H 无启发式回填
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const GATE10_MIGRATION = '20260824000009_big_order_bonus_employee_identity'

async function dropSchema(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

// ---------- C: migration 安全 ----------
async function migrationSafety() {
  const { PrismaClient } = await import('@prisma/client')
  const schema = `gate10_migration_${process.pid}_${Date.now().toString(36)}`
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', schema)
  const databaseUrl = url.toString()
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate10-migration-'))
  const tempPrisma = path.join(tempDir, 'prisma')
  fs.mkdirSync(path.join(tempPrisma, 'migrations'), { recursive: true })

  try {
    await admin.$queryRawUnsafe('SELECT 1')
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(tempPrisma, 'migrations', 'migration_lock.toml'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === GATE10_MIGRATION) continue
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
      await db.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name") VALUES ('guanshe', '北京官舍店')`)
      await db.$executeRawUnsafe(`INSERT INTO "BigOrderBonus" ("id", "staffKey", "staffName", "storeKey", "date", "amountCents", "bonusCents", "receipt", "createdBy") VALUES ('legacy-bb-g10', 'guanshe::张伟', '张伟', 'guanshe', DATE '2026-08-20', 200000, 10000, '', 't')`)
      const sql = fs.readFileSync(path.join(root, 'prisma', 'migrations', GATE10_MIGRATION, 'migration.sql'), 'utf8')
      for (const statement of sql.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
        await db.$executeRawUnsafe(statement)
      }
      const row = await db.$queryRawUnsafe(`SELECT "employee_id", "staffName", "storeKey", "amountCents", "bonusCents", "date" FROM "BigOrderBonus" WHERE "id"='legacy-bb-g10'`)
      assert.equal(row.length, 1, '迁移必须保留 legacy 行')
      assert.equal(row[0].employee_id, null, 'legacy 行保持 employee_id=NULL')
      assert.equal(Number(row[0].amountCents), 200000, '订单金额不变')
      assert.equal(Number(row[0].bonusCents), 10000, '奖金金额不变')
      assert.equal(String(row[0].staffName), '张伟', '姓名快照不变')
      console.log('  [C] migration 安全 PASS')
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate10-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-10-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate10_bonus')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }, { key: 'chaowai', name: '北京朝外店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-G10-A', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-G10-B', name: '张伟', currentStoreKey: 'chaowai', status: 'ACTIVE' },
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
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate10-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  const post = (body) => request(base, '/v2/big-bonuses', { cookie, method: 'POST', body })

  // A: 稳定写——employeeId 存储 + 快照保留
  const rA = await post({ employeeId: 'emp-A', staffName: '张伟', storeKey: 'guanshe', amountCents: 200000, date: '2026-09-01', receipt: '' })
  assert.equal(rA.status, 200, `A 应成功: ${await rA.text()}`)
  const bonusA = await prisma.bigOrderBonus.findFirst({ where: { employeeId: 'emp-A' } })
  assert.ok(bonusA)
  assert.equal(bonusA.employeeId, 'emp-A')
  assert.equal(bonusA.staffKey, 'guanshe::张伟', 'staffKey 快照保留')
  assert.equal(bonusA.staffName, '张伟', 'staffName 快照保留')
  assert.equal(bonusA.storeKey, 'guanshe', 'storeKey 快照保留')
  assert.equal(Number(bonusA.bonusCents), 10000, '奖金 5%')
  console.log('  [A] 稳定写 PASS')

  // B: 无效 employeeId → 400
  const rB = await post({ employeeId: 'emp-not-exist', staffName: '张伟', storeKey: 'guanshe', amountCents: 100000, date: '2026-09-02', receipt: '' })
  assert.equal(rB.status, 400, `B 应 400: ${await rB.text()}`)
  assert.equal(await prisma.bigOrderBonus.count({ where: { date: new Date('2026-09-02T00:00:00Z') } }), 0, 'B 不得落库')
  console.log('  [B] 无效 employeeId 400 PASS')

  // D: 跨店同名分离——emp-A +100、emp-B +200，稳定读取各自独立
  const rD2 = await post({ employeeId: 'emp-B', staffName: '张伟', storeKey: 'chaowai', amountCents: 400000, date: '2026-09-03', receipt: '' })
  assert.equal(rD2.status, 200, `emp-B 应成功: ${await rD2.text()}`)
  const rows = await prisma.bigOrderBonus.findMany({ where: { date: { in: [new Date('2026-09-01T00:00:00Z'), new Date('2026-09-03T00:00:00Z')] } } })
  assert.equal(rows.filter((r) => r.employeeId === 'emp-A').length, 1)
  assert.equal(rows.filter((r) => r.employeeId === 'emp-B').length, 1)
  const bonusB = await prisma.bigOrderBonus.findFirst({ where: { employeeId: 'emp-B' } })
  assert.equal(Number(bonusB.bonusCents), 20000)
  // 前端稳定读取模拟：bigBonusesByName(name, employeeId)
  const { seedCachedDataForTest } = await import('../src/utils/userData.js')
  const { bigBonusYuanMonth } = await import('../src/utils/selectors.js')
  seedCachedDataForTest({
    entries: {}, staff: [], removedStaff: [], stores: [], schedules: {}, products: [],
    inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, bigBonuses: [
      { id: bonusA.id, employeeId: 'emp-A', staffKey: 'guanshe::张伟', staffName: '张伟', storeKey: 'guanshe', date: '2026-09-01', amountCents: 200000, bonusCents: 10000 },
      { id: bonusB.id, employeeId: 'emp-B', staffKey: 'chaowai::张伟', staffName: '张伟', storeKey: 'chaowai', date: '2026-09-03', amountCents: 400000, bonusCents: 20000 },
    ], dailyPayAdjustments: [], posDaily: [], posProductSales: [],
  })
  assert.equal(bigBonusYuanMonth('张伟', '2026-09', 'emp-A'), 100, 'emp-A 只读自己的 100 元')
  assert.equal(bigBonusYuanMonth('张伟', '2026-09', 'emp-B'), 200, 'emp-B 只读自己的 200 元')
  console.log('  [D] 跨店同名分离 PASS')

  // E: 无双计——stable 行（employeeId=emp-A）同时匹配 staffKey endsWith，合计仍只一次
  assert.equal(bigBonusYuanMonth('张伟', '2026-09', 'emp-A'), 100, 'stable 行不重复计数')
  assert.equal(bigBonusYuanMonth('张伟', '2026-09'), 300, '无 id 调用 = legacy 聚合（两行）')
  console.log('  [E] 无双计 PASS')

  // F: 调店后稳定读取——emp-A 当前门店改为 chaowai，历史 bonus（官舍）仍归属 emp-A
  await prisma.employee.update({ where: { id: 'emp-A' }, data: { currentStoreKey: 'chaowai' } })
  assert.equal(bigBonusYuanMonth('张伟', '2026-09', 'emp-A'), 100, '调店后仍按 employeeId 读到历史 bonus')
  console.log('  [F] 调店稳定读取 PASS')

  // G/H: legacy 行兼容 + 无启发式回填
  await prisma.bigOrderBonus.create({
    data: { id: 'legacy-g10', staffKey: 'guanshe::张伟', staffName: '张伟', storeKey: 'guanshe', date: new Date('2026-09-04T00:00:00Z'), amountCents: 100000n, bonusCents: 5000n, createdBy: 't' },
  })
  const legacyRow = await prisma.bigOrderBonus.findUnique({ where: { id: 'legacy-g10' } })
  assert.equal(legacyRow.employeeId, null, 'legacy 行保持 NULL（即使存在同名当前员工）')
  // legacy 无 id 读取：aggregate 包含 stable + legacy 行（与旧行为一致）
  seedCachedDataForTest({
    entries: {}, staff: [], removedStaff: [], stores: [], schedules: {}, products: [],
    inventoryRequests: [], inventory: [], analysis: {}, productImages: {}, bigBonuses: [
      { id: bonusA.id, employeeId: 'emp-A', staffKey: 'guanshe::张伟', staffName: '张伟', storeKey: 'guanshe', date: '2026-09-01', amountCents: 200000, bonusCents: 10000 },
      { id: bonusB.id, employeeId: 'emp-B', staffKey: 'chaowai::张伟', staffName: '张伟', storeKey: 'chaowai', date: '2026-09-03', amountCents: 400000, bonusCents: 20000 },
      { id: 'legacy-g10', employeeId: '', staffKey: 'guanshe::张伟', staffName: '张伟', storeKey: 'guanshe', date: '2026-09-04', amountCents: 100000, bonusCents: 5000 },
    ], dailyPayAdjustments: [], posDaily: [], posProductSales: [],
  })
  assert.equal(bigBonusYuanMonth('张伟', '2026-09'), 350, 'legacy 行按旧行为可读（100+200+50）')
  assert.equal(bigBonusYuanMonth('张伟', '2026-09', 'emp-A'), 150, 'emp-A = stable 100 + legacy 姓名归并 50（§9 legacy 兼容）')
  assert.equal(bigBonusYuanMonth('张伟', '2026-09', 'emp-B'), 250, 'emp-B = stable 200 + legacy 姓名归并 50（legacy 行同名歧义为已知旧行为，§9 保留；未来 reconciliation 解析）')
  console.log('  [G/H] legacy 兼容 + 无启发式回填 PASS')

  console.log('GATE 10 BIG ORDER BONUS EMPLOYEE ID TEST OK')
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
