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
  await prisma.store.createMany({ data: [
    { key: 'tongying', name: '北京通盈中心店' },
    { key: 'xidan', name: '北京西单店' },
  ] })
  await prisma.employee.createMany({ data: [
    { id: 'emp-A', employeeNo: 'A-29N', name: '员工A', currentStoreKey: 'tongying', status: 'ACTIVE' },
    { id: 'emp-chen', employeeNo: 'C-29N', name: '陈文慧', currentStoreKey: 'xidan', status: 'ACTIVE' },
    { id: 'emp-same-a', employeeNo: 'S1-29N', name: '同名员工', currentStoreKey: 'tongying', status: 'ACTIVE' },
    { id: 'emp-same-b', employeeNo: 'S2-29N', name: '同名员工', currentStoreKey: 'xidan', status: 'ACTIVE' },
    { id: 'emp-probation', employeeNo: 'P-29N', name: '试用员工', currentStoreKey: 'xidan', status: 'PROBATION' },
    { id: 'emp-leave', employeeNo: 'L-29N', name: '停岗员工', currentStoreKey: 'tongying', status: 'LEAVE' },
    { id: 'emp-former', employeeNo: 'R-29N', name: '历史员工', currentStoreKey: 'tongying', status: 'RESIGNED' },
  ] })
  await prisma.schedule.create({
    data: {
      id: 'schedule-29n', weekStart: '2026-08-24', storeKey: 'tongying', date: '2026-08-24',
      shifts: [{ staff: '陈文慧', time: '09:00-21:00', note: '跨店顶班' }],
    },
  })
  await prisma.dailyEntry.create({
    data: { id: 'de-chen-control', storeKey: 'tongying', date: new Date('2026-08-24T00:00:00.000Z'), incCents: 1234500n, ord: 37, staffNames: ['陈文慧'], status: 'confirmed' },
  })
  await prisma.dailyStoreStaff.createMany({ data: [
    {
      id: 'dss-chen-control', storeId: 'tongying', date: new Date('2026-08-24T00:00:00.000Z'),
      employeeId: 'emp-chen', participantType: 'EMPLOYEE', staffId: 'employee:emp-chen', staffNameSnapshot: '陈文慧',
      actualHours: 12, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal',
    },
    {
      id: 'dss-former-history', storeId: 'tongying', date: new Date('2026-08-23T00:00:00.000Z'),
      employeeId: 'emp-former', participantType: 'EMPLOYEE', staffId: 'employee:emp-former', staffNameSnapshot: '历史员工',
      actualHours: 8, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal',
    },
  ] })
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

  const beforeRead = {
    entries: await prisma.dailyEntry.count(),
    staff: await prisma.dailyStoreStaff.count(),
    audits: await prisma.dailyEntryAuditLog.count(),
  }
  const directory = await request(base, '/v2/daily-participants?store=tongying&date=2026-08-24', { cookie })
  assert.equal(directory.status, 200)
  const directoryJson = await directory.json()
  assert.equal(directoryJson.employees[0].employeeId, 'emp-chen', '排班仅用于推荐排序，跨店员工必须可选')
  assert.equal(directoryJson.employees[0].priorityGroup, 1)
  assert.deepEqual(new Set(directoryJson.employees.map((row) => row.employeeId)), new Set([
    'emp-A', 'emp-chen', 'emp-same-a', 'emp-same-b', 'emp-probation',
  ]))
  assert.equal(directoryJson.employees.some((row) => row.employeeId === 'emp-leave'), false)
  assert.equal(directoryJson.employees.some((row) => row.employeeId === 'emp-former'), false)
  assert.equal(directoryJson.employees.filter((row) => row.label === '同名员工').length, 2)
  assert.deepEqual(directoryJson.substitutes.map((row) => row.participantUserId), ['user-sub'])

  const historical = await request(base, '/v2/daily-entry/overview?store=tongying&date=2026-08-24', { cookie })
  assert.equal(historical.status, 200)
  const historicalJson = await historical.json()
  assert.equal(historicalJson.entry.incCents, '1234500')
  assert.equal(historicalJson.staff[0].employeeId, 'emp-chen')
  assert.equal(historicalJson.staff[0].actualHours, 12)
  const former = await request(base, '/v2/daily-entry/overview?store=tongying&date=2026-08-23', { cookie })
  assert.equal(former.status, 200)
  assert.equal((await former.json()).staff[0].employeeId, 'emp-former', '历史参与者不得因当前离职状态消失')
  assert.deepEqual({
    entries: await prisma.dailyEntry.count(),
    staff: await prisma.dailyStoreStaff.count(),
    audits: await prisma.dailyEntryAuditLog.count(),
  }, beforeRead, '候选/历史 GET 必须零业务写入')

  const payload = {
    storeKey: 'tongying', date: '2026-08-25',
    items: [
      { employeeId: 'emp-A', actualHours: 8, breakMinutes: 0 },
      { participantUserId: 'user-sub', actualHours: 8, breakMinutes: 0 },
    ],
  }
  const saved = await request(base, '/v2/daily-staff', { cookie, method: 'PUT', body: payload })
  assert.equal(saved.status, 200, await saved.text())
  const rows = await prisma.dailyStoreStaff.findMany({
    where: { storeId: 'tongying', date: new Date('2026-08-25T00:00:00.000Z') },
    orderBy: { participantType: 'asc' },
  })
  assert.deepEqual(new Set(rows.map((row) => row.participantType)), new Set(['EMPLOYEE', 'NON_EMPLOYEE_SUBSTITUTE']))
  assert.equal(rows.find((row) => row.participantType === 'EMPLOYEE').employeeId, 'emp-A')
  assert.equal(rows.find((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').participantUserId, 'user-sub')

  const crossStore = await request(base, '/v2/daily-staff', {
    cookie, method: 'PUT', body: {
      storeKey: 'tongying', date: '2026-08-26',
      items: [
        { employeeId: 'emp-chen', actualHours: 12, breakMinutes: 0 },
        { employeeId: 'emp-same-a', actualHours: 8, breakMinutes: 0 },
        { employeeId: 'emp-same-b', actualHours: 8, breakMinutes: 0 },
      ],
    },
  })
  assert.equal(crossStore.status, 200, await crossStore.text())
  const sameNameRows = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'tongying', date: new Date('2026-08-26T00:00:00.000Z') } })
  assert.deepEqual(new Set(sameNameRows.filter((row) => row.staffNameSnapshot === '同名员工').map((row) => row.employeeId)), new Set(['emp-same-a', 'emp-same-b']))
  assert.equal((await prisma.employee.findUnique({ where: { id: 'emp-chen' } })).currentStoreKey, 'xidan', '跨店值班不得更改员工主店')
  const chenControl = await prisma.dailyStoreStaff.findUnique({
    where: { storeId_date_employeeId: { storeId: 'tongying', date: new Date('2026-08-24T00:00:00.000Z'), employeeId: 'emp-chen' } },
  })
  assert.equal(chenControl.actualHours, 12, '8/24 陈文慧 12h 控制必须保持不变且不重复')
  assert.equal(chenControl.payableHoursSource, 'ACTUAL_HOURS')

  const forged = await request(base, '/v2/daily-staff', {
    cookie, method: 'PUT', body: { ...payload, items: [{ employeeId: 'emp-A', participantType: 'NON_EMPLOYEE_SUBSTITUTE', actualHours: 8, breakMinutes: 0 }] },
  })
  assert.equal(forged.status, 400)
  const standard = await request(base, '/v2/daily-staff', {
    cookie, method: 'PUT', body: { ...payload, items: [{ participantUserId: 'user-standard', actualHours: 8, breakMinutes: 0 }] },
  })
  assert.equal(standard.status, 400)
  console.log('GATE 29N DAILY PARTICIPANT API TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect().catch(() => {})
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await admin.$disconnect().catch(() => {})
}
