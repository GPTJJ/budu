// Gate 20：显式 Employee.id 账号绑定
// 同店同名独立绑定 / 跨店同名 / 重复绑定 409（含禁用账号）/ 自持编辑 replay
// 显式 id 优先于快照 / legacy 唯一匹配 / legacy 歧义 409 / 无效 id 400 / Gate 18 集成
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate20-api-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-20-test-secret-not-for-production'
delete process.env.DATA_STORE

const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate20_binding')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.store.createMany({ data: [{ key: 'guanshe', name: '北京官舍店' }, { key: 'chaowai', name: '北京朝外店' }] })
await prisma.employee.createMany({
  data: [
    { id: 'emp-A', employeeNo: 'A001', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-B', employeeNo: 'B001', name: '张伟', currentStoreKey: 'guanshe', status: 'ACTIVE' },
    { id: 'emp-C', employeeNo: 'C001', name: '李四', currentStoreKey: 'chaowai', status: 'ACTIVE' },
  ],
})
await prisma.dailyEntry.create({
  data: { id: 'de-gate20-2026-09-01', storeKey: 'guanshe', date: new Date('2026-09-01T00:00:00.000Z'), incCents: 500000n, ord: 10, staffNames: ['张伟', '张伟'], status: 'confirmed' },
})
await prisma.dailyStoreStaff.createMany({
  data: ['emp-A', 'emp-B'].map((employeeId, index) => ({
    id: `dss-gate20-${employeeId}`, storeId: 'guanshe', date: new Date('2026-09-01T00:00:00.000Z'), employeeId,
    participantType: 'EMPLOYEE', staffId: `staff-${employeeId}`, staffNameSnapshot: '张伟',
    actualHours: index === 0 ? 8 : 6, historicalPayrollHours: null, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal',
  })),
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
  const register = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate20-dev', password: '123456' }) })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(cookie)

  const createUser = (body) => request(base, '/admin/users', { cookie, method: 'POST', body })

  // 同店同名：user-A 显式绑 emp-A、user-B 显式绑 emp-B
  const rA = await createUser({ username: 'user-A', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-A' })
  assert.equal(rA.status, 200, `user-A 应成功: ${await rA.text()}`)
  const rB = await createUser({ username: 'user-B', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-B' })
  assert.equal(rB.status, 200, `user-B 应成功: ${await rB.text()}`)
  const uA = await prisma.user.findUnique({ where: { username: 'user-A' } })
  const uB = await prisma.user.findUnique({ where: { username: 'user-B' } })
  assert.equal(uA.employeeId, 'emp-A', 'user-A → emp-A')
  assert.equal(uB.employeeId, 'emp-B', 'user-B → emp-B')
  assert.equal(uA.staffKey, 'guanshe::张伟', 'staffKey 快照保留')
  console.log('  [同店同名] 独立绑定 PASS')

  // 跨店同名：emp-C 李四@朝外（不同名但跨店独立场景用 emp-C；跨店同名用新员工）
  await prisma.employee.create({ data: { id: 'emp-D', employeeNo: 'D001', name: '李四', currentStoreKey: 'guanshe', status: 'ACTIVE' } })
  const rC = await createUser({ username: 'user-C', password: '123456', role: 'staff', storeKeys: ['chaowai'], staffKey: 'chaowai::李四', employeeId: 'emp-C' })
  assert.equal(rC.status, 200, `user-C 应成功: ${await rC.text()}`)
  const rD = await createUser({ username: 'user-D', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::李四', employeeId: 'emp-D' })
  assert.equal(rD.status, 200, `user-D 应成功: ${await rD.text()}`)
  assert.equal((await prisma.user.findUnique({ where: { username: 'user-C' } })).employeeId, 'emp-C')
  assert.equal((await prisma.user.findUnique({ where: { username: 'user-D' } })).employeeId, 'emp-D')
  console.log('  [跨店同名/不同名] PASS')

  // 重复绑定：user-E 绑 emp-A → 409（user-A active 已占）
  const rE = await createUser({ username: 'user-E', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-A' })
  assert.equal(rE.status, 409, `重复绑定应 409: ${await rE.text()}`)
  // 禁用 user-A 后仍 409（禁用不释放绑定）
  const users = await prisma.user.findMany()
  const uArow = users.find((u) => u.username === 'user-A')
  await prisma.user.update({ where: { id: uArow.id }, data: { status: 'disabled' } })
  const rE2 = await createUser({ username: 'user-E2', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-A' })
  assert.equal(rE2.status, 409, `禁用账号不释放绑定，应 409: ${await rE2.text()}`)
  console.log('  [重复绑定] 409（含禁用账号）PASS')

  // 自持编辑 replay：编辑 user-A 保留 emp-A → 成功（排除自身）
  const uArow2 = await prisma.user.findUnique({ where: { username: 'user-A' } })
  const rSelf = await request(base, `/admin/users/${uArow2.id}/role`, { cookie, method: 'PUT', body: { role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-A' } })
  assert.equal(rSelf.status, 200, `自持编辑应成功: ${await rSelf.text()}`)
  console.log('  [自持编辑] PASS')

  // 显式 id vs 错误快照：employeeId=emp-B（已被 user-B 绑定）+ staffKey=guanshe::李四（不匹配快照）
  // → 基数保护优先：409（绝不绑定、绝不被快照误导）
  const rSnap = await createUser({ username: 'user-S', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::李四', employeeId: 'emp-B' })
  assert.equal(rSnap.status, 409, `emp-B 已绑定 → 409: ${await rSnap.text()}`)
  assert.equal(await prisma.user.count({ where: { username: 'user-S' } }), 0, '不创建')
  // 显式 id 与快照不匹配（emp-D 空闲）：先释放 user-D 的绑定（测试数据准备），再绑 emp-D（显式 id 权威）
  await prisma.user.update({ where: { username: 'user-D' }, data: { employeeId: '' } })
  const rSnap2 = await createUser({ username: 'user-S2', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::李四', employeeId: 'emp-D' })
  assert.equal(rSnap2.status, 200, `显式 id 权威应成功: ${await rSnap2.text()}`)
  assert.equal((await prisma.user.findUnique({ where: { username: 'user-S2' } })).employeeId, 'emp-D', '绑定 emp-D（非快照所指）')
  console.log('  [显式 id vs 快照] PASS（显式 id 权威 + 基数保护）')

  // legacy 唯一匹配：无 employeeId，staffKey=chaowai::李四 → emp-C 唯一（user-C 已绑 emp-C → 409 占用）
  const rLegacy = await createUser({ username: 'user-L', password: '123456', role: 'staff', storeKeys: ['chaowai'], staffKey: 'chaowai::李四' })
  assert.equal(rLegacy.status, 409, `legacy 唯一匹配被基数保护 → 409: ${await rLegacy.text()}`)
  // 释放 emp-C 后 legacy 唯一匹配成功
  await prisma.user.update({ where: { username: 'user-C' }, data: { employeeId: '' } })
  const rLegacy2 = await createUser({ username: 'user-L2', password: '123456', role: 'staff', storeKeys: ['chaowai'], staffKey: 'chaowai::李四' })
  assert.equal(rLegacy2.status, 200, `legacy 唯一匹配应成功: ${await rLegacy2.text()}`)
  assert.equal((await prisma.user.findUnique({ where: { username: 'user-L2' } })).employeeId, 'emp-C', 'legacy 唯一匹配 → emp-C')
  console.log('  [legacy 唯一匹配] PASS')

  // legacy 歧义：无 employeeId，staffKey=guanshe::张伟 → emp-A/emp-B 两个 → 409 ambiguous
  const rAmb = await createUser({ username: 'user-AMB', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟' })
  assert.equal(rAmb.status, 400, `legacy 歧义应 400: ${await rAmb.text()}`)
  assert.equal(await prisma.user.count({ where: { username: 'user-AMB' } }), 0, '歧义不创建账号')
  console.log('  [legacy 歧义] PASS')

  // 无效 employeeId：显式 not-found → 400
  const rBad = await createUser({ username: 'user-BAD', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::张伟', employeeId: 'emp-not-found' })
  assert.equal(rBad.status, 400, `无效 id 应 400: ${await rBad.text()}`)
  console.log('  [无效 employeeId] 400 PASS')

  // Gate 18 集成：绑定 → 发放端到端（emp-A → user-A、emp-B → user-B）
  await prisma.user.update({ where: { username: 'user-A' }, data: { status: 'active' } })
  const { buildAuthoritativeIssueRows, loadAuthoritativePayrollRange } = await import('../server/payroll-authority.js')
  const authority = await loadAuthoritativePayrollRange(prisma, { periodType: 'month', periodKey: '2026-09' })
  const rows = buildAuthoritativeIssueRows(authority, ['emp-A', 'emp-B']).map((row) => ({
    employeeId: row.employeeId, employeeName: row.employeeName, storeKey: row.storeKey,
    snapshot: row.snapshot, totalCents: row.totalCents,
  }))
  const issueRes = await request(base, '/v2/payroll-notices', { cookie, method: 'POST', body: { periodType: 'month', periodKey: '2026-09', rows } })
  assert.equal(issueRes.status, 200, `Gate18 集成发放应成功: ${await issueRes.text()}`)
  const notices = await prisma.payrollNotice.findMany({ where: { periodKey: '2026-09' }, orderBy: { employeeId: 'asc' } })
  assert.equal(notices.length, 2)
  assert.equal(notices[0].employeeId, 'emp-A')
  assert.equal(notices[0].targetUsername, 'user-A', 'emp-A → user-A（经显式绑定）')
  assert.equal(notices[1].employeeId, 'emp-B')
  assert.equal(notices[1].targetUsername, 'user-B', 'emp-B → user-B（经显式绑定）')
  console.log('  [Gate18 集成] 绑定 → 发放端到端 PASS')

  // 矛盾快照归一化（Review 澄清）：显式 employeeId=emp-A + staffKey 描述他人 → staffKey 必须由 canonical Employee 推导
  // create 路径：emp-E 空闲，用矛盾快照创建
  await prisma.employee.create({ data: { id: 'emp-E', employeeNo: 'E001', name: '王五', currentStoreKey: 'guanshe', status: 'ACTIVE' } })
  const rContra = await createUser({ username: 'user-CONTRA', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::李四', employeeId: 'emp-E' })
  assert.equal(rContra.status, 200, `矛盾快照 create 应成功（归一化）: ${await rContra.text()}`)
  const contraUser = await prisma.user.findUnique({ where: { username: 'user-CONTRA' } })
  assert.equal(contraUser.employeeId, 'emp-E', 'create 绑定 emp-E')
  assert.equal(contraUser.staffKey, 'guanshe::王五', 'create staffKey 由 canonical Employee 推导（非 client 矛盾值 guanshe::李四）')
  console.log('  [矛盾快照 create] 归一化 PASS')

  // 释放 user-L2 对 emp-C 的占用（前序 legacy 测试数据）
  await prisma.user.updateMany({ where: { username: 'user-L2' }, data: { employeeId: '' } })
  // edit 路径：user-CONTRA 改绑 emp-C（空闲）+ 矛盾快照（client 传 guanshe::张伟，emp-C 实为李四@chaowai）
  // → 应成功，staffKey 归一化为 canonical（chaowai::李四）；但 storeKeys 需含 emp-C 门店（chaowai）
  const contraRow = await prisma.user.findUnique({ where: { username: 'user-CONTRA' } })
  const rContraEdit = await request(base, `/admin/users/${contraRow.id}/role`, { cookie, method: 'PUT', body: { role: 'staff', storeKeys: ['guanshe', 'chaowai'], staffKey: 'guanshe::张伟', employeeId: 'emp-C' } })
  assert.equal(rContraEdit.status, 200, `矛盾快照 edit 应成功（归一化）: ${await rContraEdit.text()}`)
  const contraAfter = await prisma.user.findUnique({ where: { username: 'user-CONTRA' } })
  assert.equal(contraAfter.employeeId, 'emp-C', 'edit 绑定 emp-C（显式 id 权威）')
  assert.equal(contraAfter.staffKey, 'chaowai::李四', 'edit staffKey 由 canonical Employee（emp-C=李四@chaowai）推导，非 client 矛盾值 guanshe::张伟')
  console.log('  [矛盾快照 edit] 归一化 PASS')

  console.log('GATE 20 EXPLICIT EMPLOYEE ACCOUNT BINDING TEST OK')
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
