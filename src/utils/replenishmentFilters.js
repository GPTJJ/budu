function shanghaiDate(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)))
}

const iso = (date) => date.toISOString().slice(0, 10)
const addDays = (date, count) => new Date(date.getTime() + count * 86400000)

export function replenishmentQuickRange(key, now = new Date()) {
  const today = shanghaiDate(now)
  const weekday = (today.getUTCDay() + 6) % 7
  const monday = addDays(today, -weekday)
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const ranges = {
    today: [today, today], yesterday: [addDays(today, -1), addDays(today, -1)],
    week: [monday, addDays(monday, 6)], lastWeek: [addDays(monday, -7), addDays(monday, -1)],
    month: [first, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))],
    lastMonth: [new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)), addDays(first, -1)],
  }
  const range = ranges[key]
  return range ? { startDate: iso(range[0]), endDate: iso(range[1]) } : { startDate: '', endDate: '' }
}
