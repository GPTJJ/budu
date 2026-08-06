import { DAILY, PRODUCTS, STORES, MONTHS, EMPLOYEES, EMPLOYEE_MONTHLY, EMPLOYEE_MONTHS } from '../data/reportData.js'
import { commitEntries, commitStaff, commitRemovedStaff, getEntries, getStaff, getRemovedStaff } from './userData.js'
import { formatMoney } from './format.js'
import { en, interpolate } from '../locales'

export { STORES, MONTHS, EMPLOYEES, EMPLOYEE_MONTHLY, EMPLOYEE_MONTHS }

const localize = (lang, key, vars) => interpolate(lang === 'en' ? en[key] || key : key, vars)

export const STORE_KEYS = STORES.map((s) => s.key)
export const ALL_STORES = { key: 'all', name: '全部门店' }

export function storeName(key) {
  if (key === 'all') return '全部门店'
  const s = STORES.find((x) => x.key === key)
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
  const keys = storeKey === 'all' ? STORE_KEYS : [storeKey]
  const map = new Map()
  const entries = localEntries()
  for (const k of keys) {
    const overrides = new Map()
    const prefix = `${monthKey}|${k}|`
    for (const [key, v] of Object.entries(entries)) {
      if (!key.startsWith(prefix)) continue
      overrides.set(key.slice(prefix.length), { inc: Number(v.inc) || 0, ord: Number(v.ord) || 0 })
    }
    for (const row of (DAILY[monthKey] || {})[k] || []) {
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
  const keys = storeKey === 'all' ? STORE_KEYS : [storeKey]
  const pk = prevMonthKey(monthKey)
  for (const k of keys) {
    const cur = day ? dayStats(monthKey, k, day) : aggregate(monthKey, k)
    const prev = pk ? (day ? dayStats(pk, k, day) : aggregate(pk, k)) : null
    const st = STORES.find((s) => s.key === k)
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

/** 删除员工：从当前名单移除，并记录到已删除名单（报表员工也生效，历史业绩保留） */
export function removeStaff(name) {
  commitStaff(localStaffList().filter((e) => e.name !== name))
  commitRemovedStaff([...getRemovedStaff().filter((n) => n !== name), name])
}

/** 员工绩效列表（按工资排序，可过滤门店；monthKey 传时按该月薪资数据 + 本地员工） */
export function employeeList(storeKey, monthKey = null) {
  const removed = new Set(getRemovedStaff())
  const source = (monthKey != null ? (EMPLOYEE_MONTHLY[monthKey] || []) : EMPLOYEES).filter((e) => !removed.has(e.name))
  const local = localStaffList()
    .map((e) => ({ ...e, local: true }))
    .filter((e) => !removed.has(e.name))
  const list = [...source, ...local].filter((e) => storeKey === 'all' || e.storeKey === storeKey)
  return list
    .map((e) => ({
      ...e,
      hours: (e.baseHours || 0) + (e.otHours || 0),
      roi: e.salary > 0 ? e.workedRevenue / e.salary : 0,
    }))
    .sort((a, b) => b.salary - a.salary)
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

  const topPerf = [...EMPLOYEES].sort((a, b) => b.perf + b.big - (a.perf + a.big))[0]
  if (topPerf && topPerf.perf + topPerf.big > 0) {
    out.push({
      tag: '绩效',
      tagStyle: 'bg-purple-50 text-purple-600',
      bg: 'bg-purple-100',
      fg: 'text-purple-600',
      time: localize(lang, '薪资表 27-31 周'),
      text: localize(lang, '「{name}」业绩提成合计 ¥{amount}，全店最高。', {
        name: topPerf.name,
        amount: (topPerf.perf + topPerf.big).toLocaleString('zh-CN'),
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
      month: monthLabel(MONTHS[MONTHS.length - 1].key, lang),
      dish: aggAll.dish.toLocaleString('zh-CN'),
    }),
  })

  out.push({
    tag: '系统',
    tagStyle: 'bg-emerald-50 text-emerald-600',
    bg: 'bg-emerald-100',
    fg: 'text-emerald-600',
    time: 'V1.0',
    text: localize(lang, 'BUDU Operating System V1.0 运行正常，数据由脚本自动从报表生成。'),
  })

  return out.slice(0, 5)
}
/** 菜品销售明细（按所选月份/门店合并，按销售额降序；all 表示跨店同名合并） */
export function products(monthKey, storeKey) {
  const keys = storeKey === 'all' ? STORE_KEYS : [storeKey]
  const map = new Map()
  for (const k of keys) {
    for (const p of (PRODUCTS[monthKey] || {})[k] || []) {
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
  const keys = storeKey === 'all' ? STORE_KEYS : [storeKey]
  for (const m of MONTHS) {
    const pk = prevMonthKey(m.key)
    for (const k of keys) {
      const agg = aggregate(m.key, k)
      const prev = pk ? aggregate(pk, k) : null
      const st = STORES.find((s) => s.key === k)
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
  const stores = []
  for (const [k, v] of Object.entries(entries)) {
    const parts = k.split('|')
    if (parts.length !== 3 || parts[0] !== monthKey || parts[1] === 'all' || parts[2] !== day) continue
    if (!Array.isArray(v.staff) || !v.staff.includes(name)) continue
    inc += (Number(v.inc) || 0) / v.staff.length
    ord += (Number(v.ord) || 0) / v.staff.length
    count += 1
    stores.push(parts[1])
  }
  if (count === 0) return null
  return { inc: Math.round(inc * 100) / 100, ord: Math.round(ord * 100) / 100, stores }
}

/** 所选日期是否有本地业绩录入（任意门店） */
export function hasLocalEntry(monthKey, day) {
  if (!day) return false
  return Object.keys(localEntries()).some((k) => {
    const parts = k.split('|')
    return parts.length === 3 && parts[0] === monthKey && parts[2] === day
  })
}
