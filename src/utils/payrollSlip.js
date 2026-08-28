import { payrollPeriodLabel, resolvePayrollPeriod } from './payrollPeriod.js'

/** Parse a custom key without constructing timezone-sensitive local Dates. */
export function parseCustomRange(periodKey) {
  const period = resolvePayrollPeriod({ periodType: 'custom', periodKey })
  if (!period.valid) return null
  return {
    startStr: period.periodStart,
    endStr: period.periodEnd,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  }
}

/** Canonical payroll period display. */
export function periodLabel(periodType, periodKey, periodStart = '', periodEnd = '') {
  return payrollPeriodLabel(periodType, periodKey, periodStart, periodEnd)
}
