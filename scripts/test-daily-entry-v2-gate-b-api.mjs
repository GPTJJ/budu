import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-daily-entry-gate-b-'))
process.env.JWT_SECRET = 'daily-entry-gate-b-local-test-only'
const { createDisposablePgSchema } = await import('./helpers/test-pg-schema.mjs')
process.env.DATABASE_URL = await createDisposablePgSchema('daily_entry_gate_b')
const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema')
const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
const { createApp } = await import('../server/app.js')
const server = createApp().listen(0)

const date = (value) => new Date(`${value}T00:00:00.000Z`)
const request = async (base, pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${base}${pathname}`, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const login = async (base, username, password) => {
  const response = await request(base, '/auth/login', { method: 'POST', body: { username, password } })
  assert.equal(response.status, 200, await response.text())
  return response.headers.get('set-cookie')?.split(';')[0] || ''
}
const staffItem = (employeeId, actualHours = 8) => ({ employeeId, actualHours, breakMinutes: 0, attendanceStatus: 'normal' })
const manualConfirm = (day, version, items, incCents = 128800, ord = 18) => ({
  storeKey: 'tongying', date: day, version,
  manualSales: { incCents, ord }, items, reason: 'Gate B isolated test',
})
const countsFor = async (day) => ({
  entries: await prisma.dailyEntry.count({ where: { storeKey: 'tongying', date: date(day) } }),
  staff: await prisma.dailyStoreStaff.count({ where: { storeId: 'tongying', date: date(day) } }),
  audits: await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date(day) } }),
})

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api`
  await prisma.store.createMany({ data: [
    { key: 'tongying', name: '北京通盈中心店', salesDataSource: 'manual' },
    { key: 'xidan', name: '北京西单店', salesDataSource: 'pos' },
  ] })
  await prisma.employee.createMany({ data: [
    { id: 'emp-gb-a', employeeNo: 'GB-A', name: '员工A', currentStoreKey: 'tongying', status: 'ACTIVE' },
    { id: 'emp-gb-b', employeeNo: 'GB-B', name: '员工B', currentStoreKey: 'tongying', status: 'PROBATION' },
    { id: 'emp-gb-resigned', employeeNo: 'GB-R', name: '离职员工', currentStoreKey: 'tongying', status: 'RESIGNED' },
  ] })
  const register = await request(base, '/auth/register', { method: 'POST', body: { username: 'gate-b-dev', password: '123456' } })
  assert.equal(register.status, 200, await register.text())
  const devCookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  const createStaff = await request(base, '/admin/users', {
    cookie: devCookie, method: 'POST', body: {
      username: 'gate-b-staff', password: '123456', role: 'staff', name: 'Gate B 员工',
      storeKeys: ['tongying'], employeeId: 'emp-gb-a',
    },
  })
  assert.equal(createStaff.status, 200, await createStaff.text())
  const staffCookie = await login(base, 'gate-b-staff', '123456')

  // Manual: one command persists sales + stable identities + actual hours + confirmation + audit.
  const confirmed = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm('2026-09-01', 0, [staffItem('emp-gb-a', 8), staffItem('emp-gb-b', 6.5)]),
  })
  if (confirmed.status !== 200) assert.fail(`manual confirmation failed: ${confirmed.status} ${await confirmed.text()}`)
  const confirmedJson = await confirmed.json()
  assert.equal(confirmedJson.entry.status, 'confirmed')
  assert.equal(confirmedJson.entry.version, 1)
  assert.equal(confirmedJson.entry.incCents, '128800')
  assert.equal(confirmedJson.staff.length, 2)
  assert.deepEqual(new Map(confirmedJson.staff.map((row) => [row.employeeId, row.actualHours])), new Map([['emp-gb-a', 8], ['emp-gb-b', 6.5]]))
  assert.ok((await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date('2026-09-01') } })) >= 3)

  // Confirmed facts are immutable through normal delete/unconfirm paths, including developer hard delete.
  const hardDelete = await request(base, '/v2/daily-entries', {
    cookie: devCookie, method: 'DELETE', body: { storeKey: 'tongying', date: '2026-09-01' },
  })
  assert.equal(hardDelete.status, 409)
  const staffUnconfirm = await request(base, '/v2/daily-entry/unconfirm', {
    cookie: staffCookie, method: 'POST', body: { storeKey: 'tongying', date: '2026-09-01' },
  })
  assert.equal(staffUnconfirm.status, 403)

  // POS authority: forged client sales are rejected with zero write; staff-only confirmation succeeds.
  const forgedPos = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: {
      storeKey: 'xidan', date: '2026-09-01', version: 0,
      manualSales: { incCents: 999999, ord: 99 }, items: [staffItem('emp-gb-a')],
    },
  })
  assert.equal(forgedPos.status, 403)
  assert.equal(await prisma.dailyEntry.count({ where: { storeKey: 'xidan' } }), 0)
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'xidan' } }), 0)
  const posConfirmed = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: {
      storeKey: 'xidan', date: '2026-09-01', version: 0, items: [staffItem('emp-gb-a', 7.25)],
    },
  })
  assert.equal(posConfirmed.status, 200, await posConfirmed.text())
  const posEntry = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey: 'xidan', date: date('2026-09-01') } } })
  assert.equal(posEntry.incCents, 0n)
  assert.equal(posEntry.ord, 0)
  assert.equal(posEntry.status, 'confirmed')

  // Payroll preflight: missing/invalid identity, missing hours and duplicate identities fail closed.
  for (const [day, items] of [
    ['2026-09-02', [{ employeeId: 'emp-gb-a', actualHours: '' }]],
    ['2026-09-03', [staffItem('missing-employee')]],
    ['2026-09-04', [staffItem('emp-gb-a'), staffItem('emp-gb-a')]],
    ['2026-09-05', [staffItem('emp-gb-resigned')]],
  ]) {
    const rejected = await request(base, '/v2/daily-entry/confirm', {
      cookie: devCookie, method: 'POST', body: manualConfirm(day, 0, items),
    })
    assert.ok([400, 409].includes(rejected.status), `${day}: ${rejected.status} ${await rejected.text()}`)
    assert.deepEqual(await countsFor(day), { entries: 0, staff: 0, audits: 0 })
  }

  // Optimistic concurrency: stale version never overwrites current server facts.
  await prisma.dailyEntry.create({ data: {
    id: 'de-gb-stale', storeKey: 'tongying', date: date('2026-09-06'), incCents: 50000n, ord: 5, version: 2, status: 'draft',
  } })
  const stale = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm('2026-09-06', 1, [staffItem('emp-gb-a')], 99900, 9),
  })
  assert.equal(stale.status, 409)
  assert.match((await stale.json()).error, /其他用户更新/)
  const staleEntry = await prisma.dailyEntry.findUnique({ where: { id: 'de-gb-stale' } })
  assert.equal(staleEntry.incCents, 50000n)
  assert.equal(staleEntry.status, 'draft')
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'tongying', date: date('2026-09-06') } }), 0)

  // Two devices confirming the same untouched day serialize on the advisory lock.
  // Exactly one command wins; the other receives a version conflict and cannot merge partial facts.
  const concurrentDay = '2026-09-10'
  const concurrentResponses = await Promise.all([
    request(base, '/v2/daily-entry/confirm', {
      cookie: devCookie, method: 'POST', body: manualConfirm(concurrentDay, 0, [staffItem('emp-gb-a', 8)], 111100, 11),
    }),
    request(base, '/v2/daily-entry/confirm', {
      cookie: devCookie, method: 'POST', body: manualConfirm(concurrentDay, 0, [staffItem('emp-gb-b', 6)], 222200, 22),
    }),
  ])
  assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [200, 409])
  const concurrentEntry = await prisma.dailyEntry.findUnique({
    where: { storeKey_date: { storeKey: 'tongying', date: date(concurrentDay) } },
  })
  assert.equal(concurrentEntry.status, 'confirmed')
  assert.equal(concurrentEntry.version, 1)
  assert.ok([111100n, 222200n].includes(concurrentEntry.incCents))
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'tongying', date: date(concurrentDay) } }), 1)
  assert.ok((await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date(concurrentDay) } })) >= 2)

  // DailyStoreStaff failure never leaves a DailyEntry, partial staff list or audit behind.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".gate_b_fail_staff() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."date" = DATE '2026-09-11' THEN RAISE EXCEPTION 'gate b private staff failure'; END IF;
      RETURN NEW;
    END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER gate_b_fail_staff BEFORE INSERT ON "${schema}"."daily_store_staff" FOR EACH ROW EXECUTE FUNCTION "${schema}".gate_b_fail_staff()`)
  const staffFailure = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm('2026-09-11', 0, [staffItem('emp-gb-a')]),
  })
  assert.equal(staffFailure.status, 500)
  assert.doesNotMatch((await staffFailure.json()).error, /Prisma|SQL|gate b private|\/private\//)
  assert.deepEqual(await countsFor('2026-09-11'), { entries: 0, staff: 0, audits: 0 })
  await prisma.$executeRawUnsafe(`DROP TRIGGER gate_b_fail_staff ON "${schema}"."daily_store_staff"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION "${schema}".gate_b_fail_staff()`)

  // DailyEntry write failure after staff work rolls the entire transaction back.
  await prisma.dailyEntry.create({ data: {
    id: 'de-gb-entry-fail', storeKey: 'tongying', date: date('2026-09-07'), incCents: 100n, ord: 1, version: 1, status: 'draft',
  } })
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".gate_b_fail_entry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."date" = DATE '2026-09-07' THEN RAISE EXCEPTION 'gate b private entry failure'; END IF;
      RETURN NEW;
    END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER gate_b_fail_entry BEFORE UPDATE ON "${schema}"."DailyEntry" FOR EACH ROW EXECUTE FUNCTION "${schema}".gate_b_fail_entry()`)
  const entryFailure = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm('2026-09-07', 1, [staffItem('emp-gb-a')]),
  })
  assert.equal(entryFailure.status, 500)
  assert.doesNotMatch((await entryFailure.json()).error, /Prisma|SQL|gate b private|\/private\//)
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'tongying', date: date('2026-09-07') } }), 0)
  assert.equal((await prisma.dailyEntry.findUnique({ where: { id: 'de-gb-entry-fail' } })).status, 'draft')
  assert.equal(await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date('2026-09-07') } }), 0)
  await prisma.$executeRawUnsafe(`DROP TRIGGER gate_b_fail_entry ON "${schema}"."DailyEntry"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION "${schema}".gate_b_fail_entry()`)

  // Audit failure is fail-closed and also rolls staff/entry changes back.
  await prisma.dailyEntry.create({ data: {
    id: 'de-gb-audit-fail', storeKey: 'tongying', date: date('2026-09-08'), incCents: 100n, ord: 1, version: 1, status: 'draft',
  } })
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".gate_b_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."date" = DATE '2026-09-08' THEN RAISE EXCEPTION 'gate b private audit failure'; END IF;
      RETURN NEW;
    END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER gate_b_fail_audit BEFORE INSERT ON "${schema}"."daily_entry_audit_logs" FOR EACH ROW EXECUTE FUNCTION "${schema}".gate_b_fail_audit()`)
  const auditFailure = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm('2026-09-08', 1, [staffItem('emp-gb-a')]),
  })
  assert.equal(auditFailure.status, 500)
  assert.doesNotMatch((await auditFailure.json()).error, /Prisma|SQL|gate b private|\/private\//)
  assert.equal(await prisma.dailyStoreStaff.count({ where: { storeId: 'tongying', date: date('2026-09-08') } }), 0)
  assert.equal((await prisma.dailyEntry.findUnique({ where: { id: 'de-gb-audit-fail' } })).status, 'draft')
  assert.equal(await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date('2026-09-08') } }), 0)

  // Draft delete stays available to a scoped editor and never touches confirmed facts.
  await prisma.dailyEntry.create({ data: {
    id: 'de-gb-draft-delete', storeKey: 'tongying', date: date('2026-09-09'), incCents: 100n, ord: 1, version: 1, status: 'draft',
  } })
  const draftDelete = await request(base, '/v2/daily-entries', {
    cookie: staffCookie, method: 'DELETE', body: { storeKey: 'tongying', date: '2026-09-09' },
  })
  assert.equal(draftDelete.status, 200, await draftDelete.text())
  assert.equal(await prisma.dailyEntry.count({ where: { id: 'de-gb-draft-delete' } }), 0)

  console.log('DAILY ENTRY V2 GATE B API TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect().catch(() => {})
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await admin.$disconnect().catch(() => {})
}
