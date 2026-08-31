import assert from 'node:assert/strict'
import { buduBusinessDate } from '../shared/businessDate.js'
import {
  PAYROLL_COMPLETENESS_UI,
  projectPayrollCompleteness,
} from '../src/utils/payrollCompletenessPresentation.js'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'

const stores = { guanshe: '北京官舍店' }
const blocker = (reason, date) => ({ type: 'CALCULATION_BLOCKER', reason, date, storeId: 'guanshe' })

const todayMissing = projectPayrollCompleteness([blocker('MISSING_DAILY_ENTRY', '2026-08-31')], '2026-08-31', stores)
assert.equal(todayMissing.state, PAYROLL_COMPLETENESS_UI.TODAY_PENDING)
assert.equal(todayMissing.title, '今日数据待确认')
assert.equal(todayMissing.description, '北京官舍店今日门店录入尚未完成')

const todayDraft = projectPayrollCompleteness([blocker('DRAFT_DAILY_ENTRY', '2026-08-31')], '2026-08-31', stores)
assert.equal(todayDraft.state, PAYROLL_COMPLETENESS_UI.TODAY_PENDING)
assert.equal(todayDraft.description, '北京官舍店今日录入尚未最终确认')

const todayHours = projectPayrollCompleteness([blocker('MISSING_ACTUAL_HOURS', '2026-08-31')], '2026-08-31', stores)
assert.equal(todayHours.title, '今日工时待确认')
assert.equal(todayHours.description, '北京官舍店今日实际工时尚未完善')

const todayIdentity = projectPayrollCompleteness([blocker('UNRESOLVED_EMPLOYEE', '2026-08-31')], '2026-08-31', stores)
assert.equal(todayIdentity.title, '今日人员信息待确认')
assert.equal(todayIdentity.description, '北京官舍店今日值班人员身份尚未完善')

const pastMissing = projectPayrollCompleteness([blocker('MISSING_DAILY_ENTRY', '2026-08-30')], '2026-08-31', stores)
assert.equal(pastMissing.state, PAYROLL_COMPLETENESS_UI.DATA_INCOMPLETE)
assert.equal(pastMissing.title, '工资数据待完善')
assert.equal(pastMissing.description, '8月30日 北京官舍店缺少每日记录')

const pastHours = projectPayrollCompleteness([blocker('MISSING_ACTUAL_HOURS', '2026-08-29')], '2026-08-31', stores)
assert.equal(pastHours.description, '8月29日 北京官舍店实际工时待完善')

const future = projectPayrollCompleteness([blocker('MISSING_DAILY_ENTRY', '2026-09-01')], '2026-08-31', stores)
assert.equal(future.state, PAYROLL_COMPLETENESS_UI.READY)
assert.equal(future.visibleBlockers.length, 0)

const historicalWins = projectPayrollCompleteness([
  blocker('MISSING_DAILY_ENTRY', '2026-08-31'),
  blocker('MISSING_ACTUAL_HOURS', '2026-08-30'),
], '2026-08-31', stores)
assert.equal(historicalWins.state, PAYROLL_COMPLETENESS_UI.DATA_INCOMPLETE)
assert.equal(historicalWins.description, '8月30日 北京官舍店实际工时待完善')

const missingServerDate = projectPayrollCompleteness([blocker('MISSING_DAILY_ENTRY', '2026-08-31')], '', stores)
assert.equal(missingServerDate.state, PAYROLL_COMPLETENESS_UI.DATA_INCOMPLETE)

assert.equal(buduBusinessDate('2026-08-30T15:59:59.000Z'), '2026-08-30')
assert.equal(buduBusinessDate('2026-08-30T16:00:00.000Z'), '2026-08-31')

const missingHoursResolver = resolvePayrollCalculation({
  month: '2026-08',
  dailyEntries: {
    '2026-08|guanshe|08-31': { inc: 3000, ord: 12, staff: ['测试员工'], status: 'confirmed' },
  },
  dailyStoreStaffRows: [{
    id: 'missing-hours', storeId: 'guanshe', storeKey: 'guanshe', date: '2026-08-31',
    employeeId: 'emp-A', participantType: 'EMPLOYEE', staffNameSnapshot: '测试员工',
    actualHours: null, payableHoursSource: 'ACTUAL_HOURS',
  }],
  dailyPayAdjustments: [],
  bigOrderBonuses: [],
  employees: [{ id: 'emp-A', name: '测试员工', status: 'ACTIVE' }],
  users: [],
  storeNames: stores,
})
assert.equal(missingHoursResolver.mode, 'EMPLOYEE_ID')
assert.equal(missingHoursResolver.calculationReady, false)
assert.equal(missingHoursResolver.payroll.employees.length, 0)
assert.equal(missingHoursResolver.readiness.calculationBlockers.some((item) => (
  item.reason === 'MISSING_ACTUAL_HOURS' && item.employeeIds?.includes('emp-A')
)), true)

console.log('PAYROLL_COMPLETENESS_PRESENTATION=PASS')
