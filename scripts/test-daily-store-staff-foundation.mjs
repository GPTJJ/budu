// Gate 12：DailyStoreStaff 按月批量只读数据基础（不改变任何 payroll 结果）
// A 稳定行读取 / B legacy NULL / C 多店 / D 同日多人 / E Store 关系 / F 月过滤 / G 授权
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate12-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-12-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate12_staff_foundation')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }, { key: 'chaowai', name: '北京朝外店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-G12-A', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-G12-B', name: '张伟', currentStoreKey: 'chaowai', status: 'ACTIVE' },
    { id: 'emp-C', employeeNo: 'BUDU-G12-C', name: '李四', currentStoreKey: 'guanshe', status: 'ACTIVE' },
  ],
})
// A/C/D: 稳定行 + 多店 + 同日多人
await prisma.dailyStoreStaff.createMany({
  data: [
    { id: 'dss-a1', storeId: 'guanshe', date: new Date('2026-09-01T00:00:00Z'), employeeId: 'emp-A', staffId: 'st-guanshe-a', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'dss-b1', storeId: 'chaowai', date: new Date('2026-09-01T00:00:00Z'), employeeId: 'emp-B', staffId: 'st-chaowai-b', staffNameSnapshot: '张伟', actualHours: 8 },
    { id: 'dss-c1', storeId: 'guanshe', date: new Date('2026-09-01T00:00:00Z'), employeeId: 'emp-C', staffId: 'st-guanshe-c', staffNameSnapshot: '李四', actualHours: 8 },
    { id: 'dss-legacy', storeId: 'guanshe', date: new Date('2026-09-02T00:00:00Z'), employeeId: null, staffId: 'st-guanshe-legacy', staffNameSnapshot: '王五', actualHours: 4 },
    { id: 'dss-oct', storeId: 'guanshe', date: new Date('2026-10-01T00:00:00Z'), employeeId: 'emp-A', staffId: 'st-guanshe-a', staffNameSnapshot: '张伟', actualHours: 8 },
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
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate12-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  // A: 稳定行读取——employeeId 原样返回
  const rA = await request(base, '/v2/daily-store-staff?month=2026-09', { cookie })
  assert.equal(rA.status, 200, 'A 应 200')
  const rows = (await rA.json()).rows
  const a = rows.find((r) => r.id === 'dss-a1')
  assert.equal(a.employeeId, 'emp-A', 'A 稳定行 employeeId 原样')
  assert.equal(a.staffId, 'st-guanshe-a')
  assert.equal(a.staffNameSnapshot, '张伟')
  assert.equal(a.actualHours, 8)
  console.log('  [A] 稳定行读取 PASS')

  // B: legacy NULL 行——employeeId=null，无姓名推断
  const legacy = rows.find((r) => r.id === 'dss-legacy')
  assert.equal(legacy.employeeId, null, 'B legacy 行 employeeId 必须为 null')
  assert.equal(legacy.staffNameSnapshot, '王五')
  console.log('  [B] legacy NULL PASS')

  // C: 多店保留
  assert.equal(rows.filter((r) => r.storeId === 'guanshe').length, 3)
  assert.equal(rows.filter((r) => r.storeId === 'chaowai').length, 1)
  console.log('  [C] 多店 PASS')

  // D: 同日多人独立返回
  const day1 = rows.filter((r) => r.date === '2026-09-01')
  assert.equal(day1.length, 3, 'D 同日三人独立返回')
  assert.ok(day1.some((r) => r.employeeId === 'emp-A'))
  assert.ok(day1.some((r) => r.employeeId === 'emp-B'))
  assert.ok(day1.some((r) => r.employeeId === 'emp-C'))
  console.log('  [D] 同日多人 PASS')

  // E: Store 关系——storeKey 来自 Store 关系（非字符串猜测）
  assert.equal(a.storeKey, 'guanshe', 'E storeKey = Store.key')
  assert.equal(rows.find((r) => r.id === 'dss-b1').storeKey, 'chaowai')
  console.log('  [E] Store 关系 PASS')

  // F: 月过滤——10 月行不出现
  assert.equal(rows.some((r) => r.id === 'dss-oct'), false, 'F 月外行不得返回')
  const rOct = await request(base, '/v2/daily-store-staff?month=2026-10', { cookie })
  const octRows = (await rOct.json()).rows
  assert.equal(octRows.some((r) => r.id === 'dss-oct'), true)
  assert.equal(octRows.some((r) => r.id === 'dss-a1'), false)
  console.log('  [F] 月过滤 PASS')

  // G: 授权——developer 全量；store-scoped 账号只见本店；越权 403
  const rStore = await request(base, '/v2/daily-store-staff?month=2026-09&store=guanshe', { cookie })
  const storeRows = (await rStore.json()).rows
  assert.equal(storeRows.every((r) => r.storeId === 'guanshe'), true, 'G developer store 过滤生效')
  // 创建 store-scoped 账号（guanshe 员工，storeKeys 限本店）
  const createStaff = await fetch(`${base}/admin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ username: 'staff-g12', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟' }) })
  if (createStaff.status !== 200) console.log('G createStaff:', createStaff.status, await createStaff.text())
  assert.equal(createStaff.status, 200, 'G 创建员工账号')
  const staffLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'staff-g12', password: '123456' }) })
  assert.equal(staffLogin.status, 200, 'G 员工登录')
  const staffCookie = staffLogin.headers.get('set-cookie')?.split(';')[0] || ''
  // 员工只见 guanshe（自己的店）
  const rStaff = await request(base, '/v2/daily-store-staff?month=2026-09', { cookie: staffCookie })
  assert.equal(rStaff.status, 200)
  const staffRows = (await rStaff.json()).rows
  assert.equal(staffRows.length, 3, 'G 员工只见本店 3 行（guanshe）')
  assert.equal(staffRows.some((r) => r.storeId === 'chaowai'), false, 'G 员工不得见朝外店')
  // 员工指定非授权门店 → 403
  const rStaffBad = await request(base, '/v2/daily-store-staff?month=2026-09&store=chaowai', { cookie: staffCookie })
  assert.equal(rStaffBad.status, 403, 'G 员工越权门店 403')
  // 非法月份 400
  const rBadMonth = await request(base, '/v2/daily-store-staff?month=bad', { cookie })
  assert.equal(rBadMonth.status, 400, 'G 非法月份 400')
  console.log('  [G] 授权 PASS')

  console.log('GATE 12 DAILY STORE STAFF FOUNDATION TEST OK')
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
