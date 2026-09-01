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
const RANGE_MIGRATION = '20260828000014_payroll_notice_period_range'

async function dropSchema(schema) {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`)
  } finally {
    await admin.$disconnect()
  }
}

function splitSqlStatements(sql) {
  const statements = []
  let current = ''
  let single = false
  let double = false
  let dollar = ''
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (!single && !double && char === '$') {
      const match = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/)
      if (match) {
        if (!dollar) dollar = match[0]
        else if (dollar === match[0]) dollar = ''
        current += match[0]
        index += match[0].length - 1
        continue
      }
    }
    if (!dollar && !double && char === "'" && sql[index - 1] !== '\\') single = !single
    if (!dollar && !single && char === '"') double = !double
    if (char === ';' && !single && !double && !dollar) {
      if (current.trim()) statements.push(current.trim())
      current = ''
    } else current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
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
      if (!entry.isDirectory() || entry.name === GATE18_MIGRATION || entry.name === RANGE_MIGRATION) continue
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
      for (const statement of splitSqlStatements(sql)) {
        await db.$executeRawUnsafe(statement)
      }
      const rangeSql = fs.readFileSync(path.join(root, 'prisma', 'migrations', RANGE_MIGRATION, 'migration.sql'), 'utf8')
      for (const statement of splitSqlStatements(rangeSql)) await db.$executeRawUnsafe(statement)
      const row = await db.$queryRawUnsafe(`SELECT "employee_id", "employee_name", "store_key", "target_username", "total_cents", "snapshot", "period_key", "period_start", "period_end" FROM "payroll_notices" WHERE "id"='pn-legacy'`)
      assert.equal(row.length, 1, 'H legacy 行存活')
      assert.equal(row[0].employee_id, null, 'H employeeId=NULL')
      assert.equal(row[0].employee_name, '张伟')
      assert.equal(row[0].target_username, 'user-old')
      assert.equal(Number(row[0].total_cents), 10000)
      assert.equal(row[0].period_key, '2026-08')
      assert.equal(row[0].period_start.toISOString().slice(0, 10), '2026-08-01')
      assert.equal(row[0].period_end.toISOString().slice(0, 10), '2026-08-31')
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
    { id: 'emp-X', employeeNo: 'BUDU-18-X', name: '王五', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  ],
})
const testDate = (value) => new Date(`${value}T00:00:00.000Z`)
const payrollDays = [
  ['2026-09-01', ['emp-A']],
  ['2026-10-01', ['emp-A', 'emp-B']],
  ['2026-11-01', ['emp-A']],
  ['2026-12-01', ['emp-X']],
  ['2027-01-01', ['emp-A']],
  ['2027-02-01', ['emp-A']],
  ['2027-02-02', ['emp-A', 'emp-B']],
  ['2027-02-06', ['emp-A']],
  ['2027-03-02', ['emp-A']],
  ['2027-03-04', ['emp-A']],
  ['2027-04-01', ['emp-A']],
]
for (const [date, employeeIds] of payrollDays) {
  await prisma.dailyEntry.create({
    data: { id: `de-${date}`, storeKey: 'guanshe', date: testDate(date), incCents: 500000n, ord: 10, staffNames: employeeIds.map(() => '张伟'), status: 'confirmed' },
  })
  for (const [index, employeeId] of employeeIds.entries()) {
    await prisma.dailyStoreStaff.create({
      data: {
        id: `dss-${date}-${employeeId}`, storeId: 'guanshe', date: testDate(date), employeeId,
        participantType: 'EMPLOYEE', staffId: `staff-${employeeId}`, staffNameSnapshot: employeeId === 'emp-X' ? '王五' : '张伟',
        actualHours: index === 0 ? 8 : 6, historicalPayrollHours: null, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal',
      },
    })
  }
}

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

  const { buildAuthoritativeIssueRows, loadAuthoritativePayrollRange } = await import('../server/payroll-authority.js')
  const payloadForPeriod = async (period, employeeIds) => {
    const authority = await loadAuthoritativePayrollRange(prisma, period)
    return buildAuthoritativeIssueRows(authority, employeeIds).map((row) => ({
      employeeId: row.employeeId, employeeName: row.employeeName, storeKey: row.storeKey,
      snapshot: row.snapshot, totalCents: row.totalCents,
      snapshotVersion: row.snapshotVersion, snapshotDigest: row.snapshotDigest,
    }))
  }
  const payloadFor = (periodKey, employeeIds) => payloadForPeriod({ periodType: 'month', periodKey }, employeeIds)
  const issuePeriod = async (period, employeeIds, mutate = (rows) => rows) => request(base, '/v2/payroll-notices', {
    cookie,
    method: 'POST',
    body: { ...period, rows: mutate(await payloadForPeriod(period, employeeIds)) },
  })
  const issue = async (periodKey, employeeIds, mutate = (rows) => rows) => request(base, '/v2/payroll-notices', {
    cookie,
    method: 'POST',
    body: { periodType: 'month', periodKey, rows: mutate(await payloadFor(periodKey, employeeIds)) },
  })

  // A: 稳定发放
  const rA = await issue('2026-09', ['emp-A'])
  assert.equal(rA.status, 200, `A 应成功: ${await rA.text()}`)
  const noticeA = await prisma.payrollNotice.findFirst({ where: { employeeId: 'emp-A' } })
  assert.ok(noticeA)
  assert.equal(noticeA.targetUsername, 'user-A', 'A 收件人 = User.employeeId 绑定')
  console.log('  [A] 稳定发放 PASS')

  // B: 同店同名独立发放（用不同周期避免与 A 冲突）
  const rB2 = await issue('2026-10', ['emp-A', 'emp-B'])
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
  const rC = await issue('2026-11', ['emp-A'], (rows) => rows.map((row) => ({ ...row, targetUsername: 'user-B' })))
  assert.equal(rC.status, 200, `C 应成功（服务端解析正确收件人）: ${await rC.text()}`)
  const noticeC = await prisma.payrollNotice.findFirst({ where: { employeeId: 'emp-A', periodKey: '2026-11' } })
  assert.equal(noticeC.targetUsername, 'user-A', 'C 绝不落 user-B')
  console.log('  [C] 错收件人拒绝 PASS')

  // D: 未绑定阻断
  const rD = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-12', rows: [{ employeeId: 'emp-X' }] } })
  assert.equal(rD.status, 409, `D 未绑定应 409: ${await rD.text()}`)
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-X' } }), 0, 'D 零 notice')
  console.log('  [D] 未绑定阻断 PASS')

  // E: 重复绑定阻断
  // E 场景：模拟历史重复绑定状态——先以空闲员工创建 user-A2，再在 DB 层写入 emp-A（模拟旧数据/历史状态）
  const validJanuaryPayload = await payloadFor('2027-01', ['emp-A'])
  const rA2 = await fetch(`${base}/admin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ username: 'user-A2', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-X' }) })
  assert.equal(rA2.status, 200, 'E 创建 user-A2')
  await prisma.user.updateMany({ where: { username: 'user-A2' }, data: { employeeId: 'emp-A' } })
  // Gate 20 新路径：user-A2 重复绑 emp-A 的创建会被 409 拦截（已在上方验证）
  const rE = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2027-01', rows: validJanuaryPayload } })
  assert.equal(rE.status, 409, `E 重复绑定应 409: ${await rE.text()}`)
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-A', periodKey: '2027-01' } }), 0, 'E 零 notice')
  // 清理重复绑定，恢复 emp-A 单绑定（后续 G 场景需要）
  await prisma.user.updateMany({ where: { username: 'user-A2' }, data: { employeeId: '' } })
  console.log('  [E] 重复绑定阻断 PASS')

  // F: 无效 employeeId
  const rF = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-09', rows: [{ employeeId: 'emp-not-exist' }] } })
  assert.equal(rF.status, 409, `F 无效 id 应受控拒绝: ${await rF.text()}`)
  console.log('  [F] 无效 employeeId 受控拒绝 PASS')

  // G: 重复周期
  const februaryPayload = await payloadFor('2027-02', ['emp-A'])
  const rG1 = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2027-02', rows: februaryPayload } })
  assert.equal(rG1.status, 200)
  const rG2 = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2027-02', rows: februaryPayload } })
  assert.equal(rG2.status, 409, `G 重复周期应 409: ${await rG2.text()}`)
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-A', periodKey: '2027-02' } }), 1, 'G 一条 notice')
  console.log('  [G] 重复周期幂等 PASS')

  // H: 月度与周度重叠只按同一 Employee.id 阻断；其他员工不受影响。
  const febWeek = { periodType: 'week', periodKey: '2027-02-01' }
  const preflightH = await request(base, '/v2/payroll-notices/preflight', {
    cookie, method: 'POST', body: { ...febWeek, employeeIds: ['emp-A', 'emp-B'] },
  })
  assert.equal(preflightH.status, 200)
  const preflightRows = (await preflightH.json()).rows
  assert.equal(preflightRows.find((row) => row.employeeId === 'emp-A').issueReady, false, 'emp-A 月/周重叠预检阻断')
  assert.equal(preflightRows.find((row) => row.employeeId === 'emp-B').issueReady, true, 'emp-B 不被 emp-A 周期占用')
  assert.equal(preflightRows.find((row) => row.employeeId === 'emp-B').snapshotVersion, 'PAYROLL_ISSUANCE_V1', 'H canonical snapshot version')
  assert.equal(preflightRows.find((row) => row.employeeId === 'emp-B').snapshotDigest.length, 64, 'H canonical snapshot digest')
  const rH1 = await issuePeriod(febWeek, ['emp-A'])
  assert.equal(rH1.status, 409, `H 月/周重叠应 409: ${await rH1.text()}`)
  const rH2 = await issuePeriod(febWeek, ['emp-B'])
  assert.equal(rH2.status, 200, `H 不同 Employee.id 应可发放: ${await rH2.text()}`)
  console.log('  [H] MONTH/WEEK overlap + Employee.id isolation PASS')

  // I: recalled/deleted 不占用；活跃周度与部分 CUSTOM 重叠仍阻断。
  const febMonth = await prisma.payrollNotice.findFirst({ where: { employeeId: 'emp-A', periodKey: '2027-02' } })
  await prisma.payrollNotice.update({ where: { id: febMonth.id }, data: { status: 'recalled', recalledAt: new Date(), recalledBy: 'test' } })
  const rI1 = await issuePeriod(febWeek, ['emp-A'])
  assert.equal(rI1.status, 200, `I recalled 不应占用区间: ${await rI1.text()}`)
  const partialCustom = { periodType: 'custom', periodStart: '2027-02-06', periodEnd: '2027-02-10' }
  const rI2 = await issuePeriod(partialCustom, ['emp-A'])
  assert.equal(rI2.status, 409, `I 部分 CUSTOM 重叠应 409: ${await rI2.text()}`)
  console.log('  [I] recalled reuse + partial CUSTOM overlap PASS')

  // J: 同 Employee.id 并发重叠请求由 advisory lock 串行化，只能提交一个。
  const marchWeek = { periodType: 'week', periodKey: '2027-03-01' }
  const marchCustom = { periodType: 'custom', periodStart: '2027-03-04', periodEnd: '2027-03-10' }
  const [marchWeekRows, marchCustomRows] = await Promise.all([
    payloadForPeriod(marchWeek, ['emp-A']),
    payloadForPeriod(marchCustom, ['emp-A']),
  ])
  const concurrent = await Promise.all([
    request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { ...marchWeek, rows: marchWeekRows } }),
    request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { ...marchCustom, rows: marchCustomRows } }),
  ])
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409], '并发重叠必须一成一拒')
  assert.equal(await prisma.payrollNotice.count({
    where: { employeeId: 'emp-A', periodStart: { lte: testDate('2027-03-10') }, periodEnd: { gte: testDate('2027-03-01') }, status: { notIn: ['recalled', 'deleted'] } },
  }), 1, '并发后只能有一个活跃区间')
  console.log('  [J] concurrent overlap serialization PASS')

  // K: 客户端金额/快照不是权威，任何篡改均 fail closed。
  const rK = await issue('2027-04', ['emp-A'], (rows) => rows.map((row) => ({ ...row, totalCents: row.totalCents + 1 })))
  assert.equal(rK.status, 409, 'K 金额篡改应 409')
  const errorK = await rK.json()
  assert.equal(errorK.code, 'PAYROLL_AUTHORITY_MISMATCH')
  assert.equal(errorK.mismatchField, 'totalCents')
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-A', periodKey: '2027-04' } }), 0)
  const rK2 = await issue('2027-04', ['emp-A'], (rows) => rows.map((row) => ({
    ...row,
    snapshot: { ...row.snapshot, summary: { ...row.snapshot.summary, commission: row.snapshot.summary.commission + 1 } },
  })))
  assert.equal(rK2.status, 409, 'K2 component mismatch 应 409')
  const errorK2 = await rK2.json()
  assert.equal(errorK2.code, 'PAYROLL_AUTHORITY_MISMATCH')
  assert.equal(errorK2.mismatchField, 'snapshot.summary.commission')
  const rK3 = await issue('2027-04', ['emp-A'], (rows) => rows.map((row) => ({ ...row, snapshotDigest: '0'.repeat(64) })))
  assert.equal(rK3.status, 409, 'K3 stale digest 应 409')
  const errorK3 = await rK3.json()
  assert.equal(errorK3.code, 'PAYROLL_AUTHORITY_MISMATCH')
  assert.equal(errorK3.mismatchField, 'snapshotDigest')
  assert.equal(await prisma.payrollNotice.count({ where: { employeeId: 'emp-A', periodKey: '2027-04' } }), 0)
  console.log('  [K] amount/component/stale snapshot guard PASS')

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
