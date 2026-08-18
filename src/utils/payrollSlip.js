// 工资条快照生成：按周期（月/周）生成员工每日明细 + 汇总（元）
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

/**
 * 生成工资条快照（与人员管理页明细一致；金额单位为元）
 * @param {'month'|'week'} periodType
 * @param {string} periodKey 月: '2026-08'；周: 周起始日 '2026-08-10'
 * @param {string} empName
 */
export function buildPayrollSnapshot(periodType, periodKey, empName) {
  const days = []
  if (periodType === 'week') {
    const weekDays = getWeekDays(periodKey)
    for (const w of weekDays) {
      const monthKey = w.date.slice(0, 7)
      const dd = w.date.slice(5)
      const detail = employeeDailyPayDetail(monthKey, dd, empName)
      const t = detail ? detail.totals : null
      days.push({
        day: dd,
        mark: markOf(monthKey, dd),
        revenue: t ? t.inc : 0,
        hours: t ? t.hours : 0,
        basePay: t ? t.basePay : 0,
        commission: t ? t.commission : 0,
        transferSubsidy: t ? t.transferSubsidy : 0,
        bigBonus: t ? t.bigBonus : 0,
        adjustment: t ? t.salaryAdjustment || 0 : 0,
        pay: t ? t.pay : 0,
        hasData: Boolean(detail),
      })
    }
  } else {
    const [y, m] = String(periodKey).split('-').map(Number)
    const daysInMonth = new Date(y, m, 0).getDate()
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      const detail = employeeDailyPayDetail(String(periodKey), dd, empName)
      const t = detail ? detail.totals : null
      days.push({
        day: String(d).padStart(2, '0'),
        mark: markOf(String(periodKey), dd),
        revenue: t ? t.inc : 0,
        hours: t ? t.hours : 0,
        basePay: t ? t.basePay : 0,
        commission: t ? t.commission : 0,
        transferSubsidy: t ? t.transferSubsidy : 0,
        bigBonus: t ? t.bigBonus : 0,
        adjustment: t ? t.salaryAdjustment || 0 : 0,
        pay: t ? t.pay : 0,
        hasData: Boolean(detail),
      })
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
  const [y, m] = String(periodKey).split('-')
  return `${y}年${Number(m)}月`
}
