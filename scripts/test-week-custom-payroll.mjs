import assert from 'node:assert/strict'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'
import { resolvePayrollPeriod } from '../src/utils/payrollPeriod.js'
import { getDailyStoreStaffRangeState, resetUserData, seedCachedDataForTest } from '../src/utils/userData.js'

const entries = {}
const staff = []
const addDay = ({ date, employeeId, name, hours, source = 'ACTUAL_HOURS', revenue = 2050, store = 'tongying', substitute = false }) => {
  const key = `${date.slice(0, 7)}|${store}|${date.slice(5)}`
  const current = entries[key] || { inc: revenue, ord: 10, staff: [], status: 'confirmed' }
  current.staff.push(name)
  entries[key] = current
  staff.push({
    id: `${store}-${date}-${employeeId || 'sub'}`,
    storeId: store,
    storeKey: store,
    date,
    employeeId: substitute ? null : employeeId,
    participantType: substitute ? 'NON_EMPLOYEE_SUBSTITUTE' : 'EMPLOYEE',
    participantUserId: substitute ? employeeId : null,
    staffId: `staff-${employeeId}`,
    staffNameSnapshot: name,
    actualHours: source === 'ACTUAL_HOURS' ? hours : null,
    historicalPayrollHours: source === 'LEGACY_PAYROLL_HOURS' ? hours : null,
    payableHoursSource: source,
    attendanceStatus: source === 'LEGACY_PAYROLL_HOURS' ? 'HISTORICAL_UNOBSERVED' : 'normal',
  })
}

addDay({ date: '2026-08-04', employeeId: 'emp-A', name: '甲', hours: 8, source: 'LEGACY_PAYROLL_HOURS' })
addDay({ date: '2026-08-21', employeeId: 'emp-A', name: '甲', hours: 8 })
addDay({ date: '2026-08-24', employeeId: 'emp-A', name: '甲', hours: 8, revenue: 3000 })
addDay({ date: '2026-08-24', employeeId: 'user-S', name: '替班', hours: 8, revenue: 3000, substitute: true })
addDay({ date: '2026-08-27', employeeId: 'emp-B', name: '乙', hours: 6 })
addDay({ date: '2026-08-28', employeeId: 'emp-A', name: '甲', hours: 8 })
addDay({ date: '2026-09-03', employeeId: 'emp-A', name: '甲', hours: 8 })

const adjustments = [
  { id: 'adj-A', employeeId: 'emp-A', staffName: '甲', date: '2026-08-25', autoPayCentsSnapshot: 0, adjustedPayCents: 50000, reason: '范围内调整' },
  { id: 'adj-out', employeeId: 'emp-A', staffName: '甲', date: '2026-09-04', autoPayCentsSnapshot: 0, adjustedPayCents: 90000, reason: '范围外调整' },
]
const bonuses = [
  { id: 'bonus-A', employeeId: 'emp-A', staffName: '甲', date: '2026-08-04', amountCents: 120900, bonusCents: 6045 },
  { id: 'bonus-only', employeeId: 'emp-C', staffName: '丙', date: '2026-08-24', amountCents: 100000, bonusCents: 5000 },
]
const employees = [
  { id: 'emp-A', name: '甲', employeeNo: 'A001', type: 'fulltime', storeKey: 'tongying' },
  { id: 'emp-B', name: '乙', employeeNo: 'B001', type: 'parttime', storeKey: 'tongying' },
  { id: 'emp-C', name: '丙', employeeNo: 'C001', type: 'parttime', storeKey: 'tongying' },
]
const users = [
  { id: 'u-A', username: 'a', employeeId: 'emp-A', status: 'active' },
  { id: 'u-B', username: 'b', employeeId: 'emp-B', status: 'active' },
  { id: 'u-C', username: 'c', employeeId: 'emp-C', status: 'active' },
]

const resolve = (period) => resolvePayrollCalculation({
  ...period,
  dailyEntries: entries,
  dailyStoreStaffRows: staff,
  dailyPayAdjustments: adjustments,
  bigOrderBonuses: bonuses,
  employees,
  users,
  storeNames: { tongying: '通盈店' },
})

// Period model and timezone stability.
assert.deepEqual(
  resolvePayrollPeriod({ periodType: 'month', periodKey: '2026-08' }),
  resolvePayrollPeriod({ month: '2026-08' }),
)
const weekPeriod = resolvePayrollPeriod({ periodType: 'week', periodKey: '2026-08-24' })
assert.equal(weekPeriod.periodStart, '2026-08-24')
assert.equal(weekPeriod.periodEnd, '2026-08-30')
assert.deepEqual(weekPeriod.months, ['2026-08'])
assert.equal(resolvePayrollPeriod({ periodType: 'week', periodKey: '2026-08-25' }).reason, 'INVALID_WEEK_START')
assert.equal(resolvePayrollPeriod({ periodType: 'custom', periodStart: '2026-08-27', periodEnd: '2026-08-21' }).reason, 'INVALID_PERIOD_ORDER')
assert.equal(resolvePayrollPeriod({ periodType: 'custom', periodStart: '2026-02-30', periodEnd: '2026-03-01' }).valid, false)
for (const timezone of ['Asia/Shanghai', 'UTC', 'America/Los_Angeles']) {
  process.env.TZ = timezone
  const period = resolvePayrollPeriod({ periodType: 'custom', periodStart: '2026-08-28', periodEnd: '2026-09-03' })
  assert.deepEqual([period.periodStart, period.periodEnd, period.months], ['2026-08-28', '2026-09-03', ['2026-08', '2026-09']])
}
console.log('  [Period] MONTH/WEEK/CUSTOM + timezone/date validation PASS')

// MONTH regression: old month contract and new generic range are byte-equivalent for payroll membership/amounts/days.
const oldMonth = resolve({ month: '2026-08' })
const newMonth = resolve({ periodType: 'month', periodKey: '2026-08', periodStart: '2026-08-01', periodEnd: '2026-08-31' })
assert.equal(oldMonth.mode, 'EMPLOYEE_ID')
assert.equal(newMonth.calculationReady, true)
assert.deepEqual(newMonth.payroll.employees, oldMonth.payroll.employees)
assert.equal(newMonth.payroll.employees.some((row) => row.employeeId === 'emp-C'), false, 'bonus-only 不建主体')
console.log('  [MONTH] subject/amount/day difference = 0 PASS')

// WEEK: exact Monday-Sunday membership, substitute denominator, adjustment date, bonus-only isolation.
const week = resolve({ periodType: 'week', periodKey: '2026-08-24' })
assert.equal(week.calculationReady, true)
assert.deepEqual(new Set(week.payroll.employees.map((row) => row.employeeId)), new Set(['emp-A', 'emp-B']))
const weekA = week.payroll.employees.find((row) => row.employeeId === 'emp-A')
const weekB = week.payroll.employees.find((row) => row.employeeId === 'emp-B')
assert.deepEqual(weekA.dailyExplanations.map((row) => row.date), ['2026-08-24', '2026-08-25', '2026-08-28'])
assert.deepEqual(weekB.dailyExplanations.map((row) => row.date), ['2026-08-27'])
assert.equal(weekA.dailyExplanations.find((row) => row.date === '2026-08-24').explanation.participantCount, 2)
assert.equal(weekA.dailyExplanations.find((row) => row.date === '2026-08-25').explanation.state, 'ADJUSTMENT_ONLY')
assert.equal(weekA.bigBonus, 0, '8/4 bonus 排除')
console.log('  [WEEK] exact days + substitute denominator + adjustment/bonus range PASS')

// CUSTOM 8/21-8/27.
const custom = resolve({ periodType: 'custom', periodStart: '2026-08-21', periodEnd: '2026-08-27' })
assert.equal(custom.calculationReady, true)
assert.deepEqual(custom.payroll.employees.find((row) => row.employeeId === 'emp-A').dailyExplanations.map((row) => row.date), ['2026-08-21', '2026-08-24', '2026-08-25'])
assert.equal(custom.payroll.employees.find((row) => row.employeeId === 'emp-A').bigBonus, 0)
assert.equal(custom.payroll.employees.some((row) => row.employeeId === 'emp-C'), false)
console.log('  [CUSTOM 8/21-8/27] exact membership/subjects/amount PASS')

// One-day and cross-month ranges.
const oneDay = resolve({ periodType: 'custom', periodStart: '2026-08-27', periodEnd: '2026-08-27' })
assert.deepEqual(oneDay.payroll.employees.map((row) => row.employeeId), ['emp-B'])
assert.deepEqual(oneDay.payroll.employees[0].dailyExplanations.map((row) => row.date), ['2026-08-27'])
const crossMonth = resolve({ periodType: 'custom', periodStart: '2026-08-28', periodEnd: '2026-09-03' })
assert.deepEqual(crossMonth.months, ['2026-08', '2026-09'])
assert.deepEqual(crossMonth.payroll.employees.map((row) => row.employeeId), ['emp-A'])
assert.deepEqual(crossMonth.payroll.employees[0].dailyExplanations.map((row) => row.date), ['2026-08-28', '2026-09-03'])
console.log('  [CUSTOM one-day/cross-month] PASS')

// Historical payable hours use the same stable Employee.id resolver and never become attendance facts.
const historical = resolve({ periodType: 'custom', periodStart: '2026-08-01', periodEnd: '2026-08-10' })
const historicalA = historical.payroll.employees.find((row) => row.employeeId === 'emp-A')
assert.equal(historicalA.payableHours, 8)
assert.equal(historicalA.bigBonus, 60.45)
assert.equal(historicalA.dailyExplanations[0].payableHoursSource, 'LEGACY_PAYROLL_HOURS')
assert.equal(historicalA.dailyExplanations[0].explanation.payableHoursSource, 'LEGACY_PAYROLL_HOURS')
console.log('  [Historical] LEGACY_PAYROLL_HOURS in CUSTOM PASS')

// Resolver algebra: daily explanations reconcile to every range total; non-overlapping August partition reconciles to month.
for (const result of [week, custom, oneDay, crossMonth, historical]) {
  for (const record of result.payroll.employees) {
    const dailyTotal = Math.round(record.dailyExplanations.reduce((sum, day) => sum + day.finalPay, 0) * 100) / 100
    assert.equal(dailyTotal, record.salary)
  }
}
const firstHalf = resolve({ periodType: 'custom', periodStart: '2026-08-01', periodEnd: '2026-08-20' })
const secondHalf = resolve({ periodType: 'custom', periodStart: '2026-08-21', periodEnd: '2026-08-31' })
for (const employeeId of ['emp-A', 'emp-B']) {
  const amount = (result) => result.payroll.employees.find((row) => row.employeeId === employeeId)?.salary || 0
  assert.equal(Math.round((amount(firstHalf) + amount(secondHalf)) * 100), Math.round(amount(newMonth) * 100))
}
console.log('  [Algebra] daily=sum period; partition=sum month PASS')

// Cross-month cache completeness: both payload markers are required and account/reset isolation fails closed.
seedCachedDataForTest({ dailyStoreStaffByMonth: { '2026-08': staff.filter((row) => row.date.startsWith('2026-08')), '2026-09': staff.filter((row) => row.date.startsWith('2026-09')) } })
const complete = getDailyStoreStaffRangeState('2026-08-28', '2026-09-03')
assert.equal(complete.complete, true)
assert.deepEqual(complete.months, ['2026-08', '2026-09'])
assert.equal(complete.rows.length, staff.length, 'cache merges complete month payloads; resolver performs exact range filter')
resetUserData()
assert.equal(getDailyStoreStaffRangeState('2026-08-28', '2026-09-03').complete, false)
console.log('  [Cache] cross-month completeness + account generation isolation PASS')

console.log('WEEK / CUSTOM AUTHORITATIVE PAYROLL RANGE TEST OK')
