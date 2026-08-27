// 工资条快照生成：按周期（月/周/自定起止日期）生成员工每日明细 + 汇总（元）
import { employeeDailyPayDetail } from './selectors'
import { getWeekDays } from './schedule'
import { HOLIDAYS_2026, WORKDAYS_2026 } from './payroll'

function markOf(monthKey, dd) {
  const full = String(dd).includes('-') ? `${monthKey}-${String(dd).slice(3)}` : `${monthKey}-${String(dd)}`
  const isHolidayDay = HOLIDAYS_2026.has(full)
  const isMakeupDay = WORKDAYS_2026.has(full)
  const dow = new Date(`${full}T00:00:00`).getDay()
  const isWeekendDay = !isHolidayDay && !isMakeupDay && (dow === 0 || dow === 6)
  return isHolidayDay ? 'holiday' : isMakeupDay ? 'makeup' : isWeekendDay ? 'weekend' : null
}

/** 解析自定起止周期 'YYYY-MM-DD~YYYY-MM-DD' → [startDate, endDate]；非法返回 null */
export function parseCustomRange(periodKey) {
  const m = String(periodKey || '').match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  if (!m) return null
  const start = new Date(`${m[1]}T00:00:00`)
  const end = new Date(`${m[2]}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null
  return { start, end, startStr: m[1], endStr: m[2] }
}

/**
 * 生成工资条快照（与人员管理页明细一致；金额单位为元）
 * @param {'month'|'week'|'custom'} periodType
 * @param {string} periodKey 月: '2026-08'；周: 周起始日 '2026-08-10'；自定: '2026-08-10~2026-08-16'
 * @param {string} empName
 */
export function buildPayrollSnapshot(periodType, periodKey, empName) {
  const days = []
  const pushDay = (monthKey, dayStr) => {
    const detail = employeeDailyPayDetail(monthKey, dayStr, empName)
    const t = detail ? detail.totals : null
    days.push({
      day: dayStr,
      mark: markOf(monthKey, dayStr),
      revenue: t ? t.inc : 0,
      hours: t ? t.hours : 0,
      payableHours: t ? t.payableHours ?? t.hours : 0,
      payableHoursSource: t ? t.payableHoursSource || 'LEGACY_DUTY_HOURS' : null,
      basePay: t ? t.basePay : 0,
      commission: t ? t.commission : 0,
      transferSubsidy: t ? t.transferSubsidy : 0,
      bigBonus: t ? t.bigBonus : 0,
      adjustment: t ? t.salaryAdjustment || 0 : 0,
      pay: t ? t.pay : 0,
      hasData: Boolean(detail),
    })
  }
  if (periodType === 'week') {
    const weekDays = getWeekDays(periodKey)
    for (const w of weekDays) {
      pushDay(w.date.slice(0, 7), w.date.slice(5))
    }
  } else if (periodType === 'custom') {
    const range = parseCustomRange(periodKey)
    if (range) {
      const cur = new Date(range.start)
      while (cur <= range.end) {
        const m = String(cur.getMonth() + 1).padStart(2, '0')
        const dd = String(cur.getDate()).padStart(2, '0')
        pushDay(`${cur.getFullYear()}-${m}`, `${m}-${dd}`)
        cur.setDate(cur.getDate() + 1)
      }
    }
  } else {
    const [y, m] = String(periodKey).split('-').map(Number)
    const daysInMonth = new Date(y, m, 0).getDate()
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      pushDay(String(periodKey), dd)
    }
  }
  const summary = days.reduce(
    (s, r) => ({
      workedDays: s.workedDays + (r.hasData ? 1 : 0),
      hours: s.hours + r.hours,
      revenue: s.revenue + (r.revenue || 0),
      basePay: s.basePay + r.basePay,
      commission: s.commission + r.commission,
      transferSubsidy: s.transferSubsidy + r.transferSubsidy,
      bigBonus: s.bigBonus + r.bigBonus,
      adjustment: s.adjustment + r.adjustment,
      total: s.total + r.pay,
    }),
    { workedDays: 0, hours: 0, revenue: 0, basePay: 0, commission: 0, transferSubsidy: 0, bigBonus: 0, adjustment: 0, total: 0 },
  )
  summary.hours = Math.round(summary.hours * 100) / 100
  summary.payableHours = summary.hours
  summary.total = Math.round(summary.total * 100) / 100
  return { days, summary }
}

/** 周期显示文案 */
export function periodLabel(periodType, periodKey) {
  if (periodType === 'week') {
    const end = getWeekDays(periodKey)
    const last = end.length ? end[end.length - 1].date : periodKey
    return `${periodKey} ~ ${last}`
  }
  if (periodType === 'custom') {
    const range = parseCustomRange(periodKey)
    return range ? `${range.startStr} ~ ${range.endStr}` : String(periodKey || '')
  }
  const [y, m] = String(periodKey).split('-')
  return `${y}年${Number(m)}月`
}
