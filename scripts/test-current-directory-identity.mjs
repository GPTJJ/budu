// Gate 7：当前员工目录稳定 Employee.id 身份回归测试（server API 级）
import { fileURLToPath } from 'node:url'
// - 跨店同名员工同时存在、各自保留 id
// - POST /v2/employees/:id/status-change RESIGN 只影响指定员工，不误伤同名员工
// - GET /v2/staff-list 目录不折叠重名
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate7-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-7-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate7_directory')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({
  data: [
    { key: 'guanshe', name: '北京官舍店' },
    { key: 'chaowai', name: '北京朝外店' },
  ],
})
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'BUDU-G7-A', name: '张伟', currentStoreKey: 'guanshe', employmentType: 'fulltime', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'BUDU-G7-B', name: '张伟', currentStoreKey: 'chaowai', employmentType: 'parttime', status: 'ACTIVE' },
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
  const register = await request(base, '/auth/register', { method: 'POST', body: { username: 'gate7-dev', password: '123456' } })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  // SCENARIO A: 跨店同名 → 目录同时存在两人，各自保留 id
  const listRes = await request(base, '/v2/staff-list', { cookie })
  assert.equal(listRes.status, 200)
  const list = (await listRes.json()).rows
  const zhangwei = list.filter((e) => e.name === '张伟')
  assert.equal(zhangwei.length, 2, '跨店同名必须同时出现在当前目录')
  const ids = new Set(zhangwei.map((e) => e.id))
  assert.ok(ids.has('emp-A') && ids.has('emp-B'), '各自保留 Employee.id')
  assert.equal(zhangwei.filter((e) => e.storeKey === 'guanshe').length, 1)
  assert.equal(zhangwei.filter((e) => e.storeKey === 'chaowai').length, 1)

  // SCENARIO C: 定向离职 emp-A → 只影响 emp-A
  const resignRes = await request(base, '/v2/employees/emp-A/status-change', {
    cookie, method: 'POST', body: { action: 'RESIGN', resignReason: 'Gate 7 测试' },
  })
  assert.equal(resignRes.status, 200)

  const after = await prisma.employee.findMany({ where: { name: '张伟' }, orderBy: { id: 'asc' } })
  assert.equal(after.length, 2)
  const a = after.find((e) => e.id === 'emp-A')
  const b = after.find((e) => e.id === 'emp-B')
  assert.equal(a.status, 'RESIGNED', 'emp-A 必须离职')
  assert.equal(b.status, 'ACTIVE', 'emp-B 必须保持在职（不误伤同名）')

  // 离职后目录只剩 emp-B
  const list2 = (await (await request(base, '/v2/staff-list', { cookie })).json()).rows
  const zhangwei2 = list2.filter((e) => e.name === '张伟')
  assert.equal(zhangwei2.length, 1)
  assert.equal(zhangwei2[0].id, 'emp-B')

  // SCENARIO F: 历史 payroll 快照不受影响（无 payroll 表写入；员工记录仍完整保留）
  const empA = await prisma.employee.findUnique({ where: { id: 'emp-A' } })
  assert.equal(empA.name, '张伟')
  assert.equal(empA.employeeNo, 'BUDU-G7-A')

  console.log('GATE 7 CURRENT DIRECTORY IDENTITY TEST OK')
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
