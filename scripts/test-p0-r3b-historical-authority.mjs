import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePayableHours, PAYABLE_HOURS_SOURCES } from '../shared/payableHoursAuthority.js'
import { calcDailyPay } from '../src/utils/payroll.js'
import { buildEmployeePayrollDayInputs } from '../src/utils/payrollShadowInput.js'
import { calculateEmployeeIdShadowPayroll } from '../src/utils/payrollShadowCalculator.js'
import { P0_R3B_MANIFEST } from './p0-r3b-historical-manifest.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const actual = normalizePayableHours({ actualHours: 0, historicalPayrollHours: null, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal' })
assert.deepEqual(actual, { payableHours: 0, payableHoursSource: 'ACTUAL_HOURS' }, 'real zero preserved')
const historical = normalizePayableHours({ actualHours: null, historicalPayrollHours: 11, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' })
assert.deepEqual(historical, { payableHours: 11, payableHoursSource: 'LEGACY_PAYROLL_HOURS' })

const invalidRows = [
  { actualHours: 8, historicalPayrollHours: 8, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal' },
  { actualHours: null, historicalPayrollHours: 8, payableHoursSource: 'ACTUAL_HOURS', attendanceStatus: 'normal' },
  { actualHours: 8, historicalPayrollHours: null, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' },
  { actualHours: null, historicalPayrollHours: 8, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'normal' },
  { actualHours: null, historicalPayrollHours: Number.NaN, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' },
  { actualHours: null, historicalPayrollHours: 25, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' },
]
for (const row of invalidRows) assert.throws(() => normalizePayableHours(row), TypeError)

const formulaActual = calcDailyPay({ storeKey: 'guanshe', revenue: 6000, date: '2026-08-04', staffCount: 1, payableHours: 11, payableHoursSource: PAYABLE_HOURS_SOURCES.ACTUAL_HOURS })
const formulaHistorical = calcDailyPay({ storeKey: 'guanshe', revenue: 6000, date: '2026-08-04', staffCount: 1, payableHours: 11, payableHoursSource: PAYABLE_HOURS_SOURCES.LEGACY_PAYROLL_HOURS })
assert.deepEqual(
  { basePay: formulaHistorical.basePay, commission: formulaHistorical.commission, transferSubsidy: formulaHistorical.transferSubsidy, total: formulaHistorical.total },
  { basePay: formulaActual.basePay, commission: formulaActual.commission, transferSubsidy: formulaActual.transferSubsidy, total: formulaActual.total },
  'formula does not fork by source',
)
assert.equal(formulaHistorical.explanation.payableHoursSource, 'LEGACY_PAYROLL_HOURS')

const entries = { '2026-08|chaowai|08-01': { inc: 2000, ord: 20, staff: ['马婧欣', '卡皮巴拉'], status: 'confirmed' } }
const rows = [
  { id: 'employee', storeId: 'chaowai', date: '2026-08-01', employeeId: 'emp-ma', participantType: 'EMPLOYEE', staffNameSnapshot: '马婧欣', actualHours: null, historicalPayrollHours: 8, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' },
  { id: 'substitute', storeId: 'chaowai', date: '2026-08-01', participantUserId: 'user-capybara', participantType: 'NON_EMPLOYEE_SUBSTITUTE', staffNameSnapshot: '卡皮巴拉', actualHours: null, historicalPayrollHours: 8, payableHoursSource: 'LEGACY_PAYROLL_HOURS', attendanceStatus: 'HISTORICAL_UNOBSERVED' },
]
const input = buildEmployeePayrollDayInputs(entries, rows)
assert.equal(input.stableRows[0].participantCount, 2, 'substitute counts in participantCount')
const payroll = calculateEmployeeIdShadowPayroll(entries, rows, [], [], '2026-08')
assert.equal(payroll.employees.length, 1, 'substitute does not create payroll subject')
assert.equal(payroll.employees[0].payableHours, 8)
assert.equal(payroll.employees[0].dailyExplanations[0].payableHoursSource, 'LEGACY_PAYROLL_HOURS')

const participants = P0_R3B_MANIFEST.flatMap((entry) => entry.participants)
assert.equal(P0_R3B_MANIFEST.length, 40)
assert.equal(participants.length, 47)
assert.equal(participants.filter((row) => row.participantType === 'EMPLOYEE').length, 45)
assert.equal(participants.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').length, 2)
assert.equal(participants.filter((row) => row.participantType === 'EMPLOYEE').reduce((sum, row) => sum + row.historicalPayrollHours, 0), 470)
assert.equal(participants.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').reduce((sum, row) => sum + row.historicalPayrollHours, 0), 23)
assert.equal(new Set(participants.map((row) => row.dailyStoreStaffId)).size, 47, 'fixed DSS PKs unique')

const serverSource = fs.readFileSync(path.join(root, 'server/daily-entry-upgrade.js'), 'utf8')
assert.match(serverSource, /historicalPayrollHours.*payableHoursSource/s, 'transport preserves both tagged fields')
assert.match(serverSource, /历史计薪工时只能通过受控修复流程写入/, 'normal API rejects forged historical source')
assert.match(serverSource, /历史计薪工时为只读权威记录/, 'normal API blocks historical overwrite/delete')

console.log('P0-R3B HISTORICAL PAYABLE HOURS AUTHORITY TEST OK')
