import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ALL_MODULE_KEYS } from '../shared/accountPermissions.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-role-api-'))
process.env.DATA_DIR = dataDir
// Data Authority DA-2：账号权威 = PostgreSQL → 测试使用一次性 PG schema（全量迁移）
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'
process.env.DATABASE_URL = await createDisposablePgSchema('da_role')
const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)

const request = async (base, pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${base}${pathname}`, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const register = await request(base, '/auth/register', { method: 'POST', body: { username: 'developer1', password: '123456' } })
  assert.equal(register.status, 200)
  const developerCookie = register.headers.get('set-cookie')?.split(';')[0] || ''

  const seed = await request(base, '/userdata', {
    cookie: developerCookie,
    method: 'PUT',
    body: {
      stores: [{ key: 'guanshe', name: '官舍店' }],
      staff: [{ storeKey: 'guanshe', name: '测试员工', type: 'fulltime' }],
    },
  })
  assert.equal(seed.status, 200)

  const createAdmin = await request(base, '/admin/users', { cookie: developerCookie, method: 'POST', body: { username: 'admin1', password: '123456', role: 'admin' } })
  assert.equal(createAdmin.status, 200)
  const admin = (await createAdmin.json()).user

  const badManager = await request(base, '/admin/users', { cookie: developerCookie, method: 'POST', body: { username: 'manager0', password: '123456', role: 'manager', storeKeys: ['guanshe'] } })
  assert.equal(badManager.status, 400)

  const createStaff = await request(base, '/admin/users', { cookie: developerCookie, method: 'POST', body: { username: 'staff1', password: '123456', role: 'staff', storeKeys: ['guanshe'], staffKey: 'guanshe::测试员工' } })
  assert.equal(createStaff.status, 200)
  const staff = (await createStaff.json()).user

  const publicRole = await request(base, '/admin/users', { cookie: developerCookie, method: 'POST', body: { username: 'public-new', password: '123456', role: 'public' } })
  assert.equal(publicRole.status, 400)

  const loginAdmin = await request(base, '/auth/login', { method: 'POST', body: { username: 'admin1', password: '123456' } })
  const adminCookie = loginAdmin.headers.get('set-cookie')?.split(';')[0] || ''
  assert.equal((await request(base, '/admin/users', { cookie: adminCookie })).status, 403)

  const modulesWithoutFinance = Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, key !== 'finance']))
  assert.equal((await request(base, `/admin/users/${admin.id}/permissions`, { cookie: developerCookie, method: 'PUT', body: { modules: modulesWithoutFinance } })).status, 200)
  assert.equal((await request(base, '/v2/profit?month=2026-08', { cookie: adminCookie })).status, 403)

  assert.equal((await request(base, '/v2/products', { cookie: (await request(base, '/auth/login', { method: 'POST', body: { username: 'staff1', password: '123456' } })).headers.get('set-cookie')?.split(';')[0] || '' })).status, 403)
  const staffModules = { ...(staff.permissions?.modules || {}), 'product-center': true }
  assert.equal((await request(base, `/admin/users/${staff.id}/permissions`, { cookie: developerCookie, method: 'PUT', body: { modules: staffModules } })).status, 200)
  const staffLogin2 = await request(base, '/auth/login', { method: 'POST', body: { username: 'staff1', password: '123456' } })
  const staffCookie2 = staffLogin2.headers.get('set-cookie')?.split(';')[0] || ''
  assert.notEqual((await request(base, '/v2/products', { cookie: staffCookie2 })).status, 403)

  assert.equal((await request(base, `/admin/users/${admin.id}/permissions`, { cookie: adminCookie, method: 'PUT', body: { modules: modulesWithoutFinance } })).status, 403)
  console.log('ROLE MODULE API TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
}
