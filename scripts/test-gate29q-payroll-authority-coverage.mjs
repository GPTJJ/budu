import assert from 'node:assert/strict'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'

const MONTH = '2026-08'
const entryKey = (store, date) => `${date.slice(0, 7)}|${store}|${date.slice(5)}`
const entry = (store, date, inc = 6000, ord = 60) => ({
  [entryKey(store, date)]: { inc, ord, staff: [], status: 'confirmed' },
})
const attendance = ({ id, date = '2026-08-20', employeeId = null, name = '员工A', participantType = 'EMPLOYEE', userId = null, store = 'chaowai', hours = 8 }) => ({
  id,
  storeId: store,
  storeKey: store,
  date,
  employeeId,
  participantType,
  participantUserId: userId,
  staffId: employeeId ? `employee:${employeeId}` : (userId ? `user:${userId}` : `legacy:${id}`),
  staffNameSnapshot: name,
  actualHours: hours,
})
const stable = (id = 'a', employeeId = 'emp-A', name = '员工A', date = '2026-08-20', hours = 8) => attendance({ id, employeeId, name, date, hours })
const compatible = (id = 'l', name = '历史员工', date = '2026-08-20') => attendance({ id, name, date, participantType: 'LEGACY_EMPLOYEE_COMPATIBLE' })
const substitute = (id = 's', date = '2026-08-20') => attendance({ id, name: '运营替代', date, participantType: 'NON_EMPLOYEE_SUBSTITUTE', userId: `user-${id}` })
const unknown = (id = 'u', date = '2026-08-20') => attendance({ id, name: '未知人员', date, participantType: 'LEGACY_UNKNOWN' })
const employees = [{ id: 'emp-A', name: '员工A' }, { id: 'emp-B', name: '员工B' }]
const users = [{ employeeId: 'emp-A', status: 'active' }, { employeeId: 'emp-B', status: 'active' }]

// Legacy attendance alone remains available for compatibility, never issuable,
// and never invents Employee.id.
{
  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20'),
    dailyStoreStaffRows: [compatible()],
    employees: [{ id: 'legacy-directory', name: '历史员工' }],
    users: [],
  })
  assert.equal(result.mode, 'LEGACY')
  assert.equal(result.attendanceMode, 'LEGACY_COMPATIBLE')
  assert.equal(result.issueReady, false)
  assert.equal(result.payroll.employees.length, 1)
  assert.equal(result.payroll.employees[0].employeeId, undefined)
  assert.deepEqual(result.payroll.attendanceCoverage, { expected: 1, represented: 1, missing: [] })
}

// Stable attendance + adjustment stays Employee.id and applies the final-pay override.
{
  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20'),
    dailyStoreStaffRows: [stable()],
    dailyPayAdjustments: [{ employeeId: 'emp-A', date: '2026-08-20', adjustedPayCents: 28000 }],
    employees,
    users,
  })
  assert.equal(result.attendanceMode, 'EMPLOYEE_ID')
  assert.equal(result.calculationReady, true)
  assert.equal(result.payroll.employees[0].salary, 280)
  assert.equal(result.payroll.attendanceCoverage.missing.length, 0)
}

// Stable attendance + stable manual bonus includes the bonus once even when
// the manual bonus date is not an attendance day.
{
  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20'),
    dailyStoreStaffRows: [stable()],
    bigOrderBonuses: [{ employeeId: 'emp-A', date: '2026-08-21', amountCents: 120900, bonusCents: 6045 }],
    employees,
    users,
  })
  assert.equal(result.calculationReady, true)
  assert.equal(result.payroll.employees[0].bigBonus, 60.45)
  const bonusDay = result.payroll.employees[0].dailyExplanations.find((row) => row.date === '2026-08-21')
  assert.equal(bonusDay.explanation.state, 'BIG_BONUS_CONTRIBUTION_ONLY')
  assert.equal(bonusDay.explanation.bigOrderBonuses.length, 1)
}

// Adjustment-only is the explicit no-attendance exception; bonus-only is not.
{
  const adjustmentOnly = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: {},
    dailyStoreStaffRows: [],
    dailyPayAdjustments: [{ employeeId: 'emp-A', date: '2026-08-20', adjustedPayCents: 28000 }],
    employees,
    users,
  })
  assert.equal(adjustmentOnly.mode, 'EMPLOYEE_ID')
  assert.equal(adjustmentOnly.attendanceMode, 'ADJUSTMENT_ONLY')
  assert.equal(adjustmentOnly.calculationReady, true)
  assert.equal(adjustmentOnly.payroll.employees[0].salary, 280)
  assert.equal(adjustmentOnly.payroll.employees[0].days, 0)
  assert.equal(adjustmentOnly.payroll.employees[0].dailyExplanations[0].automaticPay, 0)

  const bonusOnly = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: {},
    dailyStoreStaffRows: [],
    bigOrderBonuses: [{ employeeId: 'emp-A', date: '2026-08-20', bonusCents: 6045 }],
    employees,
    users,
  })
  assert.equal(bonusOnly.attendanceMode, 'BONUS_ONLY')
  assert.equal(bonusOnly.calculationReady, false)
  assert.equal(bonusOnly.payroll.employees.length, 0)
}

// Substitute affects participantCount but never creates a salary subject.
{
  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20', 2050, 10),
    dailyStoreStaffRows: [stable(), substitute()],
    employees,
    users,
  })
  assert.equal(result.calculationReady, true)
  assert.equal(result.payroll.employees.length, 1)
  assert.equal(result.payroll.employees[0].dailyExplanations[0].explanation.participantCount, 2)
}

// Unknown and mixed attendance both fail closed with no partial positive payroll.
{
  const unknownResult = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20'),
    dailyStoreStaffRows: [unknown()],
    employees: [],
    users: [],
  })
  assert.equal(unknownResult.attendanceMode, 'LEGACY_UNKNOWN')
  assert.equal(unknownResult.calculationReady, false)
  assert.equal(unknownResult.issueReady, false)
  assert.equal(unknownResult.payroll.employees.length, 0)
  assert.ok(unknownResult.blockers.some((row) => row.reason === 'LEGACY_UNKNOWN_PARTICIPANT'))

  const mixed = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20'),
    dailyStoreStaffRows: [stable(), compatible()],
    employees: [...employees, { id: 'legacy-directory', name: '历史员工' }],
    users,
  })
  assert.equal(mixed.attendanceMode, 'MIXED_ATTENDANCE_AUTHORITY')
  assert.equal(mixed.calculationReady, false)
  assert.equal(mixed.issueReady, false)
  assert.equal(mixed.payroll.employees.length, 0)
  assert.ok(mixed.blockers.some((row) => row.reason === 'MIXED_ATTENDANCE_AUTHORITY'))
}

// Stable contribution cannot select Employee.id mode for legacy-compatible attendance.
{
  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-20'),
    dailyStoreStaffRows: [compatible()],
    dailyPayAdjustments: [{ employeeId: 'emp-A', date: '2026-08-20', adjustedPayCents: 28000 }],
    bigOrderBonuses: [{ employeeId: 'emp-B', date: '2026-08-20', bonusCents: 6045 }],
    employees: [...employees, { id: 'legacy-directory', name: '历史员工' }],
    users,
  })
  assert.equal(result.mode, 'LEGACY')
  assert.equal(result.attendanceMode, 'LEGACY_COMPATIBLE')
  assert.equal(result.calculationReady, false)
  assert.equal(result.issueReady, false)
  assert.equal(result.payroll.employees.length, 1)
  assert.ok(result.blockers.some((row) => row.reason === 'STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE'))
}

// Exact Gate29P authority-shape reproduction: 64 compatible + 6 substitutes,
// 2 stable adjustments and 1 stable bonus. The 9 attendance subjects remain
// visible; the period is blocked instead of returning only the ¥280 adjustment.
{
  const dailyEntries = {}
  const rows = []
  const names = Array.from({ length: 9 }, (_, index) => `历史员工${index + 1}`)
  let rowIndex = 0
  for (let day = 1; day <= 7; day += 1) {
    const date = `2026-08-${String(day).padStart(2, '0')}`
    Object.assign(dailyEntries, entry('chaowai', date, 3000 + day * 100, 20 + day))
    for (const name of names) rows.push(compatible(`legacy-${rowIndex++}`, name, date))
    if (day <= 6) rows.push(substitute(`sub-${day}`, date))
  }
  const date = '2026-08-08'
  Object.assign(dailyEntries, entry('chaowai', date, 4000, 30))
  rows.push(compatible(`legacy-${rowIndex++}`, names[0], date))
  assert.equal(rows.filter((row) => row.participantType === 'LEGACY_EMPLOYEE_COMPATIBLE').length, 64)
  assert.equal(rows.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').length, 6)

  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries,
    dailyStoreStaffRows: rows,
    dailyPayAdjustments: [
      { employeeId: 'emp-A', date: '2026-08-20', adjustedPayCents: 28000 },
      { employeeId: 'emp-A', date: '2026-08-21', adjustedPayCents: 28000 },
    ],
    bigOrderBonuses: [{ employeeId: 'emp-B', date: '2026-08-20', bonusCents: 6045 }],
    employees: names.map((name, index) => ({ id: `legacy-directory-${index}`, name })),
    users,
  })
  assert.equal(result.attendanceMode, 'LEGACY_COMPATIBLE')
  assert.equal(result.calculationReady, false)
  assert.equal(result.issueReady, false)
  assert.equal(result.payroll.employees.length, 9)
  assert.equal(result.payroll.attendanceCoverage.expected, 64)
  assert.equal(result.payroll.attendanceCoverage.represented, 64)
  assert.ok(result.blockers.some((row) => row.reason === 'STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE'))
  assert.notEqual(result.payroll.employees.reduce((sum, row) => sum + row.salary, 0), 280)
}

// Accepted 8/24 correction remains authoritative: 11.5h and +¥345 are retained.
{
  const result = resolvePayrollCalculation({
    month: MONTH,
    dailyEntries: entry('chaowai', '2026-08-24', 0, 0),
    dailyStoreStaffRows: [stable('m-jingxin', 'emp-M', '马婧欣', '2026-08-24', 11.5)],
    employees: [{ id: 'emp-M', name: '马婧欣' }],
    users: [{ employeeId: 'emp-M', status: 'active' }],
  })
  assert.equal(result.calculationReady, true)
  assert.equal(result.payroll.employees[0].actualHours, 11.5)
  assert.equal(result.payroll.employees[0].salary, 345)
}

console.log('GATE 29Q PAYROLL AUTHORITY COVERAGE TEST OK')
