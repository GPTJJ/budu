import assert from 'node:assert/strict'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'
import { stablePayrollJson } from '../server/payroll-authority.js'

const employee = (id, name, type = 'fulltime') => ({ id, name, type, status: 'ACTIVE' })
const user = (employeeId) => ({ username: `user-${employeeId}`, employeeId, status: 'active' })
const entry = (store, date, inc, ord, status = 'confirmed') => ({
  [`${date.slice(0, 7)}|${store}|${date.slice(5)}`]: { inc, ord, staff: [], status },
})
const attendance = ({ id, employeeId, name, store, date, hours, overrides = {} }) => ({
  id, employeeId, participantType: 'EMPLOYEE', participantUserId: null,
  storeId: store, storeKey: store, date, staffId: `employee:${employeeId}`,
  staffNameSnapshot: name, actualHours: hours, historicalPayrollHours: null,
  payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal', scheduledHours: 0,
  ...overrides,
})

const employees = [
  employee('emp-full', '同名员工', 'fulltime'),
  employee('emp-part', '同名员工', 'parttime'),
  employee('emp-relief', '临时顶班', 'parttime'),
]
const users = employees.map((row) => user(row.id))
const dailyEntries = {
  ...entry('tongying', '2026-09-01', 2050, 20),
  ...entry('guanshe', '2026-09-02', 0, 0),
  ...entry('tongying', '2026-09-03', 4000, 30),
}
const dailyStoreStaffRows = [
  attendance({ id: 'a-1', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-01', hours: 8 }),
  attendance({ id: 'b-1', employeeId: 'emp-part', name: '同名员工', store: 'tongying', date: '2026-09-01', hours: 6 }),
  attendance({ id: 'a-2', employeeId: 'emp-full', name: '同名员工', store: 'guanshe', date: '2026-09-02', hours: 7 }),
  // Schedule noise says A+B; persisted actual attendance is A+C and only A+C may enter payroll.
  attendance({ id: 'a-3', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-03', hours: 8 }),
  attendance({ id: 'c-3', employeeId: 'emp-relief', name: '临时顶班', store: 'tongying', date: '2026-09-03', hours: 5 }),
]
const fixedInput = {
  month: '2026-09', dailyEntries, dailyStoreStaffRows, employees, users,
  dailyPayAdjustments: [], bigOrderBonuses: [], storeNames: { tongying: '北京通盈中心店', guanshe: '北京官舍店' },
}

// Same persisted facts must produce byte-identical payroll even when Daily Entry V2
// adds non-authoritative Schedule/UI draft metadata around the resolver call.
const before = resolvePayrollCalculation(fixedInput)
const after = resolvePayrollCalculation({
  ...fixedInput,
  schedules: { '2026-09-03': ['emp-full', 'emp-part'] },
  uiDraft: { selected: ['emp-full', 'emp-part'], actualHours: { 'emp-full': 99 } },
})
assert.equal(stablePayrollJson(after), stablePayrollJson(before))
assert.equal(before.mode, 'EMPLOYEE_ID')
assert.equal(before.calculationReady, true)
assert.deepEqual(before.payroll.employees.map((row) => row.employeeId).sort(), ['emp-full', 'emp-part', 'emp-relief'])
assert.equal(before.payroll.employees.find((row) => row.employeeId === 'emp-full').payableHours, 23)
assert.equal(before.payroll.employees.find((row) => row.employeeId === 'emp-part').payableHours, 6)
assert.equal(before.payroll.employees.find((row) => row.employeeId === 'emp-relief').payableHours, 5)

// Missing actualHours is never replaced by Schedule/dutyHours and fails closed.
assert.throws(() => resolvePayrollCalculation({
  month: '2026-09',
  dailyEntries: entry('tongying', '2026-09-10', 2000, 20),
  dailyStoreStaffRows: [attendance({ id: 'missing-hours', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-10', hours: null })],
  employees, users,
}), /actualHours/)

// Draft days never become payroll facts.
const draft = resolvePayrollCalculation({
  month: '2026-09',
  dailyEntries: entry('tongying', '2026-09-11', 9000, 90, 'draft'),
  dailyStoreStaffRows: [attendance({ id: 'draft', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-11', hours: 12 })],
  employees, users,
})
assert.equal(draft.calculationReady, false)
assert.equal(draft.payroll.employees.length, 0)

// A saved attendance row without DailyEntry is explicit incomplete input, never guessed income/pay.
const missingEntry = resolvePayrollCalculation({
  month: '2026-09', dailyEntries: {},
  dailyStoreStaffRows: [attendance({ id: 'missing-entry', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-12', hours: 8 })],
  employees, users,
})
assert.equal(missingEntry.calculationReady, false)
assert.ok(missingEntry.blockers.some((row) => row.reason === 'MISSING_DAILY_ENTRY'))

// Reviewed legacy payable hours stay read-only compatible input, never actualHours.
const legacy = resolvePayrollCalculation({
  month: '2026-09',
  dailyEntries: entry('chaowai', '2026-09-13', 0, 0),
  dailyStoreStaffRows: [{
    id: 'legacy', employeeId: null, participantType: 'LEGACY_EMPLOYEE_COMPATIBLE', participantUserId: null,
    storeId: 'chaowai', storeKey: 'chaowai', date: '2026-09-13', staffId: 'legacy:历史员工',
    staffNameSnapshot: '历史员工', actualHours: null, historicalPayrollHours: 11.5,
    payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED',
  }],
  employees: [employee('legacy-directory', '历史员工')], users: [],
})
assert.equal(legacy.attendanceMode, 'LEGACY_COMPATIBLE')
assert.equal(legacy.payroll.employees[0].hours, 11.5)

// A legitimate revised actualHours fact changes current payroll from 8 to 6;
// immutable audit input remains 8 -> 6 and is not consumed as a second pay fact.
const revisionBase = {
  month: '2026-09', dailyEntries: entry('tongying', '2026-09-14', 2050, 20),
  employees: [employees[0]], users: [users[0]],
}
const eight = resolvePayrollCalculation({
  ...revisionBase,
  dailyStoreStaffRows: [attendance({ id: 'revision', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-14', hours: 8 })],
})
const six = resolvePayrollCalculation({
  ...revisionBase,
  dailyStoreStaffRows: [attendance({ id: 'revision', employeeId: 'emp-full', name: '同名员工', store: 'tongying', date: '2026-09-14', hours: 6 })],
})
const immutableAudit = Object.freeze({ before: { actualHours: 8 }, after: { actualHours: 6 } })
assert.equal(eight.payroll.employees[0].payableHours, 8)
assert.equal(six.payroll.employees[0].payableHours, 6)
assert.notEqual(eight.payroll.employees[0].salary, six.payroll.employees[0].salary)
assert.deepEqual(immutableAudit, { before: { actualHours: 8 }, after: { actualHours: 6 } })

console.log('DAILY ENTRY V2 PAYROLL REGRESSION TEST OK')
