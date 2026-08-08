import { DAILY, PRODUCTS, STORES, MONTHS, EMPLOYEES, EMPLOYEE_MONTHLY, EMPLOYEE_MONTHS } from '../data/reportData.js'
import {
  commitEntries,
  commitStaff,
  commitRemovedStaff,
  getAnalysis,
  getEntries,
  getStaff,
  getRemovedStaff,
  getStores,
  getProducts,
  getDailySales,
  getDishDaily,
  getBigBonuses,
} from './userData.js'
import { formatMoney } from './format.js'
import { en, interpolate } from '../locales'
import { calcDailyPay, monthlyPayrollFromEntries, isNoPayStaff } from './payroll.js'

export { STORES, MONTHS, EMPLOYEES, EMPLOYEE_MONTHLY, EMPLOYEE_MONTHS }

const localize = (lang, key, vars) => interpolate(lang === 'en' ? en[key] || key : key, vars)

export const STORE_KEYS = STORES.map((s) => s.key)
export const ALL_STORES = { key: 'all', name: '全部门店' }

/** day 可能为 '07' 或 '08-07'，统一转成完整日期 YYYY-MM-DD */
function fullDateOf(monthKey, day) {
  const d = String(day || '')
  return d.includes('-') ? `${monthKey}-${d.slice(3)}` : `${monthKey}-${d}`
}

function bigBonusesByName(name) {
  const rows = getBigBonuses()
  return Array.isArray(rows) ? rows.filter((r) => String(r.staffKey || '').endsWith(`::${name}`)) : []
}

/** 员工某日大单奖（元） */
export function bigBonusYuanOn(name, dateStr) {
  const cents = bigBonusesByName(name)
    .filter((r) => String(r.date || '') === dateStr)
    .reduce((s, r) => s + (Number(r.bonusCents) || 0), 0)
  return Math.round((cents / 100) * 100) / 100
}

/** 员工某月大单奖（元） */
export function bigBonusYuanMonth(name, monthKey) {
  const cents = bigBonusesByName(name)
    .filter((r) => String(r.date || '').startsWith(monthKey))
    .reduce((s, r) => s + (Number(r.bonusCents) || 0), 0)
  return Math.round((cents / 100) * 100) / 100
}

export function customStores() {
  return getStores()
}

export function allStores() {
  return [...STORES, ...customStores()]
}

export function allStoreKeys() {
  return allStores().map((s) => s.key)
}

export function storeName(key) {
  if (key === 'all') return '全部门店'
  const s = allStores().find((x) => x.key === key)
  return s ? s.name : key
}

export function monthLabel(key, lang = 'zh') {
  const m = MONTHS.find((x) => x.key === key)
  if (m) {
    if (lang === 'en') {
      const mm = (m.label || '').match(/(\d{1,2})月/)
      const yy = (m.label || '').match(/(\d{4})年/)
      return mm && yy ? `${mm[1]}/${yy[1]}` : m.label
    }
    return m.label
  }
  const [y, mm] = String(key).split('-')
  return mm ? (lang === 'en' ? `${mm}/${y}` : `${y}年${mm}月`) : key
}

export function prevMonthKey(monthKey) {
  const i = MONTHS.findIndex((m) => m.key === monthKey)
  return i > 0 ? MONTHS[i - 1].key : null
}

export function allMonths() {
  const keys = new Set(MONTHS.map((m) => m.key))
  for (const k of getAnalysis().months || []) keys.add(k)
  return [...keys]
    .sort()
    .map((key) => ({ key, label: monthLabel(key) }))
}

export function allEmployeeMonths() {
  const keys = new Set(EMPLOYEE_MONTHS)
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

/** 保存一条门店业绩录入（自动同步到服务端共享数据） */
export function saveLocalEntry(monthKey, storeKey, day, data) {
  const next = { ...getEntries(), [`${monthKey}|${storeKey}|${day}`]: data }
  commitEntries(next)
  return next
}

/** 删除一条门店业绩录入 */
export function deleteLocalEntry(monthKey, storeKey, day) {
  const next = { ...getEntries() }
  delete next[`${monthKey}|${storeKey}|${day}`]
  commitEntries(next)
  return next
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
    for (const row of (getAnalysis().daily || {})[monthKey]?.[k] || (DAILY[monthKey] || {})[k] || []) {
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
  // 美团实时数据（M4）：覆盖当日营业额/订单/渠道，保留手工值班人员
  const sales = getDailySales()
  for (const [k, s] of Object.entries(sales)) {
    const parts = k.split('|')
    if (parts.length !== 3 || parts[0] !== monthKey) continue
    if (storeKey !== 'all' && parts[1] !== storeKey) continue
    let row = map.get(parts[2])
    if (!row) {
      row = { d: parts[2] }
      for (const f of SUM_FIELDS) row[f] = 0
      map.set(parts[2], row)
    }
    row.inc = Number(s.incCents) / 100
    row.ord = Number(s.ord) || 0
    row.meituan = true
    for (const ch of (s.channels || [])) {
      const cents = Number(ch.amountCents) || 0
      if (ch.name === '美团外卖') row.mt = cents / 100
      else if (ch.name === '店内销售') row.inStore = cents / 100
    }
  }
  return [...map.values()].sort((a, b) => a.d.localeCompare(b.d))
}


/** 某月某门店（或全部门店）的汇总指标 */
export function aggregate(monthKey, storeKey) {
  const rows = dailyRows(monthKey, storeKey)
  const agg = { days: rows.length }
  for (const f of SUM_FIELDS) agg[f] = 0
  for (const r of rows) for (const f of SUM_FIELDS) agg[f] += r[f]
  agg.avgOrder = agg.ord > 0 ? agg.inc / agg.ord : 0
  agg.dailyAvg = agg.days > 0 ? agg.inc / agg.days : 0
  return agg
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
export function ranking(monthKey, storeKey, day = null) {
  const rows = []
  const keys = storeKey === 'all' ? allStoreKeys() : [storeKey]
  const pk = prevMonthKey(monthKey)
  for (const k of keys) {
    const cur = day ? dayStats(monthKey, k, day) : aggregate(monthKey, k)
    const prev = pk ? (day ? dayStats(pk, k, day) : aggregate(pk, k)) : null
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
  const rows = day
    ? dailyRows(monthKey, storeKey).filter((r) => r.d === day)
    : dailyRows(monthKey, storeKey)
  const agg = { days: rows.length }
  for (const f of SUM_FIELDS) agg[f] = 0
  for (const r of rows) for (const f of SUM_FIELDS) agg[f] += r[f]
  agg.avgOrder = agg.ord > 0 ? agg.inc / agg.ord : 0
  agg.dailyAvg = agg.days > 0 ? agg.inc / agg.days : 0
  return agg
}

export function kpiCards(monthKey, storeKey, day = null, lang = 'zh') {
  const agg = day ? dayStats(monthKey, storeKey, day) : aggregate(monthKey, storeKey)
  const monthAgg = aggregate(monthKey, storeKey)
  const pk = prevMonthKey(monthKey)
  const prev = pk ? (day ? dayStats(pk, storeKey, day) : aggregate(pk, storeKey)) : null
  const prevMonthAgg = pk ? aggregate(pk, storeKey) : null
  const rows = dailyRows(monthKey, storeKey)
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
      label: localize(lang, '营业收入'),
      value: formatMoney(agg.inc),
      unit: '元',
      prefix: '¥',
      change: pct(agg.inc, prevInc),
      note: day
        ? localize(lang, '当日 {day} · 环比上月同日', { day })
        : localize(lang, '营业 {days} 天 · 日均 ¥{money}', {
            days: agg.days,
            money: formatMoney(agg.dailyAvg),
          }),
      spark: spark((r) => r.inc),
    },
    {
      key: 'orders',
      label: localize(lang, '订单数'),
      value: fmt(agg.ord),
      unit: '单',
      prefix: '',
      change: pct(agg.ord, prevOrd),
      note: localize(lang, '折前营业额 ¥{money}', { money: formatMoney(agg.rev) }),
      spark: spark((r) => r.ord),
    },
    {
      key: 'avgOrder',
      label: localize(lang, '客单价'),
      value: agg.avgOrder.toFixed(2),
      unit: '元',
      prefix: '¥',
      change: pct(agg.avgOrder, prevAvg),
      note: localize(lang, '营业收入 / 订单量'),
      spark: spark((r) => (r.ord ? r.inc / r.ord : 0)),
    },
    {
      key: 'dish',
      label: localize(lang, '菜品销量'),
      value: fmt(agg.dish),
      unit: '份',
      prefix: '',
      change: pct(agg.dish, prevDish),
      note: localize(lang, '菜品销售额 ¥{money}', { money: formatMoney(agg.dishInc) }),
      spark: spark((r) => r.dish),
    },
    {
      key: 'discount',
      label: localize(lang, '优惠金额'),
      value: formatMoney(agg.dis),
      unit: '元',
      prefix: '¥',
      change: pct(agg.dis, prevDis),
      note: localize(lang, '优惠率 {pct}%', {
        pct: agg.rev ? ((agg.dis / agg.rev) * 100).toFixed(1) : 0,
      }),
      spark: spark((r) => r.dis),
    },
    day
      ? {
          key: 'monthTotal',
          label: localize(lang, '本月累计'),
          value: formatMoney(monthAgg.inc),
          unit: '元',
          prefix: '¥',
          change: prevMonthAgg ? changePct(monthAgg.inc, prevMonthAgg.inc) : null,
          note: localize(lang, '{month} 整月汇总', { month: monthLabel(monthKey, lang) }),
          spark: spark((r) => r.inc),
        }
      : {
          key: 'dailyAvg',
          label: localize(lang, '日均营业额'),
          value: formatMoney(agg.dailyAvg),
          unit: '元',
          prefix: '¥',
          change: pct(agg.dailyAvg, prevDaily),
          note: localize(lang, '{month} 汇总', { month: monthLabel(monthKey, lang) }),
          spark: spark((r) => r.inc),
        },
  ]
}
export function channelData(monthKey, storeKey, day = null) {
  const agg = day ? dayStats(monthKey, storeKey, day) : aggregate(monthKey, storeKey)
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

/** 保存员工名单（自动同步到服务端共享数据） */
export function saveLocalStaffList(list) {
  commitStaff(list)
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
    rec.storeKey = top ? top[0] : 'multi'
    rec.storeName = storeName(rec.storeKey)
    delete rec.stores
  }
  return map
}

/** 删除员工：从当前名单移除，并记录到已删除名单（报表员工也生效，历史业绩保留） */
export function removeStaff(name) {
  commitStaff(localStaffList().filter((e) => e.name !== name))
  commitRemovedStaff([...getRemovedStaff().filter((n) => n !== name), name])
}

/** 员工绩效列表（按工资排序，可过滤门店；monthKey 传时按该月薪资数据 + 本地员工） */
export function employeeList(storeKey, monthKey = null) {
  const removed = new Set(getRemovedStaff())
  const source = (
    monthKey != null
      ? analysisEmployeeMonthly(monthKey) || EMPLOYEE_MONTHLY[monthKey] || []
      : analysisEmployees() || EMPLOYEES
  ).filter((e) => !removed.has(e.name))
  const local = localStaffList()
    .map((e) => ({ ...e, local: true }))
    .filter((e) => !removed.has(e.name))
  const base = [...source, ...local]
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
        return {
          ...e,
          workedDays: pr ? pr.workedDays : 0,
          workedRevenue: pr ? pr.workedRevenue : 0,
          orders: pr ? pr.orders : 0,
          hours: pr ? pr.hours : 0,
  salary: pr ? pr.salary + (isNoPayStaff(e.name) ? 0 : bigBonusYuanMonth(e.name, monthKey)) : 0,
          basePay: pr ? pr.basePay : 0,
          commission: pr ? pr.commission : 0,
          perf: pr ? pr.commission : 0,
  big: isNoPayStaff(e.name) ? 0 : bigBonusYuanMonth(e.name, monthKey),
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
        st.storeKey = top ? top[0] : st.storeKey || 'multi'
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
      list = [...merged.values()].filter((e) => storeKey === 'all' || e.storeKey === storeKey)
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
export function entryEmployeePerformance(storeKey = 'all', monthKey = null) {
  const entries = localEntries()
  const map = new Map()
  const payrollMap = monthKey ? entryMonthPayroll(monthKey) : new Map()
  const hasPayroll = monthKey != null && payrollMap.size > 0
  for (const [key, v] of Object.entries(entries)) {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[1] === 'all') continue
    if (monthKey && parts[0] !== monthKey) continue
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
  const infoMap = new Map(employeeList('all').map((e) => [e.name, e]))
  return [...map.values()]
    .map((e) => {
      const info = infoMap.get(e.name)
      const pr = payrollMap.get(e.name)
      const salary = hasPayroll ? (pr ? pr.salary : 0) : info ? info.salary || 0 : 0
      const hours = hasPayroll ? (pr ? pr.hours : 0) : info ? (info.baseHours || 0) + (info.otHours || 0) : 0
      return {
        ...e,
        workedDays: hasPayroll ? (pr ? pr.workedDays : 0) : e.workedDays,
        storeKey: pr ? pr.storeKey : info ? info.storeKey : 'multi',
        storeName: pr ? pr.storeName : info ? info.storeName : '多店支援',
        salary,
        hours,
        commission: hasPayroll ? (pr ? pr.commission : 0) : 0,
        roi: e.workedRevenue > 0 && salary > 0 ? e.workedRevenue / salary : 0,
        workedRevenue: Math.round(e.workedRevenue * 100) / 100,
        orders: Math.round(e.orders * 100) / 100,
      }
    })
    .sort((a, b) => b.workedRevenue - a.workedRevenue)
}

/** 重要提醒（随所选月份动态生成） */
export function notices(monthKey, day = null, lang = 'zh') {
  const out = []
  if (day) {
    const aggDay = dayStats(monthKey, 'all', day)
    out.push({
      tag: '当日',
      tagStyle: 'bg-grape-50 text-grape-600',
      bg: 'bg-grape-100',
      fg: 'text-grape-500',
      time: `${monthLabel(monthKey, lang)} · ${day}`,
      text: localize(lang, '全部门店当日营业收入 ¥{inc}，共 {ord} 单，客单价 ¥{avg}。', {
        inc: formatMoney(aggDay.inc),
        ord: aggDay.ord.toLocaleString('zh-CN'),
        avg: aggDay.avgOrder.toFixed(2),
      }),
    })
  }
  const pk = prevMonthKey(monthKey)
  const aggAll = aggregate(monthKey, 'all')
  const rows = ranking(monthKey, 'all')

  if (rows.length > 0) {
    const leader = rows[0]
    const laggard = rows[rows.length - 1]
    out.push({
      tag: '经营',
      tagStyle: 'bg-budu-50 text-budu-600',
      bg: 'bg-budu-100',
      fg: 'text-budu-500',
      time: `${monthLabel(monthKey, lang)}`,
      text: localize(lang, '「{name}」本月营业收入 ¥{inc}，位列三家门店第一。', {
        name: leader.name,
        inc: leader.income.toLocaleString('zh-CN'),
      }),
    })
    if (laggard.key !== leader.key) {
      out.push({
        tag: '关注',
        tagStyle: 'bg-amber-50 text-amber-600',
        bg: 'bg-amber-100',
        fg: 'text-amber-600',
        time: `${monthLabel(monthKey, lang)}`,
        text: localize(lang, '「{name}」本月营业收入 ¥{inc}，为三家门店中最低，建议复盘菜单与引流。', {
          name: laggard.name,
          inc: laggard.income.toLocaleString('zh-CN'),
        }),
      })
    }
  }

  if (pk) {
    const changes = rows.map((r) => ({ name: r.name, pct: changePct(r.income, aggregate(pk, r.key).inc) }))
    const worst = [...changes].sort((a, b) => a.pct - b.pct)[0]
    if (worst && worst.pct < 0) {
      out.push({
        tag: '预警',
        tagStyle: 'bg-rose-50 text-rose-500',
        bg: 'bg-rose-100',
        fg: 'text-rose-500',
        time: `${monthLabel(pk, lang)} → ${monthLabel(monthKey, lang)}`,
        text: localize(lang, '「{name}」营业收入环比下降 {pct}%，建议关注客流与营销活动。', {
          name: worst.name,
          pct: Math.abs(worst.pct).toFixed(1),
        }),
      })
    } else if (worst) {
      out.push({
        tag: '增长',
        tagStyle: 'bg-emerald-50 text-emerald-600',
        bg: 'bg-emerald-100',
        fg: 'text-emerald-600',
        time: `${monthLabel(pk, lang)} → ${monthLabel(monthKey, lang)}`,
        text: localize(lang, '全部门店营业收入环比增长 {pct}%（三店均值口径）。', {
          pct: `${changes.reduce((s, c) => s + Math.max(c.pct, 0), 0) > 0 ? '+' : ''}${worst.pct.toFixed(1)}`,
        }),
      })
    }
  }

  const payrollPerf = entryMonthPayroll(monthKey)
  let topPerf = null
  if (payrollPerf.size > 0) {
    const top = [...payrollPerf.values()].sort((a, b) => b.commission - a.commission)[0]
    topPerf = top && top.commission > 0 ? { name: top.name, perfValue: top.commission } : null
  } else {
    const t = [...EMPLOYEES].sort((a, b) => b.perf + b.big - (a.perf + a.big))[0]
    topPerf = t && t.perf + t.big > 0 ? { name: t.name, perfValue: t.perf + t.big } : null
  }
  if (topPerf) {
    out.push({
      tag: '绩效',
      tagStyle: 'bg-purple-50 text-purple-600',
      bg: 'bg-purple-100',
      fg: 'text-purple-600',
      time: payrollPerf.size > 0 ? monthLabel(monthKey, lang) : localize(lang, '薪资表 27-31 周'),
      text: localize(lang, '「{name}」业绩提成合计 ¥{amount}，全店最高。', {
        name: topPerf.name,
        amount: topPerf.perfValue.toLocaleString('zh-CN'),
      }),
    })
  }

  out.push({
    tag: '数据',
    tagStyle: 'bg-blue-50 text-blue-600',
    bg: 'bg-blue-100',
    fg: 'text-blue-600',
    time: 'budu OS文档',
    text: localize(lang, '营业数据已更新至 {month}，本月菜品销量 {dish} 份。', {
      month: monthLabel(allMonths()[allMonths().length - 1].key, lang),
      dish: aggAll.dish.toLocaleString('zh-CN'),
    }),
  })

  out.push({
    tag: '系统',
    tagStyle: 'bg-emerald-50 text-emerald-600',
    bg: 'bg-emerald-100',
    fg: 'text-emerald-600',
    time: 'V1.0',
    text: localize(lang, 'budu Operating System V1.0 运行正常，数据由脚本自动从报表生成。'),
  })

  return out.slice(0, 5)
}
/** 菜品销售明细（按所选月份/门店合并，按销售额降序；all 表示跨店同名合并） */
export function products(monthKey, storeKey) {
  const keys = storeKey === 'all' ? allStoreKeys() : [storeKey]
  const map = new Map()
  for (const k of keys) {
    for (const p of (getAnalysis().products || {})[monthKey]?.[k] || (PRODUCTS[monthKey] || {})[k] || []) {
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
  // 美团菜品（M4）：仅合并已映射到系统商品的数据
  const dishMap = new Map()
  for (const d of getDishDaily()) {
    if (!d.productName) continue
    if (d.date.slice(0, 7) !== monthKey) continue
    if (storeKey !== 'all' && d.storeKey !== storeKey) continue
    const key = storeKey === 'all' ? `${d.storeKey}::${d.productName}` : d.productName
    const cur = dishMap.get(key) || {
      name: d.productName,
      storeKey: d.storeKey,
      storeName: storeName(d.storeKey),
      sales: 0,
      amount: 0,
      income: 0,
      discount: 0,
      custom: true,
      meituan: true,
    }
    cur.sales += d.sales
    cur.amount += Number(d.amountCents) / 100
    dishMap.set(key, cur)
  }
  for (const p of dishMap.values()) {
    const key = storeKey === 'all' ? `${p.storeKey}::${p.name}` : p.name
    const existing = map.get(key)
    if (existing && !existing.meituan) {
      existing.sales += p.sales
      existing.amount += p.amount
    } else {
      map.set(key, p)
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
/** 员工在所选日期的值班业绩（本地录入按值班人数均摊） */
export function employeeDayStatus(monthKey, day, name) {
  if (!day) return null
  const entries = localEntries()
  let inc = 0
  let ord = 0
  let count = 0
  let hours = 0
  let basePay = 0
  let commission = 0
  let pay = 0
  const bigBonus = isNoPayStaff(name) ? 0 : bigBonusYuanOn(name, fullDateOf(monthKey, day))
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
      date: `${monthKey}-${day}`,
      staffCount: share,
    })
    inc += (Number(v.inc) || 0) / share
    ord += (Number(v.ord) || 0) / share
    hours += daily.hours
    basePay += daily.basePay
    commission += daily.commission
    pay += daily.total
    count += 1
    stores.push(storeKey)
  }
  if (count === 0) return null
  return {
    inc: Math.round(inc * 100) / 100,
    ord: Math.round(ord * 100) / 100,
    stores,
    hours: Math.round(hours * 100) / 100,
    basePay: Math.round(basePay * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    bigBonus,
    pay: Math.round((basePay + commission + bigBonus) * 100) / 100,
  }
}

/** 员工某日工资组成明细（按门店逐条）：用于「每日工资详情」弹窗与文档下载 */
export function employeeDailyPayDetail(monthKey, day, name) {
  if (!day) return null
  const entries = localEntries()
  const rows = []
  let inc = 0
  let ord = 0
  let hours = 0
  let basePay = 0
  let commission = 0
  let pay = 0
  const dayBonuses = bigBonusesByName(name).filter((r) => String(r.date || '') === fullDateOf(monthKey, day))
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
    if (!Array.isArray(v.staff) || !v.staff.includes(name)) continue
    const storeKey = parts[1]
    const share = v.staff.length
    const noPay = isNoPayStaff(name)
    const daily = calcDailyPay({
      storeKey,
      storeName: storeName(storeKey),
      revenue: Number(v.inc) || 0,
      date: `${monthKey}-${day}`,
      staffCount: share,
    })
    const revShare = (Number(v.inc) || 0) / share
    const ordShare = (Number(v.ord) || 0) / share
    rows.push({
      storeKey,
      storeName: storeName(storeKey),
      revenue: Math.round(revShare * 100) / 100,
      orders: Math.round(ordShare * 100) / 100,
      hours: daily.hours,
      baseRate: daily.baseRate,
      basePay: daily.basePay,
      commissionRate: daily.commissionRate,
      commission: daily.commission,
      bigBonus: 0,
      total: daily.total,
    })
    inc += revShare
    ord += ordShare
    hours += daily.hours
    basePay += noPay ? 0 : daily.basePay
    commission += noPay ? 0 : daily.commission
    pay += noPay ? 0 : daily.total
  }
  if (rows.length === 0) return null
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
  if (isNoPayStaff(name)) {
    for (const row of rows) {
      row.basePay = 0
      row.commission = 0
      row.bigBonus = 0
      row.total = 0
    }
    return {
      rows,
      totals: {
        inc: Math.round(inc * 100) / 100,
        ord: Math.round(ord * 100) / 100,
        hours: Math.round(hours * 100) / 100,
        basePay: 0,
        commission: 0,
        bigBonus: 0,
        pay: 0,
      },
    }
  }
  return {
    rows,
    totals: {
      inc: Math.round(inc * 100) / 100,
      ord: Math.round(ord * 100) / 100,
      hours: Math.round(hours * 100) / 100,
      basePay: Math.round(basePay * 100) / 100,
      commission: Math.round(commission * 100) / 100,
      bigBonus,
      pay: Math.round((basePay + commission + bigBonus) * 100) / 100,
    },
  }
}

/** 员工在指定日期区间（如自然周）的汇总薪酬 */
export function employeeWeekStatus(monthKey, dateList, name) {
  let workedDays = 0
  let hours = 0
  let basePay = 0
  let commission = 0
  let pay = 0
  let inc = 0
  let ord = 0
  const stores = new Set()
  for (const fullDate of dateList) {
    const day = String(fullDate).slice(5)
    const st = employeeDayStatus(monthKey, day, name)
    if (!st) continue
    workedDays += 1
    hours += st.hours
    basePay += st.basePay
    commission += st.commission
    bigBonus += st.bigBonus || 0
    inc += st.inc
    ord += st.ord
    ;(st.stores || []).forEach((s) => stores.add(s))
  }
  if (workedDays === 0) return null
  const r2 = (v) => Math.round(v * 100) / 100
  return {
    workedDays,
    hours: r2(hours),
    basePay: r2(basePay),
    commission: r2(commission),
    bigBonus: r2(bigBonus),
    pay: r2(basePay + commission + bigBonus),
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
