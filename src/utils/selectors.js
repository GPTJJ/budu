import { BASE_STORES } from '../data/baseStores.js'
import { isFixedStoreKey } from '../../shared/storeDirectory.js'
import {
  commitEntries,
  commitStaff,
  getAnalysis,
  getEntries,
  getStaff,
  getStores,
  getProducts,
  getBigBonuses,
  getDailyPayAdjustments,
  getDailyStoreStaff,
  getUserData,
} from './userData.js'
import { formatMoney } from './format.js'
import { t } from './text.js'
import { calcDailyPay, monthlyPayrollFromEntries } from './payroll.js'
import { posDailyMetrics } from './posDaily.js'
import { applyDailyPayOverride } from './dailyPayAdjustment.js'
import { addWeeks, getWeekDays } from './schedule.js'

export const STORE_KEYS = BASE_STORES.map((s) => s.key)
export const ALL_STORES = { key: 'all', name: '全部门店' }

/** day 可能为 '07' 或 '08-07'，统一转成完整日期 YYYY-MM-DD */
function fullDateOf(monthKey, day) {
  const d = String(day || '')
  return d.includes('-') ? `${monthKey}-${d.slice(3)}` : `${monthKey}-${d}`
}

/**
 * Gate 10：大单奖读取（稳定身份优先，legacy 兼容，绝不双计）。
 * - 有 employeeId 的员工：只按 employeeId 精确匹配。legacy NULL 行不得按姓名猜给稳定员工。
 * - 无 employeeId 的调用（历史 payroll 合成员工等）：沿用 legacy endsWith("::"+name) 聚合，
 *   包含 stable 行（其 staffKey 快照仍匹配）与 legacy 行——与旧行为一致。
 */
function bigBonusesByName(name, employeeId) {
  const rows = getBigBonuses()
  const stableId = String(employeeId || '').trim()
  if (stableId) {
    return rows.filter((r) => String(r.employeeId || '').trim() === stableId)
  }
  return rows.filter((r) => String(r.staffKey || '').endsWith(`::${name}`))
}

/** 员工某日大单奖（元） */
export function bigBonusYuanOn(name, dateStr, employeeId) {
  const cents = bigBonusesByName(name, employeeId)
    .filter((r) => String(r.date || '') === dateStr)
    .reduce((s, r) => s + (Number(r.bonusCents) || 0), 0)
  return Math.round((cents / 100) * 100) / 100
}

/** 员工某月大单奖（元） */
export function bigBonusYuanMonth(name, monthKey, employeeId) {
  const cents = bigBonusesByName(name, employeeId)
    .filter((r) => String(r.date || '').startsWith(monthKey))
    .reduce((s, r) => s + (Number(r.bonusCents) || 0), 0)
  return Math.round((cents / 100) * 100) / 100
}

/** Gate 25 澄清：调整查找——有 employeeId 时按稳定身份精确（Gate 9 新行）；无则 legacy name 兼容 */
function dailyPayAdjustmentOn(name, dateStr, employeeId) {
  const rows = getDailyPayAdjustments()
  if (!Array.isArray(rows)) return null
  const stableId = String(employeeId || '').trim()
  if (stableId) {
    // 稳定调整行按 employeeId+date 精确；同店同名两人各自命中自己的调整，绝不交叉
    const stable = rows.find((row) => row.employeeId === stableId && String(row.date || '') === dateStr)
    if (stable) return stable
    return null
  }
  return rows.find((row) => row.staffName === name && String(row.date || '') === dateStr) || null
}

function applyDailyPayAdjustment(name, dateStr, automaticPay, employeeId) {
  const adjustment = dailyPayAdjustmentOn(name, dateStr, employeeId)
  return applyDailyPayOverride(automaticPay, adjustment)
}

export function customStores() {
  return getStores().filter((store) => isFixedStoreKey(store.key))
}

export function allStores() {
  // 门店目录只允许固定四店；PG 可覆盖展示字段，但不能引入新 key。
  const pg = Array.isArray(getUserData().stores)
    ? getUserData().stores.filter((store) => isFixedStoreKey(store.key))
    : []
  return [...new Map([...BASE_STORES, ...pg].map((s) => [s.key, s])).values()]
}

export function allStoreKeys() {
  return allStores().map((s) => s.key)
}

export function storeName(key) {
  if (key === 'all') return '全部门店'
  const s = allStores().find((x) => x.key === key)
  return s ? s.name : key
}

export function monthLabel(key) {
  const [y, mm] = String(key).split('-')
  return mm ? `${y}年${mm}月` : key
}

export function prevMonthKey(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number)
  if (!year || !month) return null
  const date = new Date(year, month - 2, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function sameDayInMonth(day, targetMonth) {
  const date = String(day || '')
  const dayOfMonth = date.includes('-') ? date.slice(-2) : date.padStart(2, '0')
  return `${targetMonth.slice(5)}-${dayOfMonth}`
}

export function allMonths() {
  const keys = new Set()
  for (const k of getAnalysis().months || []) keys.add(k)
  for (const k of Object.keys(getEntries())) {
    const monthKey = k.split('|')[0]
    if (/^\d{4}-\d{2}$/.test(monthKey)) keys.add(monthKey)
  }
  for (const row of getPosDaily()) {
    const monthKey = String(row.date || '').slice(0, 7)
    if (/^\d{4}-\d{2}$/.test(monthKey)) keys.add(monthKey)
  }
  return [...keys]
    .sort()
    .map((key) => ({ key, label: monthLabel(key) }))
}

export function allEmployeeMonths() {
  const keys = new Set()
  for (const k of Object.keys(getAnalysis().employeeMonthly || {})) keys.add(k)
  for (const k of Object.keys(getEntries())) {
    const m = k.split('|')[0]
    if (m) keys.add(m)
  }
  return [...keys].sort()
}

const SUM_FIELDS = [
  'rev', 'inc', 'dis', 'ord', 'dish', 'dishRev', 'dishInc', 'boxFee',
  'inStore', 'mt', 'tb', 'cash', 'wechat', 'alipay', 'union', 'mtPay', 'tbPay',
]
/** 读取门店业绩录入（登录后为服务端共享数据，实时读取保证联动更新） */
export function localEntries() {
  return getEntries()
}

/** POS 门店每日营业汇总（由订单实时计算，缓存于镜像层） */
export function getPosDaily() {
  return Array.isArray(getUserData().posDaily) ? getUserData().posDaily : []
}

/** POS 商品销售汇总（由 order_items 实时计算） */
export function getPosProductSales() {
  return Array.isArray(getUserData().posProductSales) ? getUserData().posProductSales : []
}

/** 保存一条门店业绩录入（自动同步到服务端共享数据；PG 权威，失败显式抛错） */
export function saveLocalEntry(monthKey, storeKey, day, data) {
  const next = { ...getEntries(), [`${monthKey}|${storeKey}|${day}`]: data }
  return commitEntries(next)
}

/** 删除一条门店业绩录入 */
export function deleteLocalEntry(monthKey, storeKey, day) {
  const next = { ...getEntries() }
  delete next[`${monthKey}|${storeKey}|${day}`]
  return commitEntries(next)
}

/** 某月某门店（或全部门店）的每日合并明细 */
export function dailyRows(monthKey, storeKey) {
  const keys = storeKey === 'all' ? allStoreKeys() : [storeKey]
  const map = new Map()
  const entries = localEntries()
  for (const k of keys) {
    const overrides = new Map()
    const prefix = `${monthKey}|${k}|`
    for (const [key, v] of Object.entries(entries)) {
      if (!key.startsWith(prefix)) continue
      overrides.set(key.slice(prefix.length), { inc: Number(v.inc) || 0, ord: Number(v.ord) || 0 })
    }
    for (const row of (getAnalysis().daily || {})[monthKey]?.[k] || []) {
      const ov = overrides.get(row.d)
      let cur = map.get(row.d)
      if (!cur) {
        cur = { d: row.d }
        for (const f of SUM_FIELDS) cur[f] = 0
        map.set(row.d, cur)
      }
      for (const f of SUM_FIELDS) cur[f] += ov && f in ov ? ov[f] : row[f]
      if (ov) cur.local = true
      overrides.delete(row.d)
    }
  for (const [d, ov] of overrides) {
      let cur = map.get(d)
      if (!cur) {
        cur = { d }
        for (const f of SUM_FIELDS) cur[f] = 0
        map.set(d, cur)
      }
      for (const f of SUM_FIELDS) cur[f] += ov[f] || 0
      cur.local = true
    }
  }
  const posDaily = getPosDaily()
  for (const row of posDaily) {
    if (!String(row.date || '').startsWith(monthKey)) continue
    if (storeKey !== 'all' && row.storeKey !== storeKey) continue
    const d = String(row.date).slice(5)
    const { inc, dis, rev, ord } = posDailyMetrics(row)
    if (storeKey === 'all') {
      let cur = map.get(d)
      if (!cur) {
        cur = { d }
        for (const f of SUM_FIELDS) cur[f] = 0
        map.set(d, cur)
      }
      cur.inc += inc
      cur.rev += rev
      cur.dis += dis
      cur.ord += ord
      cur.pos = true
    } else {
      const cur = { d, inc, rev, dis, ord, local: true, pos: true, refundCents: row.refundCents, discountCents: row.discountCents }
      for (const f of SUM_FIELDS) if (!(f in cur)) cur[f] = 0
      map.set(d, cur)
    }
  }
  return [...map.values()].sort((a, b) => a.d.localeCompare(b.d))
}

function aggregateRows(rows) {
  const agg = { days: rows.length }
  for (const f of SUM_FIELDS) agg[f] = 0
  for (const r of rows) for (const f of SUM_FIELDS) agg[f] += Number(r[f]) || 0
  agg.avgOrder = agg.ord > 0 ? agg.inc / agg.ord : 0
  agg.dailyAvg = agg.days > 0 ? agg.inc / agg.days : 0
  return agg
}

/** 当前经营周期包含的完整业务日期；weekStart 优先于 day。 */
export function periodDates(monthKey, day = null, weekStart = null) {
  if (weekStart) return getWeekDays(weekStart).map((item) => item.date)
  if (day) return [fullDateOf(monthKey, day)]
  return dailyRows(monthKey, 'all').map((row) => `${monthKey}-${row.d.slice(3)}`)
}

/** Gate 29F：日/周期间涉及的月份键；跨月周必须同时加载，顺序稳定且不重复。 */
export function payrollPeriodMonths(dateList) {
  const months = []
  const seen = new Set()
  for (const value of Array.isArray(dateList) ? dateList : []) {
    const month = String(value || '').slice(0, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || seen.has(month)) continue
    seen.add(month)
    months.push(month)
  }
  return months
}

/** LEGACY 兼容只允许唯一展示姓名；重名不得猜测金额归属。 */
export function legacyAmbiguousEmployeeNames(employees) {
  const counts = new Map()
  for (const employee of Array.isArray(employees) ? employees : []) {
    const name = String(employee?.name || '')
    if (name) counts.set(name, (counts.get(name) || 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
}

/** 按日/自然周/整月读取每日经营数据；自然周允许跨月。 */
export function periodDailyRows(monthKey, storeKey, day = null, weekStart = null) {
  if (!weekStart) {
    const rows = dailyRows(monthKey, storeKey)
    return (day ? rows.filter((row) => row.d === day) : rows).map((row) => ({
      ...row,
      date: `${monthKey}-${row.d.slice(3)}`,
    }))
  }
  const dates = getWeekDays(weekStart).map((item) => item.date)
  const wanted = new Set(dates)
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))]
  const rows = []
  for (const key of months) {
    for (const row of dailyRows(key, storeKey)) {
      const date = `${key}-${row.d.slice(3)}`
      if (wanted.has(date)) rows.push({ ...row, date })
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export function periodStats(monthKey, storeKey, day = null, weekStart = null) {
  return aggregateRows(periodDailyRows(monthKey, storeKey, day, weekStart))
}


/** 某月某门店（或全部门店）的汇总指标 */
export function aggregate(monthKey, storeKey) {
  return aggregateRows(dailyRows(monthKey, storeKey))
}

export function changePct(cur, prev) {
  if (prev == null || prev === 0) return null
  return ((cur - prev) / prev) * 100
}

export function pctText(pct) {
  if (pct == null) return '—'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/** 门店经营排行（可按单店过滤） */
export function ranking(monthKey, storeKey, day = null, weekStart = null) {
  const rows = []
  const keys = storeKey === 'all' ? allStoreKeys() : [storeKey]
  const pk = prevMonthKey(monthKey)
  for (const k of keys) {
    const cur = periodStats(monthKey, k, day, weekStart)
    const prev = weekStart
      ? periodStats(monthKey, k, null, addWeeks(weekStart, -1))
      : pk
        ? periodStats(pk, k, day ? sameDayInMonth(day, pk) : null, null)
        : null
    const st = allStores().find((s) => s.key === k)
    rows.push({
      key: k,
      name: st ? st.name : k,
      district: st ? st.district : '',
      income: cur.inc,
      orders: cur.ord,
      avgOrder: cur.avgOrder,
      dish: cur.dish,
      dishInc: cur.dishInc,
      change: prev ? changePct(cur.inc, prev.inc) : null,
    })
  }
  rows.sort((a, b) => b.income - a.income)
  return rows
}
/** 按日统计（day 为 'MM-DD' 或 null；null 时统计整月） */
export function dayStats(monthKey, storeKey, day) {
  return periodStats(monthKey, storeKey, day)
}

export function kpiCards(monthKey, storeKey, day = null, weekStart = null) {
  const agg = periodStats(monthKey, storeKey, day, weekStart)
  const monthAgg = aggregate(monthKey, storeKey)
  const pk = prevMonthKey(monthKey)
  const prev = weekStart
    ? periodStats(monthKey, storeKey, null, addWeeks(weekStart, -1))
    : pk
      ? periodStats(pk, storeKey, day ? sameDayInMonth(day, pk) : null)
      : null
  const prevMonthAgg = pk ? aggregate(pk, storeKey) : null
  const rows = weekStart ? periodDailyRows(monthKey, storeKey, null, weekStart) : dailyRows(monthKey, storeKey)
  const spark = (fn) => rows.map((r) => Math.round(fn(r) * 100) / 100)
  const fmt = (n) => n.toLocaleString('zh-CN')
  const pct = (cur, pv) => (prev && pv != null ? changePct(cur, pv) : null)
  const prevInc = prev ? prev.inc : null
  const prevOrd = prev ? prev.ord : null
  const prevAvg = prev ? prev.avgOrder : null
  const prevDish = prev ? prev.dish : null
  const prevDis = prev ? prev.dis : null
  const prevDaily = prev ? prev.dailyAvg : null

  return [
    {
      key: 'income',
      label: t('营业收入'),
      value: formatMoney(agg.inc),
      unit: '元',
      prefix: '¥',
      change: pct(agg.inc, prevInc),
      note: weekStart
        ? t('自然周 {start} 起 · 对比上一自然周', { start: weekStart })
        : day
        ? t('当日 {day} · 环比上月同日', { day })
        : t('营业 {days} 天 · 日均 ¥{money}', {
            days: agg.days,
            money: formatMoney(agg.dailyAvg),
          }),
      spark: spark((r) => r.inc),
    },
    {
      key: 'orders',
      label: t('订单数'),
      value: fmt(agg.ord),
      unit: '单',
      prefix: '',
      change: pct(agg.ord, prevOrd),
      note: t('折前营业额 ¥{money}', { money: formatMoney(agg.rev) }),
      spark: spark((r) => r.ord),
    },
    {
      key: 'avgOrder',
      label: t('客单价'),
      value: agg.avgOrder.toFixed(2),
      unit: '元',
      prefix: '¥',
      change: pct(agg.avgOrder, prevAvg),
      note: t('营业收入 / 订单量'),
      spark: spark((r) => (r.ord ? r.inc / r.ord : 0)),
    },
    {
      key: 'dish',
      label: t('商品销量'),
      value: fmt(agg.dish),
      unit: '份',
      prefix: '',
      change: pct(agg.dish, prevDish),
      note: t('菜品销售额 ¥{money}', { money: formatMoney(agg.dishInc) }),
      spark: spark((r) => r.dish),
    },
    {
      key: 'discount',
      label: t('优惠金额'),
      value: formatMoney(agg.dis),
      unit: '元',
      prefix: '¥',
      change: pct(agg.dis, prevDis),
      note: t('优惠率 {pct}%', {
        pct: agg.rev ? ((agg.dis / agg.rev) * 100).toFixed(1) : 0,
      }),
      spark: spark((r) => r.dis),
    },
    day || weekStart
      ? {
          key: 'monthTotal',
          label: t('本月累计'),
          value: formatMoney(monthAgg.inc),
          unit: '元',
          prefix: '¥',
          change: prevMonthAgg ? changePct(monthAgg.inc, prevMonthAgg.inc) : null,
          note: t('{month} 整月汇总', { month: monthLabel(monthKey) }),
          spark: spark((r) => r.inc),
        }
      : {
          key: 'dailyAvg',
          label: t('日均营业额'),
          value: formatMoney(agg.dailyAvg),
          unit: '元',
          prefix: '¥',
          change: pct(agg.dailyAvg, prevDaily),
          note: t('{month} 汇总', { month: monthLabel(monthKey) }),
          spark: spark((r) => r.inc),
        },
  ]
}
export function channelData(monthKey, storeKey, day = null, weekStart = null) {
  const agg = periodStats(monthKey, storeKey, day, weekStart)
  return [
    { name: '店内销售', value: agg.inStore, color: '#A855F7' },
    { name: '美团外卖', value: agg.mt, color: '#F472B6' },
    { name: '淘宝闪购', value: agg.tb, color: '#FBBF24' },
  ]
}
/** 读取员工名单（登录后为服务端共享数据） */
export function localStaffList() {
  return getStaff()
}

/**
 * Gate 12：读取按月加载的 DailyStoreStaff 稳定考勤行（数据基础，尚未参与 payroll 计算）。
 * month 传 'YYYY-MM' 过滤；不传返回全部已加载行。同一员工/同名员工按行独立保留（id 身份）。
 */
export function dailyStoreStaffRows(month) {
  return getDailyStoreStaff(month)
}

/**
 * 当前员工目录（Gate 7）：PostgreSQL employees 的当前在册名单，
 * 以 Employee.id 为稳定对象身份，不按姓名折叠——重名员工（跨店或同店）
 * 各自保留独立条目。仅作当前目录展示/操作的数据源；
 * 历史 payroll 聚合仍走 employeeList（按姓名快照，语义不变）。
 */
export function currentEmployeeDirectory(storeKey = 'all') {
  const list = localStaffList()
    .map((e) => ({ ...e, local: true }))
    .filter((e) => isFixedStoreKey(e.storeKey))
  return storeKey === 'all' ? list : list.filter((e) => e.storeKey === storeKey)
}

/** 保存员工名单（自动同步到服务端共享数据） */
export function saveLocalStaffList(list) {
  return commitStaff(list)
}

export function analysisEmployees() {
  const list = getAnalysis().employees
  return Array.isArray(list) && list.length > 0 ? list : null
}

export function analysisEmployeeMonthly(monthKey) {
  const list = (getAnalysis().employeeMonthly || {})[monthKey]
  return Array.isArray(list) && list.length > 0 ? list : null
}

/** 某月员工出勤/营业额统计（根据门店业绩录入实时聚合：按天去重、营业额按值班人数均摊） */
export function entryMonthStats(monthKey) {
  const entries = localEntries()
  const map = new Map()
  for (const [key, v] of Object.entries(entries)) {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[0] !== monthKey || parts[1] === 'all') continue
    if (!Array.isArray(v.staff) || v.staff.length === 0) continue
    const inc = Number(v.inc) || 0
    const ord = Number(v.ord) || 0
    const share = v.staff.length
    for (const name of v.staff) {
      const rec = map.get(name) || {
        name,
        workedDays: 0,
        workedRevenue: 0,
        orders: 0,
        days: new Set(),
        stores: new Set(),
      }
      rec.workedRevenue += inc / share
      rec.orders += ord / share
      rec.days.add(parts[2])
      rec.stores.add(parts[1])
      map.set(name, rec)
    }
  }
  for (const rec of map.values()) {
    rec.workedDays = rec.days.size
    delete rec.days
    rec.stores = [...rec.stores]
  }
  return map
}

/** 某月每位员工的薪酬（根据每日业绩录入自动计算：基础工资 + 业绩阶梯提成） */
export function entryMonthPayroll(monthKey) {
  const storeNames = {}
  for (const s of allStores()) storeNames[s.key] = s.name
  const map = monthlyPayrollFromEntries(localEntries(), monthKey, storeNames)
  for (const rec of map.values()) {
    const freq = {}
    for (const k of rec.stores) freq[k] = (freq[k] || 0) + 1
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
    rec.storeKey = top && isFixedStoreKey(top[0]) ? top[0] : ''
    rec.storeName = storeName(rec.storeKey)
    delete rec.stores
  }
  return map
}

/** 删除员工：从 PG 当前名单移除，由 Employee.status 记录离职状态；历史业绩保留。 */
export async function removeStaff(name) {
  const next = localStaffList().filter((e) => e.name !== name)
  await commitStaff(next)
}

function monthPayAdjustmentSummary(name, monthKey) {
  const rows = getDailyPayAdjustments().filter(
    (row) => row.staffName === name && String(row.date || '').startsWith(monthKey),
  )
  let delta = 0
  const details = []
  for (const row of rows) {
    const date = String(row.date || '')
    const automatic = automaticEmployeeDayStatus(date.slice(0, 7), date.slice(5), name)
    const applied = applyDailyPayAdjustment(name, date, automatic?.pay || 0)
    delta += applied.salaryAdjustment
    details.push({ date, ...applied })
  }
  return {
    delta: Math.round(delta * 100) / 100,
    count: details.length,
    details,
  }
}

/** 员工绩效列表（按工资排序，可过滤门店；monthKey 传时按该月薪资数据 + 本地员工） */
export function employeeList(storeKey, monthKey = null) {
  const local = localStaffList()
    .map((e) => ({ ...e, local: true }))
    .filter((e) => isFixedStoreKey(e.storeKey))
  // 当前人员目录只读取 PostgreSQL employees；历史月份仍可由当月业绩记录补出姓名。
  const base = [...new Map(local.map((e) => [e.name, e])).values()]
  let list = base.filter((e) => storeKey === 'all' || e.storeKey === storeKey)
  if (monthKey != null) {
    const payroll = entryMonthPayroll(monthKey)
    if (payroll.size > 0) {
      // 有业绩录入的月份：出勤/营业额/工时/薪酬全部按录入自动计算
      const infoMap = new Map(base.map((e) => [e.name, e]))
      const merged = new Map(base.map((e) => [e.name, { ...e }]))
      for (const st of payroll.values()) {
        if (!merged.has(st.name)) {
          const info = infoMap.get(st.name) || {
            name: st.name,
            type: 'parttime',
            storeKey: st.storeKey,
            storeName: st.storeName,
            salary: 0,
            baseHours: 0,
            otHours: 0,
            otPay: 0,
            perf: 0,
            big: 0,
            workedRevenue: 0,
            workedDays: 0,
            achieve: 0,
            duty: 0,
            review: 0,
            local: true,
          }
          merged.set(st.name, { ...info, ...st, local: true })
        } else {
          merged.set(st.name, { ...merged.get(st.name), ...st })
        }
      }
      list = [...merged.values()].filter((e) => storeKey === 'all' || e.storeKey === storeKey)
      list = list.map((e) => {
        const pr = payroll.get(e.name)
        const bigBonus = pr ? bigBonusYuanMonth(e.name, monthKey, e.id) : 0
        const automaticSalary = pr ? Math.round((pr.salary + bigBonus) * 100) / 100 : 0
        const adjustments = monthPayAdjustmentSummary(e.name, monthKey)
        return {
          ...e,
          workedDays: pr ? pr.workedDays : 0,
          workedRevenue: pr ? pr.workedRevenue : 0,
          orders: pr ? pr.orders : 0,
          hours: pr ? pr.hours : 0,
          automaticSalary,
          salaryAdjustment: adjustments.delta,
          adjustmentCount: adjustments.count,
          salary: Math.round((automaticSalary + adjustments.delta) * 100) / 100,
          basePay: pr ? pr.basePay : 0,
          commission: pr ? pr.commission : 0,
          transferSubsidy: pr ? pr.transferSubsidy : 0,
          perf: pr ? pr.commission : 0,
          big: bigBonus,
          payrollComputed: true,
        }
      })
    } else {
      // 无录入月份：沿用上传的薪资表 + 本地员工
      const entryStats = entryMonthStats(monthKey)
      for (const st of entryStats.values()) {
        const freq = {}
        for (const k of st.stores) freq[k] = (freq[k] || 0) + 1
        const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
        st.storeKey = top && isFixedStoreKey(top[0]) ? top[0] : (isFixedStoreKey(st.storeKey) ? st.storeKey : '')
        st.storeName = storeName(st.storeKey)
        delete st.stores
      }
      const infoMap = new Map(base.map((e) => [e.name, e]))
      const merged = new Map(base.map((e) => [e.name, { ...e, ...(entryStats.get(e.name) || {}) }]))
      for (const st of entryStats.values()) {
        if (!merged.has(st.name)) {
          const info = infoMap.get(st.name) || {
            name: st.name,
            type: 'parttime',
            salary: 0,
            baseHours: 0,
            otHours: 0,
            otPay: 0,
            perf: 0,
            big: 0,
            workedRevenue: 0,
            workedDays: 0,
            achieve: 0,
            duty: 0,
            review: 0,
            local: true,
          }
          merged.set(st.name, { ...info, ...st, local: true })
        }
      }
      list = [...merged.values()]
        .filter((e) => storeKey === 'all' || e.storeKey === storeKey)
        .map((e) => {
          const adjustments = monthPayAdjustmentSummary(e.name, monthKey)
          const automaticSalary = Number(e.salary) || 0
          return {
            ...e,
            automaticSalary,
            salaryAdjustment: adjustments.delta,
            adjustmentCount: adjustments.count,
            salary: Math.round((automaticSalary + adjustments.delta) * 100) / 100,
          }
        })
    }
  }
  return list
    .map((e) => ({
      ...e,
      hours: e.payrollComputed ? e.hours : (e.baseHours || 0) + (e.otHours || 0),
      roi: e.salary > 0 ? e.workedRevenue / e.salary : 0,
    }))
    .sort((a, b) => b.salary - a.salary)
}

/** 员工绩效（根据每日门店业绩录入实时分析：营业额/订单按值班人数均摊） */
export function entryEmployeePerformance(storeKey = 'all', monthKey = null, day = null, weekStart = null) {
  const entries = localEntries()
  const map = new Map()
  const selectedDates = day || weekStart ? new Set(periodDates(monthKey, day, weekStart)) : null
  const payrollMap = monthKey && !selectedDates ? entryMonthPayroll(monthKey) : new Map()
  const hasPayroll = monthKey != null && payrollMap.size > 0
  for (const [key, v] of Object.entries(entries)) {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[1] === 'all') continue
    if (monthKey && !selectedDates && parts[0] !== monthKey) continue
    const fullDate = `${parts[0]}-${parts[2].slice(3)}`
    if (selectedDates && !selectedDates.has(fullDate)) continue
    if (storeKey !== 'all' && parts[1] !== storeKey) continue
    if (!Array.isArray(v.staff) || v.staff.length === 0) continue
    const inc = Number(v.inc) || 0
    const ord = Number(v.ord) || 0
    const share = v.staff.length
    for (const name of v.staff) {
      const rec = map.get(name) || { name, workedRevenue: 0, orders: 0, workedDays: 0 }
      rec.workedRevenue += inc / share
      rec.orders += ord / share
      rec.workedDays += 1
      map.set(name, rec)
    }
  }
  const infoMap = new Map(employeeList('all', hasPayroll ? monthKey : null).map((e) => [e.name, e]))
  return [...map.values()]
    .map((e) => {
      const info = infoMap.get(e.name)
      const pr = payrollMap.get(e.name)
      const periodPay = selectedDates
        ? [...selectedDates].reduce(
            (sum, date) => {
              const status = employeeDayStatus(date.slice(0, 7), date.slice(5), e.name)
              if (status) {
                sum.salary += status.pay || 0
                sum.hours += status.hours || 0
                sum.commission += status.commission || 0
              }
              return sum
            },
            { salary: 0, hours: 0, commission: 0 },
          )
        : null
      const salary = periodPay
        ? periodPay.salary
        : hasPayroll
          ? info?.salary || 0
          : info?.salary || 0
      const hours = periodPay
        ? periodPay.hours
        : hasPayroll
          ? info?.hours || 0
          : info
            ? (info.baseHours || 0) + (info.otHours || 0)
            : 0
      return {
        ...e,
        workedDays: hasPayroll ? (pr ? pr.workedDays : 0) : e.workedDays,
        storeKey: pr ? pr.storeKey : info ? info.storeKey : '',
        storeName: pr ? pr.storeName : info ? info.storeName : '',
        salary,
        hours,
        commission: periodPay ? periodPay.commission : hasPayroll ? (pr ? pr.commission : 0) : 0,
        roi: e.workedRevenue > 0 && salary > 0 ? e.workedRevenue / salary : 0,
        workedRevenue: Math.round(e.workedRevenue * 100) / 100,
        orders: Math.round(e.orders * 100) / 100,
      }
    })
    .sort((a, b) => b.workedRevenue - a.workedRevenue)
}

/** 菜品销售明细（按所选月份/门店合并，按销售额降序；all 表示跨店同名合并） */
export function products(monthKey, storeKey, day = null, weekStart = null) {
  const keys = storeKey === 'all' ? allStoreKeys() : [storeKey]
  const map = new Map()
  const selectedDates = day || weekStart ? new Set(periodDates(monthKey, day, weekStart)) : null
  if (!selectedDates) {
    for (const k of keys) {
      for (const p of (getAnalysis().products || {})[monthKey]?.[k] || []) {
        let cur = map.get(p.name)
        if (!cur) {
          cur = { name: p.name, sales: 0, amount: 0, income: 0, discount: 0 }
          map.set(p.name, cur)
        }
        cur.sales += p.sales
        cur.amount += p.amount
        cur.income += p.income
        cur.discount += p.discount
      }
    }
    // 自定义商品：按门店独立展示；单店视图下同名商品覆盖报表商品
    for (const p of getProducts()) {
      if (storeKey !== 'all' && p.storeKey !== storeKey) continue
      const key = storeKey === 'all' ? `${p.storeKey}::${p.name}` : p.name
      map.set(key, {
        id: p.id,
        name: p.name,
        storeKey: p.storeKey,
        storeName: storeName(p.storeKey),
        price: p.price || 0,
        note: p.note || '',
        sales: 0,
        amount: 0,
        income: 0,
        discount: 0,
        custom: true,
      })
    }
  }
  for (const row of getPosProductSales()) {
    const rowDate = String(row.date || '').slice(0, 10)
    if (selectedDates ? !selectedDates.has(rowDate) : !rowDate.startsWith(monthKey)) continue
    if (storeKey !== 'all' && row.storeKey !== storeKey) continue
    const amount = Number(row.amountCents) / 100
    const cur = map.get(row.name)
    if (cur) {
      cur.sales += row.quantity
      cur.amount += amount
      cur.income += amount
    } else {
      map.set(row.name, {
        name: row.name,
        sku: row.sku,
        sales: row.quantity,
        amount,
        income: amount,
        discount: 0,
        pos: true,
        storeKey: row.storeKey,
        storeName: storeName(row.storeKey),
      })
    }
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

/** 菜品明细汇总（数量/销售额/收入/优惠/菜品数） */
export function productSummary(monthKey, storeKey) {
  const list = products(monthKey, storeKey)
  const agg = { count: list.length, sales: 0, amount: 0, income: 0, discount: 0 }
  for (const p of list) {
    agg.sales += p.sales
    agg.amount += p.amount
    agg.income += p.income
    agg.discount += p.discount
  }
  return agg
}
/** 门店经营明细（全部月份 x 门店，按月份倒序、收入降序） */
export function storeDetails(storeKey) {
  const rows = []
  const keys = storeKey === 'all' ? allStoreKeys() : [storeKey]
  for (const m of allMonths()) {
    const pk = prevMonthKey(m.key)
    for (const k of keys) {
      const agg = aggregate(m.key, k)
      const prev = pk ? aggregate(pk, k) : null
      const st = allStores().find((s) => s.key === k)
      rows.push({
        monthKey: m.key,
        month: m.label,
        key: k,
        name: st ? st.name : k,
        district: st ? st.district : '',
        inc: agg.inc,
        rev: agg.rev,
        dis: agg.dis,
        ord: agg.ord,
        avgOrder: agg.avgOrder,
        dish: agg.dish,
        days: agg.days,
        change: prev ? changePct(agg.inc, prev.inc) : null,
      })
    }
  }
  rows.sort((a, b) => b.monthKey.localeCompare(a.monthKey) || b.inc - a.inc)
  return rows
}
/** 按雇佣类型筛选员工（fulltime 全职 / parttime 兼职） */
export function employeesByType(type, monthKey = null) {
  return employeeList('all', monthKey).filter((e) => e.type === type)
}
/** 不含人工覆盖的员工当日自动工资，供日/周/月统一计算。employeeId 可选：传入时大单奖按稳定身份读取。 */
function automaticEmployeeDayStatus(monthKey, day, name, employeeId) {
  if (!day) return null
  const entries = localEntries()
  let inc = 0
  let ord = 0
  let count = 0
  let hours = 0
  let basePay = 0
  let commission = 0
  let transferSubsidy = 0
  const bigBonus = bigBonusYuanOn(name, fullDateOf(monthKey, day), employeeId)
  const stores = []
  for (const [k, v] of Object.entries(entries)) {
    const parts = k.split('|')
    if (parts.length !== 3 || parts[0] !== monthKey || parts[1] === 'all' || parts[2] !== day) continue
    if (!Array.isArray(v.staff) || !v.staff.includes(name)) continue
    const storeKey = parts[1]
    const share = v.staff.length
    const daily = calcDailyPay({
      storeKey,
      storeName: storeName(storeKey),
      revenue: Number(v.inc) || 0,
      date: fullDateOf(monthKey, day),
      staffCount: share,
    })
    inc += (Number(v.inc) || 0) / share
    ord += (Number(v.ord) || 0) / share
    hours += daily.hours
    basePay += daily.basePay
    commission += daily.commission
    transferSubsidy += daily.transferSubsidy
    count += 1
    stores.push(storeKey)
  }
  if (count === 0) return null
  const automaticPay = Math.round((basePay + commission + transferSubsidy + bigBonus) * 100) / 100
  return {
    inc: Math.round(inc * 100) / 100,
    ord: Math.round(ord * 100) / 100,
    stores,
    hours: Math.round(hours * 100) / 100,
    basePay: Math.round(basePay * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    transferSubsidy: Math.round(transferSubsidy * 100) / 100,
    bigBonus,
    pay: automaticPay,
  }
}

/** 员工在所选日期的值班业绩；开发者人工调整时以调整后的最终工资为准。employeeId 可选（大单奖稳定身份）。 */
export function employeeDayStatus(monthKey, day, name, employeeId, attendanceRows) {
  const stableId = String(employeeId || '').trim()
  if (stableId) {
    const detail = employeeDailyPayDetail(monthKey, day, name, stableId, Array.isArray(attendanceRows) ? attendanceRows : [])
    if (!detail) return null
    return {
      inc: detail.totals.inc,
      ord: detail.totals.ord,
      stores: detail.rows.map((row) => row.storeKey),
      hours: detail.totals.hours,
      basePay: detail.totals.basePay,
      commission: detail.totals.commission,
      transferSubsidy: detail.totals.transferSubsidy,
      bigBonus: detail.totals.bigBonus,
      adjustmentOnly: detail.rows.length === 0,
      automaticPay: detail.totals.automaticPay,
      salaryAdjustment: detail.totals.salaryAdjustment,
      payAdjustment: detail.totals.payAdjustment,
      adjustmentCount: detail.totals.payAdjustment ? 1 : 0,
      pay: detail.totals.pay,
    }
  }
  const automatic = automaticEmployeeDayStatus(monthKey, day, name, employeeId)
  const date = fullDateOf(monthKey, day)
  const adjustment = dailyPayAdjustmentOn(name, date, employeeId)
  if (!automatic && !adjustment) return null
  const base = automatic || { inc: 0, ord: 0, stores: [], hours: 0, basePay: 0, commission: 0, transferSubsidy: 0, bigBonus: 0, pay: 0 }
  return {
    ...base,
    adjustmentOnly: !automatic,
    ...applyDailyPayOverride(base.pay, adjustment),
  }
}

/**
 * 员工某日工资组成明细（按门店逐条）：用于「每日工资详情」弹窗与文档下载。
 * employeeId 可选（大单奖稳定身份）。
 * Gate 25 澄清（工时身份）：attendanceRows 可选——传入时（EMPLOYEE_ID 导出明细路径），
 * 每门店行的工时 = DailyStoreStaff.actualHours（按 employeeId+date+storeId 精确），
 * 金额与月汇总复用 calcDailyPay 的同一稳定工时合同，不在明细层二次计算；
 * 该员工当日该店无稳定考勤行 → 不生成该门店行（同名绝不制造考勤/工时）。
 * 未传 attendanceRows 的调用（legacy、弹窗等）保持原公式工时口径，行为逐字节不变。
 */
export function employeeDailyPayDetail(monthKey, day, name, employeeId, attendanceRows) {
  if (!day) return null
  const entries = localEntries()
  const rows = []
  let inc = 0
  let ord = 0
  let hours = 0
  let basePay = 0
  let commission = 0
  let transferSubsidy = 0
  const stableId = String(employeeId || '').trim()
  const strictAttendance = Boolean(stableId)
  const stableAttendanceRows = Array.isArray(attendanceRows) ? attendanceRows : []
  const attendanceByStore = new Map()
  const participantCountByStore = new Map()
  if (strictAttendance) {
    const fullDate = fullDateOf(monthKey, day)
    for (const a of stableAttendanceRows) {
      if (String(a.date || '').slice(0, 10) !== fullDate) continue
      const attendanceStore = String(a.storeId || a.storeKey || '')
      if (!attendanceStore || !String(a.employeeId || '').trim()) continue
      participantCountByStore.set(attendanceStore, (participantCountByStore.get(attendanceStore) || 0) + 1)
      if (String(a.employeeId || '') === stableId) attendanceByStore.set(attendanceStore, a)
    }
  }
  const dayBonuses = bigBonusesByName(name, employeeId).filter((r) => String(r.date || '') === fullDateOf(monthKey, day))
  const bonusByStore = new Map()
  let bonusTotalCents = 0
  for (const r of dayBonuses) {
    const c = Number(r.bonusCents) || 0
    bonusTotalCents += c
    bonusByStore.set(r.storeKey, (bonusByStore.get(r.storeKey) || 0) + c)
  }
  for (const [k, v] of Object.entries(entries)) {
    const parts = k.split('|')
    if (parts.length !== 3 || parts[0] !== monthKey || parts[1] === 'all' || parts[2] !== day) continue
    if (!Array.isArray(v.staff)) continue
    const storeKey = parts[1]
    // Gate 25 澄清：稳定模式该员工当日该店无考勤行 → 不生成该门店行（同名不制造考勤）
    if (strictAttendance && !attendanceByStore.has(storeKey)) continue
    if (!strictAttendance && !v.staff.includes(name)) continue
    const share = strictAttendance ? participantCountByStore.get(storeKey) || 0 : v.staff.length
    if (share <= 0) continue
    const att = strictAttendance ? attendanceByStore.get(storeKey) : null
    const daily = calcDailyPay({
      storeKey,
      storeName: storeName(storeKey),
      revenue: Number(v.inc) || 0,
      date: fullDateOf(monthKey, day),
      staffCount: share,
      ...(att ? { payableHours: att.actualHours } : {}),
    })
    // 稳定模式由 calcDailyPay 消费精确 actualHours；legacy 未传 payableHours，继续使用 dutyHours。
    const rowHours = daily.hours
    const rowBasePay = daily.basePay
    const rowCommission = daily.commission
    const rowSubsidy = daily.transferSubsidy
    const revShare = (Number(v.inc) || 0) / share
    const ordShare = (Number(v.ord) || 0) / share
    rows.push({
      storeKey,
      storeName: storeName(storeKey),
      revenue: Math.round(revShare * 100) / 100,
      orders: Math.round(ordShare * 100) / 100,
      hours: rowHours,
      baseRate: daily.baseRate,
      basePay: rowBasePay,
      commissionRate: daily.commissionRate,
      commission: rowCommission,
      transferSubsidyRate: daily.transferSubsidyRate,
      transferSubsidy: rowSubsidy,
      bigBonus: 0,
      total: daily.total,
    })
    inc += revShare
    ord += ordShare
    hours += rowHours
    basePay += rowBasePay
    commission += rowCommission
    transferSubsidy += rowSubsidy
  }
  if (rows.length === 0) {
    const adjustment = dailyPayAdjustmentOn(name, fullDateOf(monthKey, day), employeeId)
    if (!adjustment) return null
    return {
      rows: [],
      totals: {
        inc: 0, ord: 0, hours: 0, basePay: 0, commission: 0, transferSubsidy: 0, bigBonus: 0,
        ...applyDailyPayOverride(0, adjustment),
      },
    }
  }
  let assignedCents = 0
  for (const row of rows) {
    const c = bonusByStore.get(row.storeKey) || 0
    if (c > 0) {
      row.bigBonus = Math.round((c / 100) * 100) / 100
      row.total = Math.round((row.total + row.bigBonus) * 100) / 100
      assignedCents += c
    }
  }
  if (assignedCents < bonusTotalCents) {
    const extra = Math.round(((bonusTotalCents - assignedCents) / 100) * 100) / 100
    rows[0].bigBonus = Math.round((rows[0].bigBonus + extra) * 100) / 100
    rows[0].total = Math.round((rows[0].total + extra) * 100) / 100
  }
  const bigBonus = Math.round((bonusTotalCents / 100) * 100) / 100
  const automaticPay = Math.round((basePay + commission + transferSubsidy + bigBonus) * 100) / 100
  const applied = applyDailyPayAdjustment(name, fullDateOf(monthKey, day), automaticPay, employeeId)
  return {
    rows,
    totals: {
      inc: Math.round(inc * 100) / 100,
      ord: Math.round(ord * 100) / 100,
      hours: Math.round(hours * 100) / 100,
      basePay: Math.round(basePay * 100) / 100,
      commission: Math.round(commission * 100) / 100,
      transferSubsidy: Math.round(transferSubsidy * 100) / 100,
      bigBonus,
      ...applied,
    },
  }
}

/** 员工在指定日期区间（如自然周）的汇总薪酬。employeeId 可选（大单奖稳定身份）。 */
export function employeeWeekStatus(monthKey, dateList, name, employeeId, attendanceRows) {
  let includedDays = 0
  let workedDays = 0
  let hours = 0
  let basePay = 0
  let commission = 0
  let transferSubsidy = 0
  let bigBonus = 0
  let automaticPay = 0
  let salaryAdjustment = 0
  let adjustmentCount = 0
  let inc = 0
  let ord = 0
  const stores = new Set()
  for (const fullDate of dateList) {
    const dateStr = String(fullDate)
    // 自然周可能跨月（如 8.31-9.6），按每个日期的真实月份查业绩
    const st = employeeDayStatus(dateStr.slice(0, 7), dateStr.slice(5), name, employeeId, attendanceRows)
    if (!st) continue
    includedDays += 1
    if (!st.adjustmentOnly) workedDays += 1
    hours += st.hours
    basePay += st.basePay
    commission += st.commission
    transferSubsidy += st.transferSubsidy || 0
    bigBonus += st.bigBonus || 0
    automaticPay += st.automaticPay ?? st.pay
    salaryAdjustment += st.salaryAdjustment || 0
    if (st.payAdjustment) adjustmentCount += 1
    inc += st.inc
    ord += st.ord
    ;(st.stores || []).forEach((s) => stores.add(s))
  }
  if (includedDays === 0) return null
  const r2 = (v) => Math.round(v * 100) / 100
  return {
    workedDays,
    adjustmentOnly: workedDays === 0,
    hours: r2(hours),
    basePay: r2(basePay),
    commission: r2(commission),
    transferSubsidy: r2(transferSubsidy),
    bigBonus: r2(bigBonus),
    automaticPay: r2(automaticPay),
    salaryAdjustment: r2(salaryAdjustment),
    adjustmentCount,
    pay: r2(automaticPay + salaryAdjustment),
    inc: r2(inc),
    ord: r2(ord),
    stores: [...stores],
  }
}

/** 所选日期是否有本地业绩录入（任意门店） */
export function hasLocalEntry(monthKey, day) {
  if (!day) return false
  return Object.keys(localEntries()).some((k) => {
    const parts = k.split('|')
    return parts.length === 3 && parts[0] === monthKey && parts[2] === day
  })
}
