// Gate 29L：员工本人可见范围只认 User.employeeId。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate29l-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-29l-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate29l_self_scope')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const { normalizeAccountPermissions, MODULE_KEYS } = await import('../shared/accountPermissions.js')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }, { key: 'chaowai', name: '北京朝外店' }] })
await prisma.employee.createMany({ data: [
  { id: 'emp-A', employeeNo: 'A001', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  { id: 'emp-B', employeeNo: 'B001', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  { id: 'emp-C', employeeNo: 'C001', name: '李四', currentStoreKey: 'chaowai', status: 'ACTIVE' },
] })

const beforeRows = await prisma.employee.findMany({ where: { currentStoreKey: 'guanshe', name: '张伟' } })
assert.deepEqual(beforeRows.map((row) => row.id).sort(), ['emp-A', 'emp-B'])
console.log('  [BEFORE MODEL] staffKey=guanshe::张伟 → emp-A + emp-B（阻断复现）')

const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)
const request = (base, pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${base}${pathname}`, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await request(base, '/auth/register', { method: 'POST', body: { username: 'gate29l-dev', password: '123456' } })
  assert.equal(register.status, 200)
  const devCookie = register.headers.get('set-cookie')?.split(';')[0] || ''

  const createUser = async (username, employeeId, storeKeys = ['guanshe']) => {
    const response = await request(base, '/admin/users', {
      cookie: devCookie,
      method: 'POST',
      body: { username, password: '123456', role: 'staff', storeKeys, staffKey: `${storeKeys[0]}::张伟`, employeeId },
    })
    assert.equal(response.status, 200, `${username}: ${await response.text()}`)
  }
  await createUser('staff-A', 'emp-A')
  await createUser('staff-B', 'emp-B')

  const loginA = await request(base, '/auth/login', { method: 'POST', body: { username: 'staff-A', password: '123456' } })
  assert.equal(loginA.status, 200)
  const cookieA = loginA.headers.get('set-cookie')?.split(';')[0] || ''

  const staffList = async () => {
    const response = await request(base, '/v2/staff-list', { cookie: cookieA })
    if (response.status !== 200) assert.fail(`staff-list ${response.status}: ${await response.text()}`)
    return (await response.json()).rows
  }

  let rows = await staffList()
  assert.deepEqual(rows.map((row) => row.id), ['emp-A'])
  console.log('  [AFTER] 同店同名 staff-A → emp-A only PASS')

  await prisma.employee.update({ where: { id: 'emp-B' }, data: { currentStoreKey: 'chaowai' } })
  rows = await staffList()
  assert.deepEqual(rows.map((row) => row.id), ['emp-A'])
  console.log('  [不同店同名] Employee.id 精确 PASS')

  await prisma.employee.update({ where: { id: 'emp-A' }, data: { name: '张伟新', currentStoreKey: 'chaowai' } })
  await prisma.user.update({ where: { username: 'staff-A' }, data: { staffKey: 'guanshe::李四' } })
  rows = await staffList()
  assert.deepEqual(rows.map((row) => row.id), ['emp-A'])
  assert.equal(rows[0].name, '张伟新')
  assert.equal(rows[0].storeKey, 'chaowai')
  console.log('  [改名/调店/矛盾 staffKey] employeeId 仍胜出 PASS')

  const staffPermissions = normalizeAccountPermissions(null, 'staff')
  staffPermissions.modules[MODULE_KEYS.EMPLOYEE_PROFILE] = true
  await prisma.user.update({ where: { username: 'staff-A' }, data: { permissions: staffPermissions } })
  const ownProfile = await request(base, '/v2/employees/emp-A/profile', { cookie: cookieA })
  assert.equal(ownProfile.status, 200)
  for (const pathName of ['/v2/employees/emp-B/profile', '/v2/employees/emp-B/contracts', '/v2/employees/emp-B/documents', '/v2/employees/emp-B/summary']) {
    const response = await request(base, pathName, { cookie: cookieA })
    assert.equal(response.status, 403, `${pathName} 必须拒绝`)
  }
  console.log('  [直达 API] staff-A 请求 emp-B → 403 PASS')

  const bonusBody = (employeeId, amountCents) => ({ employeeId, staffName: '张伟', storeKey: 'guanshe', amountCents, date: '2026-08-10' })
  assert.equal((await request(base, '/v2/big-bonuses', { cookie: devCookie, method: 'POST', body: bonusBody('emp-B', 200000) })).status, 200)
  assert.equal((await request(base, '/v2/big-bonuses', { cookie: cookieA, method: 'POST', body: bonusBody('emp-B', 100000) })).status, 403)
  // 测试写入使用账号仍获授权的历史门店，仅验证目标 Employee.id；业务金额规则保持不变。
  assert.equal((await request(base, '/v2/big-bonuses', { cookie: cookieA, method: 'POST', body: bonusBody('emp-A', 100000) })).status, 200)
  const bonusRows = await (await request(base, '/v2/big-bonuses?staffKey=guanshe::张伟', { cookie: cookieA })).json()
  assert.ok(bonusRows.rows.length >= 1)
  assert.equal(bonusRows.rows.every((row) => row.employeeId === 'emp-A'), true)
  console.log('  [大单奖] staff-A 只读写 emp-A；手工金额/POS 独立合同保持 PASS')

  await prisma.dailyPayAdjustment.createMany({ data: [
    { id: 'adj-A', employeeId: 'emp-A', staffName: '张伟', date: new Date('2026-08-10T00:00:00.000Z'), autoPayCentsSnapshot: 26400n, adjustedPayCents: 30000n, reason: 'A 调整', createdBy: 'gate29l-dev', updatedBy: 'gate29l-dev' },
    { id: 'adj-B', employeeId: 'emp-B', staffName: '张伟', date: new Date('2026-08-11T00:00:00.000Z'), autoPayCentsSnapshot: 19800n, adjustedPayCents: 25000n, reason: 'B 调整', createdBy: 'gate29l-dev', updatedBy: 'gate29l-dev' },
  ] })
  const adjustments = await (await request(base, '/v2/daily-pay-adjustments?month=2026-08&staffName=张伟', { cookie: cookieA })).json()
  assert.deepEqual(adjustments.rows.map((row) => row.employeeId), ['emp-A'])
  console.log('  [工资调整] staff-A 只读 emp-A PASS')

  await prisma.payrollNotice.createMany({ data: [
    { id: 'pn-A', employeeId: 'emp-A', periodType: 'month', periodKey: '2026-08', periodStart: new Date('2026-08-01T00:00:00.000Z'), periodEnd: new Date('2026-08-31T00:00:00.000Z'), employeeName: '张伟', storeKey: 'guanshe', targetUsername: 'staff-A', snapshot: { days: [], summary: {} }, totalCents: 26400n, status: 'pending' },
    { id: 'pn-B', employeeId: 'emp-B', periodType: 'month', periodKey: '2026-08', periodStart: new Date('2026-08-01T00:00:00.000Z'), periodEnd: new Date('2026-08-31T00:00:00.000Z'), employeeName: '张伟', storeKey: 'guanshe', targetUsername: 'staff-B', snapshot: { days: [], summary: {} }, totalCents: 19800n, status: 'pending' },
  ] })
  const notices = await (await request(base, '/v2/payroll-notices', { cookie: cookieA })).json()
  assert.deepEqual(notices.rows.map((row) => row.employeeId), ['emp-A'])
  assert.equal((await request(base, '/v2/payroll-notices/pn-B/confirm', { cookie: cookieA, method: 'POST' })).status, 403)
  console.log('  [工资条] staff-A 只读/签收 emp-A PASS')

  const devRows = await (await request(base, '/v2/staff-list', { cookie: devCookie })).json()
  assert.equal(new Set(devRows.rows.map((row) => row.id)).size, 3)
  console.log('  [广域账号] developer 仍可读取完整目录 PASS')

  await prisma.user.update({ where: { username: 'staff-A' }, data: { employeeId: '' } })
  assert.deepEqual(await staffList(), [])
  await prisma.user.update({ where: { username: 'staff-A' }, data: { employeeId: 'emp-not-found' } })
  assert.deepEqual(await staffList(), [])
  const noBindingBonuses = await (await request(base, '/v2/big-bonuses', { cookie: cookieA })).json()
  assert.deepEqual(noBindingBonuses.rows, [])
  console.log('  [缺失/无效绑定] fail closed，无 staffKey/name 回退 PASS')

  console.log('GATE 29L EMPLOYEE SELF-SCOPE AUTHORIZATION TEST OK')
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
