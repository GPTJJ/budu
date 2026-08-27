import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-gate29n-api-'))
process.env.JWT_SECRET = 'gate29n-local-test-only'
const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('gate29n_participant_api')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
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
  await prisma.store.upsert({ where: { key: 'tongying' }, update: {}, create: { key: 'tongying', name: '北京通盈中心店' } })
  await prisma.employee.create({ data: { id: 'emp-A', employeeNo: 'A-29N', name: '员工A', currentStoreKey: 'tongying', status: 'ACTIVE' } })
  const register = await request(base, '/auth/register', { method: 'POST', body: { username: 'gate29n-dev', password: '123456' } })
  assert.equal(register.status, 200)
  const cookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  await prisma.user.createMany({ data: [
    {
      id: 'user-sub', username: 'gate29n-sub', passwordHash: 'x', role: 'cashier', displayName: '运营替代',
      storeKeys: ['tongying'], status: 'active', operationalIdentityType: 'NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE',
    },
    {
      id: 'user-standard', username: 'gate29n-standard', passwordHash: 'x', role: 'cashier', displayName: '普通账号',
      storeKeys: ['tongying'], status: 'active', operationalIdentityType: 'STANDARD',
    },
  ] })

  const directory = await request(base, '/v2/daily-participants?store=tongying', { cookie })
  assert.equal(directory.status, 200)
  const directoryJson = await directory.json()
  assert.deepEqual(directoryJson.employees.map((row) => row.employeeId), ['emp-A'])
  assert.deepEqual(directoryJson.substitutes.map((row) => row.participantUserId), ['user-sub'])

  const payload = {
    storeKey: 'tongying', date: '2026-08-20',
    items: [
      { employeeId: 'emp-A', actualHours: 8, breakMinutes: 0 },
      { participantUserId: 'user-sub', actualHours: 8, breakMinutes: 0 },
    ],
  }
  const saved = await request(base, '/v2/daily-staff', { cookie, method: 'PUT', body: payload })
  assert.equal(saved.status, 200, await saved.text())
  const rows = await prisma.dailyStoreStaff.findMany({ orderBy: { participantType: 'asc' } })
  assert.deepEqual(new Set(rows.map((row) => row.participantType)), new Set(['EMPLOYEE', 'NON_EMPLOYEE_SUBSTITUTE']))
  assert.equal(rows.find((row) => row.participantType === 'EMPLOYEE').employeeId, 'emp-A')
  assert.equal(rows.find((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').participantUserId, 'user-sub')

  const forged = await request(base, '/v2/daily-staff', {
    cookie, method: 'PUT', body: { ...payload, items: [{ employeeId: 'emp-A', participantType: 'NON_EMPLOYEE_SUBSTITUTE', breakMinutes: 0 }] },
  })
  assert.equal(forged.status, 400)
  const standard = await request(base, '/v2/daily-staff', {
    cookie, method: 'PUT', body: { ...payload, items: [{ participantUserId: 'user-standard', breakMinutes: 0 }] },
  })
  assert.equal(standard.status, 400)
  console.log('GATE 29N DAILY PARTICIPANT API TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect().catch(() => {})
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await admin.$disconnect().catch(() => {})
}
