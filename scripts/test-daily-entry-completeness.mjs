import assert from 'node:assert/strict'
import {
  DAILY_ENTRY_COMPLETENESS_CODES,
  resolveDailyEntryCompleteness,
} from '../server/daily-entry-completeness.js'

const knownEmployeeIds = new Set(['emp-a', 'emp-b'])
const confirmed = { status: 'confirmed' }
const employee = (employeeId, actualHours = 8) => ({
  participantType: 'EMPLOYEE', employeeId, participantUserId: null,
  payableHoursSource: 'ACTUAL_HOURS', actualHours, historicalPayrollHours: null,
  attendanceStatus: 'normal',
})

assert.equal(resolveDailyEntryCompleteness({ entry: null, staffRows: [], knownEmployeeIds }).code, DAILY_ENTRY_COMPLETENESS_CODES.MISSING_DAILY_ENTRY)
assert.equal(resolveDailyEntryCompleteness({ entry: { status: 'draft' }, staffRows: [], knownEmployeeIds }).code, DAILY_ENTRY_COMPLETENESS_CODES.DRAFT_ENTRY)
assert.equal(resolveDailyEntryCompleteness({ entry: confirmed, staffRows: [], knownEmployeeIds }).code, DAILY_ENTRY_COMPLETENESS_CODES.MISSING_ATTENDANCE)
assert.deepEqual(resolveDailyEntryCompleteness({ entry: confirmed, staffRows: [employee('emp-a')], knownEmployeeIds }), {
  status: 'COMPLETE', code: DAILY_ENTRY_COMPLETENESS_CODES.COMPLETE, issues: [],
})
assert.equal(resolveDailyEntryCompleteness({ entry: confirmed, staffRows: [employee('emp-a', '')], knownEmployeeIds }).code, DAILY_ENTRY_COMPLETENESS_CODES.MISSING_ACTUAL_HOURS)
assert.equal(resolveDailyEntryCompleteness({ entry: confirmed, staffRows: [employee('missing')], knownEmployeeIds }).code, DAILY_ENTRY_COMPLETENESS_CODES.UNRESOLVED_EMPLOYEE)
assert.equal(resolveDailyEntryCompleteness({ entry: confirmed, staffRows: [employee('emp-a'), employee('emp-a')], knownEmployeeIds }).code, DAILY_ENTRY_COMPLETENESS_CODES.INVALID_ATTENDANCE_AUTHORITY)
assert.deepEqual(resolveDailyEntryCompleteness({
  entry: confirmed,
  knownEmployeeIds,
  staffRows: [{
    participantType: 'EMPLOYEE', employeeId: 'emp-a', payableHoursSource: 'LEGACY_PAYROLL_HOURS',
    actualHours: null, historicalPayrollHours: 6.5, attendanceStatus: 'HISTORICAL_UNOBSERVED',
  }],
}), { status: 'COMPLETE', code: DAILY_ENTRY_COMPLETENESS_CODES.COMPLETE, issues: [] })
assert.equal(resolveDailyEntryCompleteness({
  entry: confirmed,
  knownEmployeeIds,
  staffRows: [{
    participantType: 'NON_EMPLOYEE_SUBSTITUTE', participantUserId: 'user-sub', payableHoursSource: 'ACTUAL_HOURS',
    actualHours: 5, historicalPayrollHours: null, attendanceStatus: 'normal',
  }],
}).status, 'COMPLETE')

console.log('DAILY ENTRY COMPLETENESS TEST OK')
