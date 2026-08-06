/** 中国大陆 2026 法定节假日（含调休补班） */
export const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

/** 2026 年调休上班的周末（按工作日计算） */
export const WORKDAYS_2026 = new Set([
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
])

/** 判断某天是否为节假日（周末或法定节假日；调休补班按工作日处理） */
export function isHoliday(dateStr) {
  const key = String(dateStr)
  if (HOLIDAYS_2026.has(key)) return true
  if (WORKDAYS_2026.has(key)) return false
  const d = new Date(`${key}T00:00:00`)
  if (Number.isNaN(d.getTime())) return false
  const dow = d.getDay()
  return dow === 0 || dow === 6
}

/** 各门店薪酬配置 */
export const STORE_PAY_CONFIG = {
  tongying: { onePersonHours: 12, target: 2000, holidayTarget: 5000 },
  xidan: { onePersonHours: 12, target: 2000 },
  chaowai: { onePersonHours: 11.5, target: 2000 },
  guanshe: { onePersonHours: 11, target: 2000 },
}

const DEFAULT_PAY_CONFIG = { onePersonHours: 12, target: 2000 }

/** 门店别名：新增门店（key 自动生成）也可按门店名匹配到对应薪酬配置 */
const STORE_ALIASES = [
  { key: 'tongying', names: ['通盈'] },
  { key: 'xidan', names: ['西单'] },
  { key: 'chaowai', names: ['朝外'] },
  { key: 'guanshe', names: ['官舍'] },
]

export function normalizeStoreKey(storeKey, storeName = '') {
  const key = String(storeKey || '')
  if (STORE_PAY_CONFIG[key]) return key
  const combined = `${key} ${storeName}`
  for (const alias of STORE_ALIASES) {
    if (alias.names.some((n) => combined.includes(n))) return alias.key
  }
  return key
}

export function storePayConfig(storeKey, storeName = '') {
  return STORE_PAY_CONFIG[normalizeStoreKey(storeKey, storeName)] || DEFAULT_PAY_CONFIG
}

const BASE_RATE = 28
const OVERTIME_SUBSIDY = 2
const COMMISSION_STEP = 1000
const COMMISSION_PER_STEP = 5

/** 当日值班工时：1 人按门店标准工时；2 人及以上各 8h */
export function dutyHours(storeKey, staffCount, storeName = '') {
  if (Number(staffCount) <= 1) return storePayConfig(storeKey, storeName).onePersonHours
  return 8
}

/** 阶梯提成时薪（元/h）：未达当日业绩目标为 0；达到目标奖励 5 元/h，之后每增加 1000 元再加 5 元/h */
export function commissionRate(storeKey, revenue, dateStr, storeName = '') {
  const normKey = normalizeStoreKey(storeKey, storeName)
  const cfg = storePayConfig(normKey)
  const target = normKey === 'tongying' && isHoliday(dateStr) ? cfg.holidayTarget : cfg.target
  const rev = Number(revenue) || 0
  if (rev < target) return 0
  const extra = Math.floor((rev - target) / COMMISSION_STEP)
  return COMMISSION_PER_STEP + extra * COMMISSION_PER_STEP
}

function round2(v) {
  return Math.round(v * 100) / 100
}

/** 计算单个员工某日薪酬：基础薪资 + 业绩提成 */
export function calcDailyPay({ storeKey, storeName, revenue, date, staffCount }) {
  const normKey = normalizeStoreKey(storeKey, storeName)
  const hours = dutyHours(normKey, staffCount)
  const baseRate = Number(staffCount) <= 1 ? BASE_RATE + OVERTIME_SUBSIDY : BASE_RATE
  const basePay = round2(baseRate * hours)
  const rate = commissionRate(normKey, revenue, date)
  const commission = round2(rate * hours)
  return {
    hours,
    baseRate,
    basePay,
    commissionRate: rate,
    commission,
    total: round2(basePay + commission),
  }
}

/**
 * 从业绩录入对象聚合某月每位员工的薪酬。
 * entries 的键格式为「月份|门店Key|MM-DD」，值为 { inc, ord, staff: string[] }。
 * 返回 Map：name -> { name, workedDays, workedRevenue, orders, hours, basePay, commission, salary, stores }
 */
export function monthlyPayrollFromEntries(entries, monthKey, storeNames = {}) {
  const map = new Map()
  let hasAny = false
  for (const [key, v] of Object.entries(entries || {})) {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[0] !== monthKey || parts[1] === 'all') continue
    if (!Array.isArray(v.staff) || v.staff.length === 0) continue
    hasAny = true
    const storeKey = parts[1]
    const day = parts[2]
    const inc = Number(v.inc) || 0
    const ord = Number(v.ord) || 0
    const share = v.staff.length
    const daily = calcDailyPay({
      storeKey,
      storeName: storeNames[storeKey] || '',
      revenue: inc,
      date: `${monthKey}-${day}`,
      staffCount: share,
    })
    for (const name of v.staff) {
      const rec = map.get(name) || {
        name,
        workedDays: 0,
        workedRevenue: 0,
        orders: 0,
        hours: 0,
        basePay: 0,
        commission: 0,
        salary: 0,
        days: new Set(),
        stores: new Set(),
      }
      rec.workedRevenue += inc / share
      rec.orders += ord / share
      rec.hours += daily.hours
      rec.basePay += daily.basePay
      rec.commission += daily.commission
      rec.salary += daily.total
      rec.days.add(day)
      rec.stores.add(storeKey)
      map.set(name, rec)
    }
  }
  if (!hasAny) return new Map()
  for (const rec of map.values()) {
    rec.workedDays = rec.days.size
    delete rec.days
    rec.workedRevenue = round2(rec.workedRevenue)
    rec.orders = round2(rec.orders)
    rec.hours = round2(rec.hours)
    rec.basePay = round2(rec.basePay)
    rec.commission = round2(rec.commission)
    rec.salary = round2(rec.salary)
    rec.stores = [...rec.stores]
  }
  return map
}
