import * as XLSX from 'xlsx'

const SOURCE_TO_KEY = {
  'budu（三里屯通盈店）': 'tongying',
  'budu（官舍店）': 'guanshe',
  'budu（西单更新场店）': 'xidan',
}

const NAME_MAP = {
  tongying: '北京通盈中心店',
  guanshe: '北京官舍店',
  xidan: '北京西单店',
  chaowai: '北京朝外店',
}

const SALARY_STORE_MAP = {
  通盈: 'tongying',
  官舍: 'guanshe',
  西单: 'xidan',
  朝外: 'chaowai',
  大族: 'chaowai',
}

const FULL_TIME = new Set(['李飞燕', '叶芷辰', '隋晓'])

const WEEK_MONTH_SPLIT = {
  27: { '2026-06': 2, '2026-07': 5 },
  28: { '2026-07': 7 },
  29: { '2026-07': 7 },
  30: { '2026-07': 7 },
  31: { '2026-07': 5, '2026-08': 2 },
}

function num(v) {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).trim().replace(/,/g, '')
  if (!s || s === '--' || s === '-') return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function parseDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  }
  const s = String(v || '').trim()
  const m = s.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
  return ''
}

function sheetRows(ws) {
  if (!ws) return []
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })
}

function loadMonthly(ws) {
  const rows = sheetRows(ws)
  const daily = {}
  for (let r = 5; r < rows.length; r++) {
    const row = rows[r] || []
    const b = row[1]
    if (b == null || String(b).trim() === '--' || String(b).includes('合计')) continue
    const key = SOURCE_TO_KEY[String(b).trim()]
    if (!key) continue
    const d = parseDate(row[2])
    if (!d) continue
    daily[key] = daily[key] || []
    daily[key].push({
      d: d.slice(5),
      rev: round2(num(row[5])),
      inc: round2(num(row[7])),
      dis: round2(num(row[6])),
      ord: Math.round(num(row[8])),
      dish: Math.round(num(row[32])),
      dishRev: round2(num(row[29])),
      dishInc: round2(num(row[30])),
      boxFee: round2(num(row[34])),
      inStore: round2(num(row[12])),
      mt: round2(num(row[18])),
      tb: round2(num(row[24])),
      cash: round2(num(row[37])),
      wechat: round2(num(row[38])),
      alipay: round2(num(row[39])),
      union: round2(num(row[40])),
      mtPay: round2(num(row[42])),
      tbPay: round2(num(row[43])),
    })
  }
  return daily
}

function loadProducts(ws) {
  const rows = sheetRows(ws)
  const prods = {}
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r] || []
    const store = row[1]
    const name = row[2]
    if (!store || !name) continue
    const key = SOURCE_TO_KEY[String(store).trim()]
    if (!key) continue
    prods[key] = prods[key] || []
    prods[key].push({
      name: String(name).trim(),
      sales: round1(num(row[3])),
      amount: round2(num(row[5])),
      income: round2(num(row[7])),
      discount: round2(num(row[9])),
    })
  }
  for (const k of Object.keys(prods)) {
    const merged = {}
    for (const p of prods[k]) {
      const m = merged[p.name] || (merged[p.name] = { name: p.name, sales: 0, amount: 0, income: 0, discount: 0 })
      m.sales += p.sales
      m.amount += p.amount
      m.income += p.income
      m.discount += p.discount
    }
    prods[k] = Object.values(merged).sort((a, b) => b.amount - a.amount)
  }
  return prods
}

function round1(v) {
  return Math.round(v * 10) / 10
}

function round2(v) {
  return Math.round(v * 100) / 100
}

function newWeek() {
  return {
    salary: 0, baseHours: 0, otHours: 0, otPay: 0,
    perf: 0, big: 0, holiday: 0,
    workedRevenue: 0, workedDays: 0, achieve: 0, duty: 0, review: 0,
  }
}

function loadSalary(wb) {
  const emp = {}
  for (const wsName of Object.keys(wb.Sheets)) {
    const m = wsName.match(/(\d+)周/)
    const wnum = m ? Number(m[1]) : 0
    const rows = sheetRows(wb.Sheets[wsName])
    let cur = null
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || []
      const seq = row[1]
      const name = row[2]
      if (seq != null && name != null) {
        const key = String(name).trim()
        cur = emp[key] || (emp[key] = {
          name: key,
          stores: {},
          weeks: {},
          salary: 0, baseHours: 0, otHours: 0, otPay: 0,
          perf: 0, big: 0, holiday: 0,
          workedRevenue: 0, workedDays: 0, achieve: 0, duty: 0, review: 0,
        })
      }
      if (!cur) continue
      const wk = cur.weeks[wnum] || (cur.weeks[wnum] = newWeek())
      const storeRaw = row[6]
      if (storeRaw != null) {
        const s = String(storeRaw).trim()
        if (s && s !== '休息') cur.stores[s] = (cur.stores[s] || 0) + 1
      }
      const shift = row[7] != null ? String(row[7]).trim() : ''
      if (row[3] === '合计') {
        const vals = {
          salary: num(row[20]),
          baseHours: num(row[12]),
          otHours: num(row[15]),
          otPay: num(row[16]),
          perf: num(row[17]),
          big: num(row[18]),
          holiday: num(row[19]),
        }
        for (const [k, v] of Object.entries(vals)) {
          cur[k] += v
          wk[k] += v
        }
      } else {
        const rev = num(row[8])
        if (['早班', '晚班', '中班'].includes(shift)) {
          cur.workedDays += 1
          cur.workedRevenue += rev
          wk.workedDays += 1
          wk.workedRevenue += rev
        }
        if (row[9] === '✅') {
          cur.achieve += 1
          wk.achieve += 1
        }
        if (num(row[10]) > 0) {
          cur.duty += 1
          wk.duty += 1
        }
        if (row[11] === '✅') {
          cur.review += 1
          wk.review += 1
        }
      }
    }
  }
  return Object.values(emp)
}

function pickStore(emp) {
  const entries = Object.entries(emp.stores)
  if (entries.length === 0) return ''
  let best = entries[0][0]
  let bestCount = entries[0][1]
  for (const [s, c] of entries) {
    if (c > bestCount) {
      best = s
      bestCount = c
    }
  }
  return SALARY_STORE_MAP[best] || ''
}

function employeeOut(employees) {
  return employees
    .map((e) => {
      const sk = pickStore(e)
      return {
        name: e.name,
        type: FULL_TIME.has(e.name) ? 'fulltime' : 'parttime',
        storeKey: sk,
        storeName: NAME_MAP[sk] || '',
        salary: round2(e.salary),
        baseHours: round1(e.baseHours),
        otHours: round1(e.otHours),
        otPay: round2(e.otPay),
        perf: round2(e.perf),
        big: round2(e.big),
        workedRevenue: round2(e.workedRevenue),
        workedDays: e.workedDays,
        achieve: e.achieve,
        duty: e.duty,
        review: e.review,
      }
    })
    .sort((a, b) => b.salary - a.salary)
}

function splitSalaryByMonth(employees) {
  const monthly = {}
  for (const e of employees) {
    for (const [wnum, wk] of Object.entries(e.weeks)) {
      for (const [mk, days] of Object.entries(WEEK_MONTH_SPLIT[Number(wnum)] || {})) {
        const ratio = days / 7
        const rec = monthly[mk] || (monthly[mk] = {})
        const item = rec[e.name] || (rec[e.name] = {
          name: e.name,
          salary: 0, baseHours: 0, otHours: 0, otPay: 0,
          perf: 0, big: 0, holiday: 0,
          workedRevenue: 0, workedDays: 0,
          achieve: 0, duty: 0, review: 0,
        })
        for (const f of ['salary', 'baseHours', 'otHours', 'otPay', 'perf', 'big', 'holiday', 'workedRevenue', 'achieve', 'duty', 'review', 'workedDays']) {
          item[f] += wk[f] * ratio
        }
      }
    }
  }
  const out = {}
  for (const mk of Object.keys(monthly).sort()) {
    out[mk] = []
    for (const e of employees) {
      const rec = monthly[mk][e.name]
      if (!rec) continue
      const sk = pickStore(e)
      out[mk].push({
        name: e.name,
        type: FULL_TIME.has(e.name) ? 'fulltime' : 'parttime',
        storeKey: sk,
        storeName: NAME_MAP[sk] || '多店支援',
        salary: round2(rec.salary),
        baseHours: round1(rec.baseHours),
        otHours: round1(rec.otHours),
        otPay: round2(rec.otPay),
        perf: round2(rec.perf),
        big: round2(rec.big),
        workedRevenue: round2(rec.workedRevenue),
        workedDays: Math.round(rec.workedDays),
        achieve: Math.round(rec.achieve),
        duty: Math.round(rec.duty),
        review: Math.round(rec.review),
      })
    }
    out[mk].sort((a, b) => b.salary - a.salary)
  }
  return out
}

/** 解析上传的报表文件（.xlsx/.xls/.csv），自动识别营业额/菜品/薪资三类数据 */
export function parseAnalysis(buffer, fileName = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const name = String(fileName || '')
  const mm = name.match(/(20\d{2})?[年./\-]?(\d{1,2})月/)
  const monthKey = mm ? `${mm[1] || '2026'}-${pad(Number(mm[2]))}` : null

  const result = {
    daily: {},
    products: {},
    employees: null,
    employeeMonthly: {},
    months: new Set(),
    sourceFiles: [name],
  }

  const isSalary = /薪资/.test(name) || /周/.test(name)
  if (isSalary) {
    const employees = loadSalary(wb)
    if (employees.length > 0) {
      result.employees = employeeOut(employees)
      result.employeeMonthly = splitSalaryByMonth(employees)
      for (const mk of Object.keys(result.employeeMonthly)) result.months.add(mk)
    }
  }

  if (monthKey) {
    if (wb.Sheets['综合营业统计']) {
      const daily = loadMonthly(wb.Sheets['综合营业统计'])
      if (Object.keys(daily).length > 0) {
        result.daily[monthKey] = daily
        result.months.add(monthKey)
      }
    }
    if (wb.Sheets['菜品销售统计']) {
      const products = loadProducts(wb.Sheets['菜品销售统计'])
      if (Object.keys(products).length > 0) {
        result.products[monthKey] = products
        result.months.add(monthKey)
      }
    }
  }

  const hasAny = Object.keys(result.daily).length > 0 || Object.keys(result.products).length > 0 || result.employees
  if (!hasAny) return null

  result.months = [...result.months].sort()
  return result
}
