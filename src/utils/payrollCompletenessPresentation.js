export const PAYROLL_COMPLETENESS_UI = Object.freeze({
  READY: 'READY',
  TODAY_PENDING: 'TODAY_PENDING',
  DATA_INCOMPLETE: 'DATA_INCOMPLETE',
})

const isBusinessDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))

const chineseDate = (date) => {
  if (!isBusinessDate(date)) return String(date || '')
  const [, month, day] = date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

const placeOf = (blocker, storeNames) => (
  storeNames?.[blocker?.storeId] || blocker?.storeName || blocker?.storeId || ''
)

function historicalDescription(blocker, storeNames) {
  const date = chineseDate(blocker?.date)
  const place = placeOf(blocker, storeNames)
  const prefix = `${date} ${place}`.trim()
  if (blocker?.reason === 'MISSING_DAILY_ENTRY') return `${prefix}缺少每日记录`
  if (blocker?.reason === 'DRAFT_DAILY_ENTRY' || blocker?.reason === 'DAILY_ENTRY_STATUS_UNKNOWN') return `${prefix}每日记录尚未确认`
  if (blocker?.reason === 'MISSING_ACTUAL_HOURS') return `${prefix}实际工时待完善`
  if (blocker?.reason === 'UNRESOLVED_EMPLOYEE' || blocker?.reason === 'LEGACY_UNKNOWN_PARTICIPANT') return `${prefix}值班人员身份待完善`
  return blocker?.detail || blocker?.reason || '缺少工资计算所需事实'
}

function todayPresentation(blocker, storeNames) {
  const place = placeOf(blocker, storeNames)
  if (blocker?.reason === 'MISSING_ACTUAL_HOURS') {
    return { title: '今日工时待确认', description: `${place}今日实际工时尚未完善`.trim() }
  }
  if (blocker?.reason === 'UNRESOLVED_EMPLOYEE' || blocker?.reason === 'LEGACY_UNKNOWN_PARTICIPANT') {
    return { title: '今日人员信息待确认', description: `${place}今日值班人员身份尚未完善`.trim() }
  }
  if (blocker?.reason === 'DRAFT_DAILY_ENTRY' || blocker?.reason === 'DAILY_ENTRY_STATUS_UNKNOWN') {
    return { title: '今日数据待确认', description: `${place}今日录入尚未最终确认`.trim() }
  }
  return { title: '今日数据待确认', description: `${place}今日门店录入尚未完成`.trim() }
}

const todayPriority = (reason) => ({
  UNRESOLVED_EMPLOYEE: 0,
  LEGACY_UNKNOWN_PARTICIPANT: 0,
  MISSING_ACTUAL_HOURS: 1,
  DRAFT_DAILY_ENTRY: 2,
  DAILY_ENTRY_STATUS_UNKNOWN: 2,
  MISSING_DAILY_ENTRY: 3,
}[reason] ?? 10)

/**
 * UI-only completeness projection. Payroll calculation and issuance readiness
 * remain owned by the resolver; this function only classifies its blockers.
 */
export function projectPayrollCompleteness(blockers, businessDate, storeNames = {}) {
  const rows = Array.isArray(blockers) ? blockers.filter(Boolean) : []
  if (!isBusinessDate(businessDate)) {
    const blocker = rows[0]
    return {
      state: rows.length > 0 ? PAYROLL_COMPLETENESS_UI.DATA_INCOMPLETE : PAYROLL_COMPLETENESS_UI.READY,
      title: rows.length > 0 ? '工资数据待完善' : '',
      description: rows.length > 0 ? historicalDescription(blocker, storeNames) : '',
      blocker,
      visibleBlockers: rows,
    }
  }

  // A future fact has not happened and cannot be called incomplete. Blockers
  // without a stable date remain strict historical/data warnings.
  const visible = rows.filter((blocker) => !isBusinessDate(blocker?.date) || blocker.date <= businessDate)
  if (visible.length === 0) {
    return { state: PAYROLL_COMPLETENESS_UI.READY, title: '', description: '', blocker: null, visibleBlockers: [] }
  }

  const historical = visible.filter((blocker) => !isBusinessDate(blocker?.date) || blocker.date < businessDate)
  if (historical.length > 0) {
    const blocker = historical[0]
    return {
      state: PAYROLL_COMPLETENESS_UI.DATA_INCOMPLETE,
      title: '工资数据待完善',
      description: historicalDescription(blocker, storeNames),
      blocker,
      visibleBlockers: visible,
    }
  }

  const today = [...visible].sort((a, b) => todayPriority(a?.reason) - todayPriority(b?.reason))
  const blocker = today[0]
  const copy = todayPresentation(blocker, storeNames)
  return {
    state: PAYROLL_COMPLETENESS_UI.TODAY_PENDING,
    ...copy,
    blocker,
    visibleBlockers: visible,
  }
}
