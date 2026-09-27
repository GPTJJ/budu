export const PAYABLE_HOURS_SOURCES = Object.freeze({
  ACTUAL_HOURS: 'ACTUAL_HOURS',
  LEGACY_PAYROLL_HOURS: 'LEGACY_PAYROLL_HOURS',
})

export const HISTORICAL_ATTENDANCE_STATUS = 'HISTORICAL_UNOBSERVED'

const absent = (value) => value == null || value === ''

const finiteHours = (value, field) => {
  if (absent(value)) throw new TypeError(`${field} is required`)
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new TypeError(`${field} must be a finite number between 0 and 24`)
  }
  return hours
}

/**
 * The only persisted DailyStoreStaff payable-hours decoder.
 *
 * It enforces the tagged union and fails closed:
 * - ACTUAL_HOURS: actualHours is present; historicalPayrollHours is absent.
 * - LEGACY_PAYROLL_HOURS: historicalPayrollHours is present; actualHours is absent.
 *
 * Rows without a discriminator are accepted only as pre-migration transport
 * compatibility when actualHours is explicit. Persisted rows receive the source
 * default in the migration and therefore never depend on this inference.
 */
export function normalizePayableHours(row) {
  const source = row?.payableHoursSource || (
    !absent(row?.actualHours) && absent(row?.historicalPayrollHours)
      ? PAYABLE_HOURS_SOURCES.ACTUAL_HOURS
      : ''
  )

  if (source === PAYABLE_HOURS_SOURCES.ACTUAL_HOURS) {
    if (!absent(row?.historicalPayrollHours)) {
      throw new TypeError('ACTUAL_HOURS cannot carry historicalPayrollHours')
    }
    if (row?.attendanceStatus === HISTORICAL_ATTENDANCE_STATUS) {
      throw new TypeError('ACTUAL_HOURS cannot use HISTORICAL_UNOBSERVED')
    }
    return {
      payableHours: finiteHours(row?.actualHours, 'actualHours'),
      payableHoursSource: source,
    }
  }

  if (source === PAYABLE_HOURS_SOURCES.LEGACY_PAYROLL_HOURS) {
    if (!absent(row?.actualHours)) {
      throw new TypeError('LEGACY_PAYROLL_HOURS cannot carry actualHours')
    }
    if (row?.attendanceStatus !== HISTORICAL_ATTENDANCE_STATUS) {
      throw new TypeError('LEGACY_PAYROLL_HOURS requires HISTORICAL_UNOBSERVED')
    }
    return {
      payableHours: finiteHours(row?.historicalPayrollHours, 'historicalPayrollHours'),
      payableHoursSource: source,
    }
  }

  throw new TypeError('payableHoursSource is missing or unsupported')
}
