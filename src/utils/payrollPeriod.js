const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export const PAYROLL_PERIOD_TYPES = Object.freeze({
  MONTH: 'month',
  WEEK: 'week',
  CUSTOM: 'custom',
})

const pad = (value) => String(value).padStart(2, '0')

function dateParts(value) {
  const match = String(value || '').match(DATE_RE)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null
  return { year, month, day, date }
}

export function isBusinessDate(value) {
  return Boolean(dateParts(value))
}

export function addBusinessDays(value, count) {
  const parsed = dateParts(value)
  if (!parsed || !Number.isInteger(count)) return ''
  const date = new Date(parsed.date)
  date.setUTCDate(date.getUTCDate() + count)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function businessDateDayOfWeek(value) {
  const parsed = dateParts(value)
  return parsed ? parsed.date.getUTCDay() : null
}

export function monthEnd(month) {
  const match = String(month || '').match(MONTH_RE)
  if (!match) return ''
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function isDateInPayrollRange(value, periodStart, periodEnd) {
  const date = String(value || '').slice(0, 10)
  return isBusinessDate(date) && date >= periodStart && date <= periodEnd
}

export function monthsInPayrollRange(periodStart, periodEnd) {
  if (!isBusinessDate(periodStart) || !isBusinessDate(periodEnd) || periodStart > periodEnd) return []
  const result = []
  let year = Number(periodStart.slice(0, 4))
  let month = Number(periodStart.slice(5, 7))
  const endYear = Number(periodEnd.slice(0, 4))
  const endMonth = Number(periodEnd.slice(5, 7))
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${pad(month)}`)
    month += 1
    if (month === 13) {
      month = 1
      year += 1
    }
  }
  return result
}

export function payrollRangeDates(periodStart, periodEnd) {
  if (!isBusinessDate(periodStart) || !isBusinessDate(periodEnd) || periodStart > periodEnd) return []
  const dates = []
  for (let date = periodStart; date <= periodEnd; date = addBusinessDays(date, 1)) dates.push(date)
  return dates
}

function invalid(reason, detail) {
  return { valid: false, reason, detail, periodType: '', periodKey: '', periodStart: '', periodEnd: '', months: [] }
}

/**
 * Normalize every payroll period to inclusive Asia/Shanghai business dates.
 * Date-only arithmetic is performed in UTC deliberately: it cannot drift with
 * the browser/host timezone and China business dates have no DST behavior.
 */
export function resolvePayrollPeriod(input = {}) {
  const legacyMonth = String(input.month || '')
  const explicitType = String(input.periodType || '').toLowerCase()
  const periodType = explicitType || (legacyMonth ? PAYROLL_PERIOD_TYPES.MONTH : '')
  const suppliedKey = String(input.periodKey || '')
  const suppliedStart = String(input.periodStart || '')
  const suppliedEnd = String(input.periodEnd || '')

  if (!Object.values(PAYROLL_PERIOD_TYPES).includes(periodType)) {
    return invalid('INVALID_PERIOD_TYPE', '工资周期类型必须是 month、week 或 custom')
  }

  let periodKey = suppliedKey
  let periodStart = suppliedStart
  let periodEnd = suppliedEnd

  if (periodType === PAYROLL_PERIOD_TYPES.MONTH) {
    const month = suppliedKey || legacyMonth || suppliedStart.slice(0, 7)
    if (!MONTH_RE.test(month)) return invalid(legacyMonth ? 'INVALID_MONTH' : 'INVALID_PERIOD', '月份格式应为 YYYY-MM')
    const expectedStart = `${month}-01`
    const expectedEnd = monthEnd(month)
    if ((suppliedStart && suppliedStart !== expectedStart) || (suppliedEnd && suppliedEnd !== expectedEnd)) {
      return invalid('PERIOD_RANGE_MISMATCH', '月度周期起止日期与月份不一致')
    }
    periodKey = month
    periodStart = expectedStart
    periodEnd = expectedEnd
  } else if (periodType === PAYROLL_PERIOD_TYPES.WEEK) {
    const start = suppliedStart || suppliedKey
    if (!isBusinessDate(start)) return invalid('INVALID_PERIOD', '周度周期应提供有效周一日期')
    if (businessDateDayOfWeek(start) !== 1) return invalid('INVALID_WEEK_START', '周度周期必须从周一开始')
    const expectedEnd = addBusinessDays(start, 6)
    if (suppliedEnd && suppliedEnd !== expectedEnd) return invalid('PERIOD_RANGE_MISMATCH', '周度周期必须为周一至周日')
    if (suppliedKey && suppliedKey !== start) return invalid('PERIOD_RANGE_MISMATCH', '周度周期键与开始日期不一致')
    periodKey = start
    periodStart = start
    periodEnd = expectedEnd
  } else {
    const keyParts = suppliedKey.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
    const start = suppliedStart || (keyParts && keyParts[1]) || ''
    const end = suppliedEnd || (keyParts && keyParts[2]) || ''
    if (!isBusinessDate(start) || !isBusinessDate(end)) return invalid('INVALID_PERIOD', '自定义周期必须提供有效开始和结束日期')
    if (start > end) return invalid('INVALID_PERIOD_ORDER', '周期开始不能晚于周期结束')
    const expectedKey = `${start}~${end}`
    if (suppliedKey && suppliedKey !== expectedKey) return invalid('PERIOD_RANGE_MISMATCH', '自定义周期键与起止日期不一致')
    periodKey = expectedKey
    periodStart = start
    periodEnd = end
  }

  return {
    valid: true,
    reason: '',
    detail: '',
    periodType,
    periodTypeCode: periodType.toUpperCase(),
    periodKey,
    periodStart,
    periodEnd,
    month: periodType === PAYROLL_PERIOD_TYPES.MONTH ? periodKey : '',
    months: monthsInPayrollRange(periodStart, periodEnd),
    rangeKey: `${periodType}|${periodStart}|${periodEnd}`,
  }
}

export function payrollPeriodLabel(periodType, periodKey, periodStart = '', periodEnd = '') {
  const period = resolvePayrollPeriod({ periodType, periodKey, periodStart, periodEnd })
  if (!period.valid) return String(periodKey || '')
  if (period.periodType === PAYROLL_PERIOD_TYPES.MONTH) {
    return `${period.periodStart.slice(0, 4)}年${Number(period.periodStart.slice(5, 7))}月`
  }
  return `${period.periodStart} ～ ${period.periodEnd}`
}

export function payrollPeriodKindLabel(periodType) {
  if (periodType === PAYROLL_PERIOD_TYPES.WEEK) return '周度'
  if (periodType === PAYROLL_PERIOD_TYPES.CUSTOM) return '自定义日期'
  return '月度'
}

export function payrollRangesOverlap(left, right) {
  return left.periodStart <= right.periodEnd && left.periodEnd >= right.periodStart
}
