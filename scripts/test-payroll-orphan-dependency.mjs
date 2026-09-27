import assert from 'node:assert/strict'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'
import { stablePayrollJson } from '../server/payroll-authority.js'

const employees = [
  { id: 'emp-li', name: '李飞燕', type: 'fulltime', status: 'ACTIVE' },
  { id: 'emp-capybara', name: '卡皮巴拉', type: 'fulltime', status: 'ACTIVE' },
  { id: 'emp-sui', name: '隋晓', type: 'fulltime', status: 'ACTIVE' },
  { id: 'emp-history', name: '历史员工', type: 'parttime', status: 'ACTIVE' },
]
const users = employees.map((row) => ({ username: `user-${row.id}`, employeeId: row.id, status: 'active' }))
const entry = (store, date, status = 'confirmed', inc = 2000, ord = 20) => ({
  [`${date.slice(0, 7)}|${store}|${date.slice(5)}`]: { inc, ord, staff: [], status },
})
const attendance = (id, employeeId, name, store, date, actualHours = 8, overrides = {}) => ({
  id,
  employeeId,
  participantType: 'EMPLOYEE',
  participantUserId: null,
  storeId: store,
  storeKey: store,
  date,
  staffId: `employee:${employeeId}`,
  staffNameSnapshot: name,
  actualHours,
  historicalPayrollHours: null,
  payableHoursSource: 'ACTUAL_HOURS',
  attendanceStatus: 'normal',
  scheduledHours: 0,
  ...overrides,
})
const resolve = (overrides) => resolvePayrollCalculation({
  month: '2026-08',
  dailyEntries: {},
  dailyStoreStaffRows: [],
  employees,
  users,
  dailyPayAdjustments: [],
  bigOrderBonuses: [],
  storeNames: {
    guanshe: '北京官舍店',
    tongying: '北京通盈中心店',
    chaowai: '北京朝外店',
    xidan: '北京西单店',
  },
  ...overrides,
})

const validEntries = {
  ...entry('tongying', '2026-08-31'),
  ...entry('chaowai', '2026-08-31'),
}
const validRows = [
  attendance('li-valid', 'emp-li', '李飞燕', 'tongying', '2026-08-31'),
  attendance('capy-valid', 'emp-capybara', '卡皮巴拉', 'chaowai', '2026-08-31'),
]
const productionOrphans = [
  attendance('dss-6b6fc272-0e63-4d2f-bc5d-e107bc905e98', 'emp-li', '李飞燕', 'guanshe', '2026-08-31'),
  attendance('dss-4942d304-aa14-4ea3-b34b-6e220f11ebfa', 'emp-capybara', '卡皮巴拉', 'guanshe', '2026-08-31'),
]

// 1/2/6/9: exact production orphan identities stay in input history but do not
// add Guanshe dependencies, storesWorked, payable hours, or payroll math.
const clean = resolve({ dailyEntries: validEntries, dailyStoreStaffRows: validRows })
const withOrphans = resolve({ dailyEntries: validEntries, dailyStoreStaffRows: [...validRows, ...productionOrphans] })
assert.equal(stablePayrollJson(withOrphans.payroll.employees), stablePayrollJson(clean.payroll.employees))
assert.equal(withOrphans.readiness.coverage.orphanAttendanceRows, 2)
for (const employeeId of ['emp-li', 'emp-capybara']) {
  const readiness = withOrphans.readiness.employees.find((row) => row.employeeId === employeeId)
  assert.equal(readiness.calculationReady, true)
  assert.equal(readiness.blockers.some((row) => row.storeId === 'guanshe'), false)
  const payroll = withOrphans.payroll.employees.find((row) => row.employeeId === employeeId)
  assert.equal(payroll.storesWorked.includes('guanshe'), false)
}

// 3: legitimate current Guanshe participant under a draft DailyEntry remains
// fail-closed and receives the same current-day business completeness blocker.
const draft = resolve({
  dailyEntries: {
    ...entry('guanshe', '2026-08-30'),
    ...entry('guanshe', '2026-08-31', 'draft'),
  },
  dailyStoreStaffRows: [
    attendance('sui-previous', 'emp-sui', '隋晓', 'guanshe', '2026-08-30'),
    attendance('sui-today', 'emp-sui', '隋晓', 'guanshe', '2026-08-31'),
  ],
})
const sui = draft.readiness.employees.find((row) => row.employeeId === 'emp-sui')
assert.equal(sui.calculationReady, false)
assert.equal(sui.blockers.some((row) => row.reason === 'DRAFT_DAILY_ENTRY' && row.storeId === 'guanshe'), true)

// 4/5: legitimate joined history remains strict; missing actualHours never uses
// Schedule dutyHours or a default eight hours.
const historical = resolve({
  dailyEntries: {
    ...entry('xidan', '2026-08-29'),
    ...entry('xidan', '2026-08-30'),
  },
  dailyStoreStaffRows: [
    attendance('history-valid', 'emp-history', '历史员工', 'xidan', '2026-08-29', 6),
    attendance('history-missing', 'emp-history', '历史员工', 'xidan', '2026-08-30', null, { scheduledHours: 8 }),
  ],
})
const historyReadiness = historical.readiness.employees.find((row) => row.employeeId === 'emp-history')
assert.equal(historyReadiness.calculationReady, false)
assert.equal(historyReadiness.blockers.some((row) => row.reason === 'MISSING_ACTUAL_HOURS' && row.date === '2026-08-30'), true)
assert.equal(historical.payroll.employees.find((row) => row.employeeId === 'emp-history')?.payableHours, 6)

// 7: legitimate same-day multi-store participation stays additive.
const multiStore = resolve({
  dailyEntries: {
    ...entry('tongying', '2026-08-28'),
    ...entry('guanshe', '2026-08-28'),
  },
  dailyStoreStaffRows: [
    attendance('li-multi-a', 'emp-li', '李飞燕', 'tongying', '2026-08-28', 4),
    attendance('li-multi-b', 'emp-li', '李飞燕', 'guanshe', '2026-08-28', 5),
  ],
})
const liMulti = multiStore.payroll.employees.find((row) => row.employeeId === 'emp-li')
assert.equal(liMulti.payableHours, 9)
assert.deepEqual([...liMulti.storesWorked].sort(), ['guanshe', 'tongying'])

// 8: reviewed legacy payroll-hours compatibility remains unchanged.
const legacy = resolve({
  dailyEntries: entry('chaowai', '2026-08-01'),
  dailyStoreStaffRows: [{
    id: 'legacy-reviewed', employeeId: null, participantType: 'LEGACY_EMPLOYEE_COMPATIBLE', participantUserId: null,
    storeId: 'chaowai', storeKey: 'chaowai', date: '2026-08-01', staffId: 'legacy:历史兼容',
    staffNameSnapshot: '历史兼容', actualHours: null, historicalPayrollHours: 11.5,
    payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED',
  }],
  employees: [{ id: 'legacy-directory', name: '历史兼容', type: 'parttime', status: 'ACTIVE' }],
  users: [],
})
assert.equal(legacy.attendanceMode, 'LEGACY_COMPATIBLE')
assert.equal(legacy.payroll.employees[0].hours, 11.5)

console.log('PAYROLL ORPHAN DEPENDENCY HOTFIX TEST OK')
