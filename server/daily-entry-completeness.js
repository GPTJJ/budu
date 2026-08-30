import {
  PAYABLE_HOURS_SOURCES,
  normalizePayableHours,
} from '../shared/payableHoursAuthority.js'
import {
  PAYROLL_PARTICIPANT_TYPES,
} from './payroll-participant-authority.js'

export const DAILY_ENTRY_COMPLETENESS_CODES = Object.freeze({
  COMPLETE: 'COMPLETE',
  MISSING_DAILY_ENTRY: 'MISSING_DAILY_ENTRY',
  DRAFT_ENTRY: 'DRAFT_ENTRY',
  MISSING_ATTENDANCE: 'MISSING_ATTENDANCE',
  MISSING_ACTUAL_HOURS: 'MISSING_ACTUAL_HOURS',
  UNRESOLVED_EMPLOYEE: 'UNRESOLVED_EMPLOYEE',
  INVALID_ATTENDANCE_AUTHORITY: 'INVALID_ATTENDANCE_AUTHORITY',
})

function issue(code, participantKey = '') {
  return { code, participantKey }
}

/**
 * Read-only Daily Entry payroll-input projection. It validates the existing
 * payable-hours authority and never calculates payroll money.
 */
export function resolveDailyEntryCompleteness({ entry, staffRows, knownEmployeeIds } = {}) {
  if (!entry) return { status: 'INCOMPLETE', code: DAILY_ENTRY_COMPLETENESS_CODES.MISSING_DAILY_ENTRY, issues: [issue(DAILY_ENTRY_COMPLETENESS_CODES.MISSING_DAILY_ENTRY)] }
  if (entry.status !== 'confirmed') return { status: 'INCOMPLETE', code: DAILY_ENTRY_COMPLETENESS_CODES.DRAFT_ENTRY, issues: [issue(DAILY_ENTRY_COMPLETENESS_CODES.DRAFT_ENTRY)] }
  const rows = Array.isArray(staffRows) ? staffRows : []
  if (rows.length === 0) return { status: 'INCOMPLETE', code: DAILY_ENTRY_COMPLETENESS_CODES.MISSING_ATTENDANCE, issues: [issue(DAILY_ENTRY_COMPLETENESS_CODES.MISSING_ATTENDANCE)] }

  const issues = []
  const identities = new Set()
  for (const row of rows) {
    const participantType = String(row?.participantType || '')
    const employeeId = String(row?.employeeId || '').trim()
    const participantUserId = String(row?.participantUserId || '').trim()
    let participantKey = ''
    if (participantType === PAYROLL_PARTICIPANT_TYPES.EMPLOYEE) {
      participantKey = employeeId ? `employee:${employeeId}` : ''
      if (!employeeId || (knownEmployeeIds instanceof Set && !knownEmployeeIds.has(employeeId))) {
        issues.push(issue(DAILY_ENTRY_COMPLETENESS_CODES.UNRESOLVED_EMPLOYEE, participantKey))
        continue
      }
    } else if (participantType === PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE) {
      participantKey = participantUserId ? `user:${participantUserId}` : ''
      if (!participantUserId) {
        issues.push(issue(DAILY_ENTRY_COMPLETENESS_CODES.INVALID_ATTENDANCE_AUTHORITY, participantKey))
        continue
      }
    } else {
      issues.push(issue(DAILY_ENTRY_COMPLETENESS_CODES.UNRESOLVED_EMPLOYEE, employeeId || participantUserId))
      continue
    }
    if (identities.has(participantKey)) {
      issues.push(issue(DAILY_ENTRY_COMPLETENESS_CODES.INVALID_ATTENDANCE_AUTHORITY, participantKey))
      continue
    }
    identities.add(participantKey)
    const source = String(row?.payableHoursSource || PAYABLE_HOURS_SOURCES.ACTUAL_HOURS)
    if (source === PAYABLE_HOURS_SOURCES.ACTUAL_HOURS && (row?.actualHours === null || row?.actualHours === undefined || row?.actualHours === '')) {
      issues.push(issue(DAILY_ENTRY_COMPLETENESS_CODES.MISSING_ACTUAL_HOURS, participantKey))
      continue
    }
    try {
      normalizePayableHours({
        actualHours: row?.actualHours,
        historicalPayrollHours: row?.historicalPayrollHours,
        payableHoursSource: source,
        attendanceStatus: row?.attendanceStatus,
      })
    } catch {
      issues.push(issue(DAILY_ENTRY_COMPLETENESS_CODES.INVALID_ATTENDANCE_AUTHORITY, participantKey))
    }
  }
  return issues.length === 0
    ? { status: 'COMPLETE', code: DAILY_ENTRY_COMPLETENESS_CODES.COMPLETE, issues: [] }
    : { status: 'INCOMPLETE', code: issues[0].code, issues }
}
