import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-pg-account-isolation-'))
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'gate-4-test-secret-not-for-production'
process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1'
process.env.UPSTASH_REDIS_REST_TOKEN = 'intentionally-unreachable-test-token'
delete process.env.DATA_STORE

import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

process.env.DATABASE_URL = await createDisposablePgSchema('da_gate4')

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
await prisma.employee.create({
  data: {
    id: 'gate4-employee-1',
    employeeNo: 'BUDU-GATE4-1',
    name: 'Gate4员工',
    employmentType: 'fulltime',
    currentStoreKey: 'chaowai',
    status: 'ACTIVE',
  },
})

const { loadDb } = await import('../server/store.js')
await assert.rejects(loadDb, '测试前置条件：legacy loadDb 必须不可用')

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

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`

  const register = await request(base, '/auth/register', {
    method: 'POST',
    body: { username: 'gate4-developer', password: '123456' },
  })
  assert.equal(register.status, 200)
  const developerCookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(developerCookie, '注册成功应设置认证 cookie')

  assert.equal(
    (await request(base, '/admin/users', {
      method: 'POST',
      body: { username: 'unauthorized', password: '123456', role: 'admin' },
    })).status,
    401,
    '账号创建仍须认证',
  )
  assert.equal(
    (await request(base, '/admin/users', {
      cookie: developerCookie,
      method: 'POST',
      body: { username: 'x', password: '123456', role: 'admin' },
    })).status,
    400,
    '用户名校验保持不变',
  )
  assert.equal(
    (await request(base, '/admin/users', {
      cookie: developerCookie,
      method: 'POST',
      body: { username: 'short-password', password: '12345', role: 'admin' },
    })).status,
    400,
    '密码长度校验保持不变',
  )
  assert.equal(
    (await request(base, '/admin/users', {
      cookie: developerCookie,
      method: 'POST',
      body: { username: 'bad-role', password: '123456', role: 'unknown' },
    })).status,
    400,
    '角色校验保持不变',
  )

  const createStaff = await request(base, '/admin/users', {
    cookie: developerCookie,
    method: 'POST',
    body: {
      username: 'gate4-staff',
      password: '123456',
      role: 'staff',
      storeKeys: ['chaowai'],
      staffKey: 'chaowai::Gate4员工',
    },
  })
  assert.equal(createStaff.status, 200, 'legacy loadDb 失败时，PG 账号创建仍成功')
  const created = (await createStaff.json()).user
  assert.equal(created.username, 'gate4-staff')
  assert.equal(created.role, 'staff')
  assert.deepEqual(created.storeKeys, ['chaowai'])
  assert.equal(created.staffKey, 'chaowai::Gate4员工')
  assert.equal(created.employeeId, 'gate4-employee-1')
  assert.equal(typeof created.permissions, 'object')
  assert.equal('passwordHash' in created, false, '响应不得泄露密码哈希')

  const stored = await prisma.user.findUnique({ where: { id: created.id } })
  assert.ok(stored, '账号应写入 PostgreSQL')
  assert.notEqual(stored.passwordHash, '123456', '密码必须保持哈希存储')

  assert.equal(
    (await request(base, '/admin/users', {
      cookie: developerCookie,
      method: 'POST',
      body: {
        username: 'gate4-staff',
        password: '123456',
        role: 'staff',
        storeKeys: ['chaowai'],
        staffKey: 'chaowai::Gate4员工',
      },
    })).status,
    409,
    '重复用户名仍返回 409',
  )

  const staffLogin = await request(base, '/auth/login', {
    method: 'POST',
    body: { username: 'gate4-staff', password: '123456' },
  })
  assert.equal(staffLogin.status, 200, '创建账号的密码仍可正常登录')
  const staffCookie = staffLogin.headers.get('set-cookie')?.split(';')[0] || ''
  assert.equal(
    (await request(base, `/admin/users/${created.id}/role`, {
      cookie: staffCookie,
      method: 'PUT',
      body: { role: 'manager', storeKeys: ['chaowai'], staffKey: 'chaowai::Gate4员工' },
    })).status,
    403,
    '角色更新仍只允许开发者',
  )
  assert.equal(
    (await request(base, `/admin/users/${created.id}/role`, {
      cookie: developerCookie,
      method: 'PUT',
      body: { role: 'unknown' },
    })).status,
    400,
    '角色更新校验保持不变',
  )

  const updateRole = await request(base, `/admin/users/${created.id}/role`, {
    cookie: developerCookie,
    method: 'PUT',
    body: { role: 'manager', storeKeys: ['chaowai'], staffKey: 'chaowai::Gate4员工' },
  })
  assert.equal(updateRole.status, 200, 'legacy loadDb 失败时，PG 角色更新仍成功')
  const updated = (await updateRole.json()).user
  assert.equal(updated.role, 'manager')
  assert.deepEqual(updated.storeKeys, ['chaowai'])
  assert.equal(updated.staffKey, 'chaowai::Gate4员工')
  assert.equal(updated.employeeId, 'gate4-employee-1')
  assert.equal(typeof updated.permissions, 'object')

  const storedAfterRole = await prisma.user.findUnique({ where: { id: created.id } })
  assert.equal(storedAfterRole.role, 'manager', '角色更新应写入 PostgreSQL')
  await assert.rejects(loadDb, '路由成功后 legacy loadDb 仍应保持不可用')

  console.log('PG ACCOUNT LOADDB ISOLATION TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
