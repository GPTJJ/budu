import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyDailyStaffTargets } from '../server/payroll-participant-authority.js'
import { buildEmployeePayrollDayInputs } from '../src/utils/payrollShadowInput.js'
import { calculateEmployeeIdShadowPayroll } from '../src/utils/payrollShadowCalculator.js'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const confirmed = { '2026-08|tongying|08-20': { inc: 2050, ord: 10, staff: ['员工A', '运营替代'], status: 'confirmed' } }
const employee = {
  id: 'dss-employee-a', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-20',
  employeeId: 'emp-A', participantType: 'EMPLOYEE', participantUserId: null,
  staffId: 'employee:emp-A', staffNameSnapshot: '员工A', actualHours: 8,
}
const substitute = {
  id: 'dss-substitute', storeId: 'tongying', storeKey: 'tongying', date: '2026-08-20',
  employeeId: null, participantType: 'NON_EMPLOYEE_SUBSTITUTE', participantUserId: 'user-sub',
  staffId: 'user:user-sub', staffNameSnapshot: '运营替代', actualHours: 8,
}

// Write authority: stable target IDs only; snapshots and types are server-derived.
{
  const rows = classifyDailyStaffTargets([
    { employeeId: 'emp-A', actualHours: 8 },
    { participantUserId: 'user-sub', actualHours: 8 },
  ], [{ id: 'emp-A', name: '员工A', status: 'ACTIVE' }], [{
    id: 'user-sub', username: 'sub', displayName: '运营替代', status: 'active',
    operationalIdentityType: 'NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE', storeKeys: ['tongying'],
  }], { storeKey: 'tongying' })
  assert.deepEqual(rows.map((row) => row.participantType), ['EMPLOYEE', 'NON_EMPLOYEE_SUBSTITUTE'])
  assert.equal(rows[0].staffName, '员工A')
  assert.equal(rows[1].staffName, '运营替代')
  assert.throws(() => classifyDailyStaffTargets([{ employeeId: 'emp-A', participantType: 'EMPLOYEE' }], [], []), /客户端不可指定/)
  assert.throws(() => classifyDailyStaffTargets([{ participantUserId: 'standard-user' }], [], [{
    id: 'standard-user', status: 'active', operationalIdentityType: 'STANDARD', storeKeys: ['tongying'],
  }], { storeKey: 'tongying' }), /运营替代账号无效/)
}

// Required exact fixture: employee + operational substitute.
{
  const input = buildEmployeePayrollDayInputs(confirmed, [employee, substitute])
  assert.equal(input.stableRows.length, 1)
  assert.equal(input.substituteRows.length, 1)
  assert.equal(input.stableRows[0].participantCount, 2)
  const payroll = calculateEmployeeIdShadowPayroll(confirmed, [employee, substitute])
  assert.equal(payroll.employees.length, 1)
  const rec = payroll.employees[0]
  const day = rec.dailyExplanations[0]
  assert.equal(rec.employeeId, 'emp-A')
  assert.equal(day.explanation.participantCount, 2)
  assert.equal(day.baseRate, 28)
  assert.equal(day.basePay, 224)
  assert.equal(day.explanation.commissionBasis, 2050)
  assert.equal(day.commissionRate, 5)
  assert.equal(day.commission, 40)
  assert.equal(day.finalPay, 264)
  assert.equal(day.explanation.displayWorkedRevenue, 1025)
  const resolved = resolvePayrollCalculation({
    month: '2026-08', dailyEntries: confirmed, dailyStoreStaffRows: [employee, substitute],
    employees: [{ id: 'emp-A', name: '员工A' }], users: [{ employeeId: 'emp-A', status: 'active' }],
  })
  assert.equal(resolved.mode, 'EMPLOYEE_ID')
  assert.equal(resolved.payroll.employees.length, 1)
}

// Two employees + substitute: denominator is three; substitute never gets a row.
{
  const employeeB = { ...employee, id: 'dss-employee-b', employeeId: 'emp-B', staffId: 'employee:emp-B', staffNameSnapshot: '员工B', actualHours: 6 }
  const result = calculateEmployeeIdShadowPayroll(confirmed, [employee, employeeB, substitute])
  assert.deepEqual(result.employees.map((row) => row.employeeId).sort(), ['emp-A', 'emp-B'])
  assert.ok(result.employees.every((row) => row.dailyExplanations[0].explanation.participantCount === 3))
  assert.ok(result.employees.every((row) => row.dailyExplanations[0].explanation.commissionBasis === 2050))
}

// Draft is excluded, unknown fails closed, reviewed compatible is name-only and non-issuable.
{
  const draft = { '2026-08|tongying|08-20': { ...confirmed['2026-08|tongying|08-20'], status: 'draft' } }
  const draftInput = buildEmployeePayrollDayInputs(draft, [employee, substitute])
  assert.equal(draftInput.stableRows.length, 0)
  assert.equal(draftInput.substituteRows.length, 0)
  assert.equal(draftInput.excludedDraftDays.length, 1)
  assert.equal(calculateEmployeeIdShadowPayroll(draft, [employee, substitute]).employees.length, 0)

  const unknown = { ...substitute, participantType: 'LEGACY_UNKNOWN', participantUserId: null }
  const unknownResolved = resolvePayrollCalculation({ month: '2026-08', dailyEntries: confirmed, dailyStoreStaffRows: [unknown], employees: [], users: [] })
  assert.equal(unknownResolved.issueReady, false)
  assert.equal(unknownResolved.payroll.employees.length, 0)
  assert.ok(unknownResolved.blockers.some((row) => row.reason === 'LEGACY_UNKNOWN_PARTICIPANT'))

  const compatible = { ...unknown, participantType: 'LEGACY_EMPLOYEE_COMPATIBLE', staffNameSnapshot: '历史员工' }
  const compatibleResolved = resolvePayrollCalculation({
    month: '2026-08', dailyEntries: confirmed, dailyStoreStaffRows: [compatible],
    employees: [{ id: 'legacy-directory-only', name: '历史员工' }], users: [],
  })
  assert.equal(compatibleResolved.mode, 'LEGACY')
  assert.equal(compatibleResolved.issueReady, false)
  assert.equal(compatibleResolved.payroll.employees.length, 1)
  assert.equal(compatibleResolved.payroll.employees[0].employeeId, undefined)

  const duplicateResolved = resolvePayrollCalculation({
    month: '2026-08', dailyEntries: confirmed, dailyStoreStaffRows: [compatible],
    employees: [{ id: 'dup-1', name: '历史员工' }, { id: 'dup-2', name: '历史员工' }], users: [],
  })
  assert.equal(duplicateResolved.payroll.employees.length, 0)
  assert.ok(duplicateResolved.blockers.some((row) => row.reason === 'LEGACY_DUPLICATE_IDENTITY'))
}

// Runtime must not encode a person/name/known remediation row as salary policy.
{
  const files = [
    'shared/payrollParticipantAuthority.js',
    'server/payroll-participant-authority.js',
    'server/daily-entry-upgrade.js',
    'src/utils/payrollShadowInput.js',
    'src/utils/payrollReadiness.js',
    'src/utils/payrollResolver.js',
    'src/utils/payrollShadowCalculator.js',
  ]
  const runtime = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
  for (const dangerous of ['NO_PAY_STAFF', '卡皮巴拉', 'dss-768a1dc8-be8d-411f-896e-c29d13246210']) {
    assert.equal(runtime.includes(dangerous), false, `runtime magic value: ${dangerous}`)
  }
}

console.log('GATE 29N PAYROLL PARTICIPANT AUTHORITY TEST OK')
