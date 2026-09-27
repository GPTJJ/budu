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
const { loadAuthoritativePayrollRange } = await import('../server/payroll-authority.js')
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
    { id: 'emp-gb-c', employeeNo: 'GB-C', name: '员工C', currentStoreKey: 'tongying', status: 'ACTIVE', employmentType: 'parttime' },
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

  // Gate C: schedule prefill reads stable employeeId only; legacy staff snapshots remain unresolved.
  await prisma.schedule.create({ data: {
    id: 'sc-gate-c', weekStart: '2026-08-31', storeKey: 'tongying', date: '2026-08-31',
    shifts: [
      { employeeId: 'emp-gb-a', staff: '员工A', time: '10:00-18:00' },
      { staff: '员工B', time: '13:00-21:00' },
    ],
  } })
  const schedulePrefill = await request(base, '/v2/daily-participants?store=tongying&date=2026-08-31', { cookie: devCookie })
  if (schedulePrefill.status !== 200) assert.fail(`schedule prefill failed: ${schedulePrefill.status} ${await schedulePrefill.text()}`)
  const schedulePrefillJson = await schedulePrefill.json()
  assert.deepEqual(schedulePrefillJson.schedule.scheduledEmployeeIds, ['emp-gb-a'])
  assert.equal(schedulePrefillJson.schedule.unresolved[0].reason, 'MISSING_EMPLOYEE_ID')
  assert.equal(schedulePrefillJson.employees.find((row) => row.employeeId === 'emp-gb-a').scheduled, true)
  assert.equal(schedulePrefillJson.employees.find((row) => row.employeeId === 'emp-gb-b').scheduled, false, 'legacy staff name must not guess emp-gb-b')
  await prisma.schedule.update({ where: { id: 'sc-gate-c' }, data: {
    shifts: [{ employeeId: 'emp-gb-b', staff: '员工B', time: '13:00-21:00' }],
  } })
  const refreshedSchedule = await request(base, '/v2/daily-participants?store=tongying&date=2026-08-31', { cookie: devCookie })
  const refreshedScheduleJson = await refreshedSchedule.json()
  assert.deepEqual(refreshedScheduleJson.schedule.scheduledEmployeeIds, ['emp-gb-b'])

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

  // Gate D ledger: saved DailyEntry/DailyStoreStaff facts only, stable status derivation,
  // store scope, and machine-readable completeness. Confirmation audits must not
  // falsely turn an ordinary confirmed day into "revised".
  await prisma.dailyEntry.create({ data: {
    id: 'de-gd-draft', storeKey: 'tongying', date: date('2026-09-12'), incCents: 33300n, ord: 3, version: 1, status: 'draft',
  } })
  await prisma.dailyEntry.create({ data: {
    id: 'de-gd-legacy', storeKey: 'tongying', date: date('2026-09-13'), incCents: 44400n, ord: 4, version: 3,
    status: 'confirmed', confirmedAt: new Date('2026-09-13T14:00:00.000Z'), confirmedBy: 'historical-import',
  } })
  await prisma.dailyStoreStaff.create({ data: {
    id: 'dss-gd-legacy', storeId: 'tongying', date: date('2026-09-13'), employeeId: null,
    participantType: 'LEGACY_UNKNOWN', participantUserId: null, staffId: 'legacy:旧员工', staffNameSnapshot: '旧员工',
    actualHours: null, historicalPayrollHours: 7, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED',
  } })
  const ledgerBeforeRevision = await request(base, '/v2/daily-entry/ledger?month=2026-09&store=tongying&status=all', { cookie: devCookie })
  if (ledgerBeforeRevision.status !== 200) assert.fail(`ledger failed: ${ledgerBeforeRevision.status} ${await ledgerBeforeRevision.text()}`)
  const ledgerBeforeJson = await ledgerBeforeRevision.json()
  const ordinaryConfirmed = ledgerBeforeJson.rows.find((row) => row.date === '2026-09-01')
  assert.equal(ordinaryConfirmed.status, 'confirmed', 'confirmation audit is not a post-confirm revision')
  assert.equal(ordinaryConfirmed.salesSourceLabel, '美团收银 · 人工录入')
  assert.equal(ordinaryConfirmed.incCents, '128800')
  assert.equal(ordinaryConfirmed.ord, 18)
  assert.equal(ordinaryConfirmed.avgCents, '7155')
  assert.equal(ordinaryConfirmed.completeness.status, 'COMPLETE')
  assert.deepEqual(ordinaryConfirmed.staff.map((row) => row.employeeId).sort(), ['emp-gb-a', 'emp-gb-b'])
  assert.equal(ledgerBeforeJson.rows.find((row) => row.date === '2026-09-12').completeness.code, 'DRAFT_ENTRY')
  assert.equal(ledgerBeforeJson.rows.find((row) => row.date === '2026-09-13').completeness.code, 'UNRESOLVED_EMPLOYEE')

  await prisma.dailyEntryAuditLog.create({ data: {
    id: 'audit-gd-real-revision', storeId: 'tongying', date: date('2026-09-01'), module: 'daily_revision',
    fieldName: 'facts', beforeValue: { incCents: '128800' }, afterValue: { incCents: '128800' },
    reason: 'Gate D controlled revision fixture', operatorId: 'gate-b-dev', operatorName: 'gate-b-dev',
    createdAt: new Date(Date.now() + 1000),
  } })
  const confirmedLedger = await request(base, '/v2/daily-entry/ledger?month=2026-09&store=tongying&status=confirmed', { cookie: devCookie })
  if (confirmedLedger.status !== 200) assert.fail(`confirmed ledger failed: ${confirmedLedger.status} ${await confirmedLedger.text()}`)
  const confirmedLedgerJson = await confirmedLedger.json()
  assert.equal(confirmedLedgerJson.rows.find((row) => row.date === '2026-09-01').status, 'revised')
  assert.equal(confirmedLedgerJson.rows.some((row) => row.date === '2026-09-12'), false)
  const anomalyLedger = await request(base, '/v2/daily-entry/ledger?month=2026-09&store=tongying&status=anomaly', { cookie: devCookie })
  if (anomalyLedger.status !== 200) assert.fail(`anomaly ledger failed: ${anomalyLedger.status} ${await anomalyLedger.text()}`)
  const anomalyLedgerJson = await anomalyLedger.json()
  assert.ok(anomalyLedgerJson.rows.some((row) => row.date === '2026-09-12'))
  assert.ok(anomalyLedgerJson.rows.some((row) => row.date === '2026-09-13'))
  assert.equal(anomalyLedgerJson.rows.some((row) => row.date === '2026-09-01'), false)
  const crossStoreLedger = await request(base, '/v2/daily-entry/ledger?month=2026-09&store=xidan&status=all', { cookie: staffCookie })
  assert.equal(crossStoreLedger.status, 403)

  // Gate E read-only completeness projection returns explicit authority codes.
  const completenessCode = async (day, cookie = devCookie, store = 'tongying') => {
    const response = await request(base, `/v2/daily-entry/completeness?store=${store}&date=${day}`, { cookie })
    if (response.status !== 200) return { status: response.status, body: await response.json() }
    return (await response.json()).completeness
  }
  assert.equal((await completenessCode('2026-09-01')).code, 'COMPLETE')
  assert.equal((await completenessCode('2026-09-15')).code, 'MISSING_DAILY_ENTRY')
  assert.equal((await completenessCode('2026-09-12')).code, 'DRAFT_ENTRY')
  assert.equal((await completenessCode('2026-09-13')).code, 'UNRESOLVED_EMPLOYEE')
  assert.equal((await completenessCode('2026-09-01', staffCookie, 'xidan')).status, 403)

  // Confirmed revisions are one atomic, versioned and reasoned authority command.
  const beforeRevision = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey: 'tongying', date: date('2026-09-01') } } })
  const beforeRevisionStaff = await prisma.dailyStoreStaff.findMany({ where: { storeId: 'tongying', date: date('2026-09-01') }, orderBy: { employeeId: 'asc' } })
  const revisionPayload = {
    storeKey: 'tongying', date: '2026-09-01', version: beforeRevision.version,
    manualSales: { incCents: 129000, ord: 18 },
    items: [staffItem('emp-gb-a', 8), staffItem('emp-gb-b', 7)],
    reason: 'Gate E verified historical correction',
  }
  const noReasonRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: { ...revisionPayload, reason: '' },
  })
  assert.equal(noReasonRevision.status, 400)
  const unauthorizedRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: staffCookie, method: 'POST', body: revisionPayload,
  })
  assert.equal(unauthorizedRevision.status, 403)
  assert.equal((await prisma.dailyEntry.findUnique({ where: { id: beforeRevision.id } })).version, beforeRevision.version)

  const authorizedRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: revisionPayload,
  })
  if (authorizedRevision.status !== 200) assert.fail(`authorized revision failed: ${authorizedRevision.status} ${await authorizedRevision.text()}`)
  const authorizedRevisionJson = await authorizedRevision.json()
  assert.equal(authorizedRevisionJson.entry.status, 'confirmed')
  assert.equal(authorizedRevisionJson.entry.version, beforeRevision.version + 1)
  assert.equal(authorizedRevisionJson.entry.incCents, '129000')
  assert.equal(authorizedRevisionJson.entry.confirmedAt, beforeRevision.confirmedAt.toISOString())
  assert.equal(authorizedRevisionJson.entry.confirmedBy, beforeRevision.confirmedBy)
  assert.equal(authorizedRevisionJson.staff.find((row) => row.employeeId === 'emp-gb-b').actualHours, 7)
  const revisionAudit = await prisma.dailyEntryAuditLog.findFirst({
    where: { storeId: 'tongying', date: date('2026-09-01'), module: 'daily_revision', reason: revisionPayload.reason },
    orderBy: { createdAt: 'desc' },
  })
  assert.equal(revisionAudit.reason, revisionPayload.reason)
  assert.equal(revisionAudit.operatorName, 'gate-b-dev')
  assert.equal(revisionAudit.beforeValue.entry.incCents, '128800')
  assert.equal(revisionAudit.afterValue.entry.incCents, '129000')
  assert.equal(revisionAudit.beforeValue.participants.find((row) => row.employeeId === 'emp-gb-b').actualHours, 6.5)
  assert.equal(revisionAudit.afterValue.participants.find((row) => row.employeeId === 'emp-gb-b').actualHours, 7)

  const revisionAuditCount = await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date('2026-09-01'), module: 'daily_revision' } })
  const staleRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: revisionPayload,
  })
  assert.equal(staleRevision.status, 409)
  const noOpRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: { ...revisionPayload, version: beforeRevision.version + 1 },
  })
  assert.equal(noOpRevision.status, 409)
  assert.equal(await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date('2026-09-01'), module: 'daily_revision' } }), revisionAuditCount)

  const concurrentRevisionVersion = beforeRevision.version + 1
  const concurrentRevisions = await Promise.all([
    request(base, '/v2/daily-entry/revise', {
      cookie: devCookie, method: 'POST', body: {
        ...revisionPayload, version: concurrentRevisionVersion, manualSales: { incCents: 129100, ord: 18 },
        items: [staffItem('emp-gb-a', 8), staffItem('emp-gb-b', 7.25)], reason: 'Concurrent revision A',
      },
    }),
    request(base, '/v2/daily-entry/revise', {
      cookie: devCookie, method: 'POST', body: {
        ...revisionPayload, version: concurrentRevisionVersion, manualSales: { incCents: 129200, ord: 18 },
        items: [staffItem('emp-gb-a', 8), staffItem('emp-gb-b', 7.5)], reason: 'Concurrent revision B',
      },
    }),
  ])
  assert.deepEqual(concurrentRevisions.map((response) => response.status).sort(), [200, 409])
  assert.equal((await prisma.dailyEntry.findUnique({ where: { id: beforeRevision.id } })).version, concurrentRevisionVersion + 1)

  // A final revision-audit failure rolls back entry and staff changes together.
  const failureSeed = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm('2026-09-16', 0, [staffItem('emp-gb-a', 8)], 160000, 16),
  })
  assert.equal(failureSeed.status, 200)
  await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".gate_e_fail_revision_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."date" = DATE '2026-09-16' AND NEW."module" = 'daily_revision' THEN RAISE EXCEPTION 'gate e private revision audit failure'; END IF;
      RETURN NEW;
    END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER gate_e_fail_revision_audit BEFORE INSERT ON "${schema}"."daily_entry_audit_logs" FOR EACH ROW EXECUTE FUNCTION "${schema}".gate_e_fail_revision_audit()`)
  const failureBefore = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey: 'tongying', date: date('2026-09-16') } } })
  const failureStaffBefore = await prisma.dailyStoreStaff.findFirst({ where: { storeId: 'tongying', date: date('2026-09-16'), employeeId: 'emp-gb-a' } })
  const revisionFailure = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: {
      storeKey: 'tongying', date: '2026-09-16', version: failureBefore.version,
      manualSales: { incCents: 161000, ord: 16 }, items: [staffItem('emp-gb-a', 7)], reason: 'Audit rollback fixture',
    },
  })
  assert.equal(revisionFailure.status, 500)
  assert.doesNotMatch((await revisionFailure.json()).error, /Prisma|SQL|gate e private|\/work\//)
  const failureAfter = await prisma.dailyEntry.findUnique({ where: { id: failureBefore.id } })
  const failureStaffAfter = await prisma.dailyStoreStaff.findUnique({ where: { id: failureStaffBefore.id } })
  assert.equal(failureAfter.incCents, failureBefore.incCents)
  assert.equal(failureAfter.version, failureBefore.version)
  assert.equal(failureStaffAfter.actualHours, failureStaffBefore.actualHours)
  assert.equal(await prisma.dailyEntryAuditLog.count({ where: { storeId: 'tongying', date: date('2026-09-16'), module: 'daily_revision' } }), 0)
  await prisma.$executeRawUnsafe(`DROP TRIGGER gate_e_fail_revision_audit ON "${schema}"."daily_entry_audit_logs"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION "${schema}".gate_e_fail_revision_audit()`)

  // Legacy write/unconfirm routes cannot bypass the formal confirmed revision command.
  const legacyStaffOverwrite = await request(base, '/v2/daily-staff', {
    cookie: devCookie, method: 'PUT', body: { storeKey: 'tongying', date: '2026-09-01', items: [staffItem('emp-gb-a', 1)], reason: 'legacy bypass' },
  })
  assert.equal(legacyStaffOverwrite.status, 409)
  const legacySalesOverwrite = await request(base, '/v2/daily-entries', {
    cookie: devCookie, method: 'PUT', body: { storeKey: 'tongying', date: '2026-09-01', incCents: 1, ord: 1, staffNames: [], version: beforeRevision.version + 1 },
  })
  assert.equal(legacySalesOverwrite.status, 409)
  const authorizedUnconfirm = await request(base, '/v2/daily-entry/unconfirm', {
    cookie: devCookie, method: 'POST', body: { storeKey: 'tongying', date: '2026-09-01', reason: 'legacy bypass' },
  })
  assert.equal(authorizedUnconfirm.status, 409)

  // Historical legacy payroll facts are fail-closed and unchanged by revision attempts.
  const legacyBefore = await prisma.dailyStoreStaff.findUnique({ where: { id: 'dss-gd-legacy' } })
  const legacyRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: {
      storeKey: 'tongying', date: '2026-09-13', version: 3,
      manualSales: { incCents: 44400, ord: 4 }, items: [staffItem('emp-gb-a', 7)], reason: 'attempt legacy overwrite',
    },
  })
  assert.equal(legacyRevision.status, 409)
  const legacyAfter = await prisma.dailyStoreStaff.findUnique({ where: { id: 'dss-gd-legacy' } })
  assert.deepEqual({
    participantType: legacyAfter.participantType,
    staffId: legacyAfter.staffId,
    actualHours: legacyAfter.actualHours,
    historicalPayrollHours: legacyAfter.historicalPayrollHours,
    payableHoursSource: legacyAfter.payableHoursSource,
  }, {
    participantType: legacyBefore.participantType,
    staffId: legacyBefore.staffId,
    actualHours: legacyBefore.actualHours,
    historicalPayrollHours: legacyBefore.historicalPayrollHours,
    payableHoursSource: legacyBefore.payableHoursSource,
  })
  assert.equal((await prisma.dailyStoreStaff.findMany({ where: { storeId: 'tongying', date: date('2026-09-01') }, orderBy: { employeeId: 'asc' } })).length, beforeRevisionStaff.length)

  // Gate F: Schedule is a prefill hint only. Confirmed actual attendance A+C is
  // the sole payroll authority even though the saved schedule contains A+B.
  const payrollDay = '2026-09-17'
  await prisma.schedule.create({ data: {
    id: 'sc-gate-f', weekStart: '2026-09-14', storeKey: 'tongying', date: payrollDay,
    shifts: [
      { employeeId: 'emp-gb-a', staff: '员工A', time: '10:00-18:00' },
      { employeeId: 'emp-gb-b', staff: '员工B', time: '13:00-21:00' },
    ],
  } })
  await prisma.payrollNotice.create({ data: {
    id: 'pn-gate-f-control', employeeId: 'emp-gb-a', periodType: 'custom', periodKey: '2026-08-01~2026-08-01',
    periodStart: date('2026-08-01'), periodEnd: date('2026-08-01'), employeeName: '员工A', storeKey: 'tongying',
    targetUsername: 'gate-b-staff', snapshot: { fixture: 'immutable-control' }, totalCents: 12345n, createdBy: 'gate-f',
  } })
  const stableRows = (rows) => JSON.stringify(rows, (_key, value) => {
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Date) return value.toISOString()
    return value
  })
  const historicalBefore = stableRows({
    entries: await prisma.dailyEntry.findMany({ where: { date: { lt: date(payrollDay) } }, orderBy: { id: 'asc' } }),
    staff: await prisma.dailyStoreStaff.findMany({ where: { date: { lt: date(payrollDay) } }, orderBy: { id: 'asc' } }),
    notices: await prisma.payrollNotice.findMany({ orderBy: { id: 'asc' } }),
  })

  const payrollConfirm = await request(base, '/v2/daily-entry/confirm', {
    cookie: devCookie, method: 'POST', body: manualConfirm(payrollDay, 0, [staffItem('emp-gb-a', 8), staffItem('emp-gb-c', 5)], 170000, 17),
  })
  assert.equal(payrollConfirm.status, 200, await payrollConfirm.text())
  const payrollBeforeRevision = await loadAuthoritativePayrollRange(prisma, {
    periodType: 'custom', periodStart: payrollDay, periodEnd: payrollDay,
  })
  const beforePayrollById = new Map(payrollBeforeRevision.result.payroll.employees.map((row) => [row.employeeId, row]))
  assert.deepEqual([...beforePayrollById.keys()].sort(), ['emp-gb-a', 'emp-gb-c'])
  assert.equal(beforePayrollById.has('emp-gb-b'), false)
  assert.equal(beforePayrollById.get('emp-gb-a').payableHours, 8)
  assert.equal(beforePayrollById.get('emp-gb-c').payableHours, 5)

  const payrollEntry = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey: 'tongying', date: date(payrollDay) } } })
  const payrollRevision = await request(base, '/v2/daily-entry/revise', {
    cookie: devCookie, method: 'POST', body: {
      storeKey: 'tongying', date: payrollDay, version: payrollEntry.version,
      manualSales: { incCents: 170000, ord: 17 },
      items: [staffItem('emp-gb-a', 6), staffItem('emp-gb-c', 5)],
      reason: 'Gate F actual hours correction 8 to 6',
    },
  })
  assert.equal(payrollRevision.status, 200, await payrollRevision.text())
  const payrollAfterRevision = await loadAuthoritativePayrollRange(prisma, {
    periodType: 'custom', periodStart: payrollDay, periodEnd: payrollDay,
  })
  const afterPayrollById = new Map(payrollAfterRevision.result.payroll.employees.map((row) => [row.employeeId, row]))
  assert.deepEqual([...afterPayrollById.keys()].sort(), ['emp-gb-a', 'emp-gb-c'])
  assert.equal(afterPayrollById.get('emp-gb-a').payableHours, 6)
  assert.equal(afterPayrollById.get('emp-gb-c').payableHours, 5)
  assert.notEqual(afterPayrollById.get('emp-gb-a').salary, beforePayrollById.get('emp-gb-a').salary)
  const payrollRevisionAudit = await prisma.dailyEntryAuditLog.findFirst({
    where: { storeId: 'tongying', date: date(payrollDay), module: 'daily_revision', reason: 'Gate F actual hours correction 8 to 6' },
  })
  assert.ok(payrollRevisionAudit)
  assert.equal(payrollRevisionAudit.beforeValue.participants.find((row) => row.employeeId === 'emp-gb-a').actualHours, 8)
  assert.equal(payrollRevisionAudit.afterValue.participants.find((row) => row.employeeId === 'emp-gb-a').actualHours, 6)
  assert.equal((await prisma.schedule.findUnique({ where: { id: 'sc-gate-f' } })).shifts[1].employeeId, 'emp-gb-b')

  const historicalAfter = stableRows({
    entries: await prisma.dailyEntry.findMany({ where: { date: { lt: date(payrollDay) } }, orderBy: { id: 'asc' } }),
    staff: await prisma.dailyStoreStaff.findMany({ where: { date: { lt: date(payrollDay) } }, orderBy: { id: 'asc' } }),
    notices: await prisma.payrollNotice.findMany({ orderBy: { id: 'asc' } }),
  })
  assert.equal(historicalAfter, historicalBefore)

  console.log('DAILY ENTRY V2 GATE B-F API TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect().catch(() => {})
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await admin.$disconnect().catch(() => {})
}
