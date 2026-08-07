/** 排班周工具：以周一作为一周起始（与国内排班习惯一致） */

const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function pad(n) {
  return String(n).padStart(2, '0')
}

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayStr() {
  return toDateStr(new Date())
}

/** 解析 YYYY-MM-DD 为本地日期对象 */
export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

/** 返回日期所在周的周一（YYYY-MM-DD） */
export function getWeekStart(date = new Date()) {
  const d = date instanceof Date ? new Date(date) : parseDate(date)
  const diff = (d.getDay() + 6) % 7 // 周一=0
  d.setDate(d.getDate() - diff)
  return toDateStr(d)
}

/** 周起点加减 n 周 */
export function addWeeks(weekStart, delta) {
  const d = parseDate(weekStart)
  d.setDate(d.getDate() + delta * 7)
  return toDateStr(d)
}

/** 返回一周 7 天：{ date, day, label } */
export function getWeekDays(weekStart) {
  const d = parseDate(weekStart)
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d)
    x.setDate(d.getDate() + i)
    return { date: toDateStr(x), day: pad(x.getDate()), label: WEEK_LABELS[i] }
  })
}

/** ISO 周序号（第几周） */
export function isoWeek(weekStart) {
  const d = parseDate(weekStart)
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day + 3)
  const firstThursday = new Date(d.getFullYear(), 0, 4)
  const firstDay = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3)
  return 1 + Math.round((d - firstThursday) / (7 * 86400000))
}

/** 周范围文案：2026-08-03 ~ 2026-08-09 */
export function weekRangeLabel(weekStart) {
  const days = getWeekDays(weekStart)
  return `${weekStart} ~ ${days[6].date}`
}
