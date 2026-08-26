/**
 * BUDU 薪酬与日历多轮模拟测试（2026）
 *
 * 覆盖：
 * 1. 全年 365 天日历分类：周末 / 法定节假日 / 调休上班 / 工作日
 * 2. 随机多轮工资场景（门店 x 人数 x 营业额 x 日期类型）
 * 3. 通盈周末/节假日目标 5000 回归
 * 4. 多店同日聚合（出勤日只算 1 天）
 * 5. Gate 29E：历史吉祥物展示姓名按普通工资公式计算（月度口径）
 * 6. 自然周工具（getWeekStart / isoWeek / weekRangeLabel）
 */
import { calcDailyPay, commissionRate, isHoliday, monthlyPayrollFromEntries, HOLIDAYS_2026, WORKDAYS_2026, STORE_PAY_CONFIG } from '../src/utils/payroll.js'
import { getWeekStart, isoWeek, weekRangeLabel, getWeekDays } from '../src/utils/schedule.js'

let failed = 0
let passed = 0

function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1
    console.log('OK:', name)
  } else {
    failed += 1
    console.log('FAIL:', name, extra)
  }
}

function round2(v) {
  return Math.round(v * 100) / 100
}

// ---------- 1. 全年日历分类 ----------
{
  const overlap = [...HOLIDAYS_2026].filter((d) => WORKDAYS_2026.has(d))
  ok('法定节假日与调休上班无重叠', overlap.length === 0, JSON.stringify(overlap))

  let holidays = 0
  let workdays = 0
  let weekends = 0
  let checked = 0
  for (let d = new Date(2026, 0, 1); d <= new Date(2026, 11, 31); d.setDate(d.getDate() + 1)) {
    const p = (n) => String(n).padStart(2, '0')
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    const dow = d.getDay()
    const expect =
      WORKDAYS_2026.has(key)
        ? false
        : HOLIDAYS_2026.has(key) || dow === 0 || dow === 6
    const got = isHoliday(key)
    if (got !== expect) {
      failed += 1
      console.log('FAIL 日历分类:', key, 'got', got, 'expect', expect)
      continue
    }
    checked += 1
    if (got) {
      holidays += 1
      if (dow === 0 || dow === 6) weekends += 1
    } else {
      workdays += 1
    }
  }
  ok('2026 全年 365 天分类校验通过', checked === 365)
  console.log(`  统计：法定+周末 ${holidays} 天（其中真实周末 ${weekends} 天），工作日 ${workdays} 天`)

  // 关键节点抽查
  const keyChecks = [
    ['2026-01-01', true, '元旦放假'],
    ['2026-01-04', false, '元旦调休上班（周日补班）'],
    ['2026-02-14', false, '春节前周六补班'],
    ['2026-02-15', true, '春节放假'],
    ['2026-02-28', false, '春节后周六补班'],
    ['2026-04-06', true, '清明放假'],
    ['2026-05-01', true, '劳动节放假'],
    ['2026-05-09', false, '劳动节调休上班'],
    ['2026-06-21', true, '端午放假'],
    ['2026-09-20', false, '中秋前周日补班'],
    ['2026-09-27', true, '中秋放假'],
    ['2026-10-01', true, '国庆放假'],
    ['2026-10-07', true, '国庆最后一天'],
    ['2026-10-10', false, '国庆后周六补班'],
    ['2026-08-08', true, '普通周六'],
    ['2026-08-10', false, '普通周一'],
    ['2026-08-31', false, '普通周一（月末）'],
  ]
  for (const [date, expect, label] of keyChecks) {
    ok(`日历节点：${label}`, isHoliday(date) === expect, `got ${isHoliday(date)}`)
  }
}

// ---------- 2. 随机多轮工资场景 ----------
{
  let seed = 20260808
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const stores = [
    { key: 'tongying', hours1: 12, target: 2000, holidayTarget: 5000 },
    { key: 'xidan', hours1: 12, target: 2000, holidayTarget: 2000 },
    { key: 'chaowai', hours1: 11.5, target: 2000, holidayTarget: 2000 },
    { key: 'guanshe', hours1: 11, target: 2000, holidayTarget: 2000 },
  ]
  const dates = []
  for (let m = 1; m <= 12; m += 1) {
    const daysInMonth = new Date(2026, m, 0).getDate()
    // 每月抽 15 天，覆盖月初/月中/月末
    for (let k = 0; k < 15; k += 1) {
      const d = 1 + Math.floor(rnd() * daysInMonth)
      const p = (n) => String(n).padStart(2, '0')
      dates.push(`2026-${p(m)}-${p(d)}`)
    }
  }
  let scenario = 0
  for (const date of dates) {
    for (const s of stores) {
      const staffCount = 1 + Math.floor(rnd() * 3) // 1-3 人
      const revenue = Math.round(rnd() * 12000 * 100) / 100
      const holiday = isHoliday(date)
      const hours = staffCount <= 1 ? s.hours1 : 8
      const baseRate = staffCount <= 1 ? 30 : 28
      const target = s.key === 'tongying' && holiday ? s.holidayTarget : s.target
      const rate = revenue < target ? 0 : 5 + Math.floor((revenue - target) / 1000) * 5
      const basePay = round2(baseRate * hours)
      const commission = round2(rate * hours)
      const total = round2(basePay + commission)
      const got = calcDailyPay({ storeKey: s.key, revenue, date, staffCount })
      scenario += 1
      const extra = `date=${date} store=${s.key} n=${staffCount} rev=${revenue} got=${JSON.stringify(got)}`
      if (
        Math.abs(got.hours - hours) > 1e-9 ||
        got.baseRate !== baseRate ||
        Math.abs(got.basePay - basePay) > 1e-9 ||
        got.commissionRate !== rate ||
        Math.abs(got.commission - commission) > 1e-9 ||
        Math.abs(got.total - total) > 1e-9
      ) {
        failed += 1
        console.log('FAIL 随机场景:', extra)
      } else {
        passed += 1
      }
    }
  }
  console.log(`  随机工资场景：${scenario} 个全部通过`)
}

// ---------- 3. 通盈周末 / 节假日目标 5000 回归 ----------
{
  const weekendCases = [
    ['2026-08-08', 4800, 0, '周六未达 5000'],
    ['2026-08-09', 6000, 10, '周日达 6000'],
    ['2026-08-08', 8500, 20, '周六达 8500'],
    ['2026-10-01', 4800, 0, '国庆未达 5000'],
    ['2026-10-01', 6000, 10, '国庆达 6000'],
    ['2026-01-04', 3000, 10, '调休上班按 2000 目标（周日补班）'],
    ['2026-02-14', 4800, 15, '调休上班按 2000 目标（春节前补班）'],
  ]
  for (const [date, rev, expectRate, label] of weekendCases) {
    const rate = commissionRate('tongying', rev, date)
    ok(`通盈 ${label}（${date} rev=${rev}）`, rate === expectRate, `got ${rate}`)
  }
  // 西单等门店不享受节假日目标 5000
  const xidan = commissionRate('xidan', 4800, '2026-08-08')
  ok('西单周末仍按 2000 目标（4800 → 15 元/h）', xidan === 15, `got ${xidan}`)
}

// ---------- 4. 多店同日 / 月度聚合 ----------
{
  const entries = {
    '2026-08|tongying|08-01': { inc: 7070.43, ord: 120, staff: ['叶芷辰', '李飞燕'] },
    '2026-08|xidan|08-01': { inc: 3000, ord: 50, staff: ['叶芷辰'] },
    '2026-08|guanshe|08-02': { inc: 1462.39, ord: 30, staff: ['隋晓'] },
    '2026-08|tongying|08-03': { inc: 1234.56, ord: 20, staff: ['叶芷辰'] },
  }
  const map = monthlyPayrollFromEntries(entries, '2026-08', {
    tongying: '通盈中心店',
    xidan: '西单店',
    guanshe: '官舍店',
  })
  const ye = map.get('叶芷辰')
  // 8.1 通盈 2 人 8h：base 224，提成 = ((7070.43-5000)/1000|0)*5 +5 = 15/h => 120
  // 8.1 西单 1 人 12h：base 360，提成 10/h => 120
  // 8.3 通盈 1 人 12h 工作日 rev 1234.56 未达 2000 => 360
  // 合计 salary = 344 + 480 + 360 = 1184，workedDays=2（同日两店只算 1 天）
  ok('叶芷辰同日两店：工资汇总正确', ye && Math.abs(ye.salary - 1184) < 1e-6, JSON.stringify(ye))
  ok('叶芷辰同日两店：出勤日只算 2 天', ye && ye.workedDays === 2, JSON.stringify(ye))
  ok('叶芷辰同日两店：工时 = 8+12+12 = 32h', ye && Math.abs(ye.hours - 32) < 1e-6, JSON.stringify(ye))
  const li = map.get('李飞燕')
  ok('李飞燕通盈 2 人日：344 元（224+120）', li && Math.abs(li.salary - 344) < 1e-6, JSON.stringify(li))
  const sui = map.get('隋晓')
  ok('隋晓官舍 1 人日：330 元', sui && Math.abs(sui.salary - 330) < 1e-6, JSON.stringify(sui))

  // 旧格式 day 不带月份（兼容）
  const legacy = { '2026-08|tongying|10': { inc: 3500, ord: 80, staff: ['叶芷辰'] } }
  const legacyMap = monthlyPayrollFromEntries(legacy, '2026-08', { tongying: '通盈中心店' })
  ok('兼容旧格式（day=10）：480 元', legacyMap.get('叶芷辰') && Math.abs(legacyMap.get('叶芷辰').salary - 480) < 1e-6, JSON.stringify(legacyMap.get('叶芷辰')))
}

// ---------- 5. 展示姓名不控制工资资格 ----------
{
  const entries = {
    '2026-08|tongying|08-10': { inc: 5000, ord: 60, staff: ['卡皮巴拉', '叶芷辰'] },
    '2026-08|xidan|08-11': { inc: 3000, ord: 40, staff: ['卡皮巴拉'] },
  }
  const map = monthlyPayrollFromEntries(entries, '2026-08', { tongying: '通盈中心店', xidan: '西单店' })
  const capy = map.get('卡皮巴拉')
  ok('卡皮巴拉月度：展示姓名不排除普通工资', capy && capy.salary === 864 && capy.basePay === 584 && capy.commission === 280, JSON.stringify(capy))
  ok('卡皮巴拉月度：正常统计工时（8+12=20h）', capy && Math.abs(capy.hours - 20) < 1e-6, JSON.stringify(capy))
  ok('卡皮巴拉月度：出勤 2 天', capy && capy.workedDays === 2, JSON.stringify(capy))
}

// ---------- 6. 自然周工具 ----------
{
  const weekChecks = [
    ['2026-01-01', '2025-12-29', 1],
    ['2026-08-08', '2026-08-03', 32],
    ['2026-08-31', '2026-08-31', 36],
    ['2026-09-06', '2026-08-31', 36],
    ['2025-12-31', '2025-12-29', 1],
    ['2027-01-01', '2026-12-28', 53],
  ]
  for (const [date, expectStart, expectIso] of weekChecks) {
    const start = getWeekStart(date)
    ok(`自然周 ${date} → 周一 ${expectStart}`, start === expectStart, `got ${start}`)
    ok(`自然周 ISO ${expectIso}（${start}）`, isoWeek(start) === expectIso, `got ${isoWeek(start)}`)
  }
  ok('周范围文案 2026-08-03 ~ 2026-08-09', weekRangeLabel('2026-08-03') === '2026-08-03 ~ 2026-08-09', weekRangeLabel('2026-08-03'))
  const days = getWeekDays('2026-08-03')
  ok('一周 7 天标签正确', days.length === 7 && days[0].label === '周一' && days[6].label === '周日', JSON.stringify(days))
}

if (failed) {
  console.log(`\nSIMULATE PAYROLL FAILED: ${failed} 项失败，${passed} 项通过`)
  process.exitCode = 1
} else {
  console.log(`\nSIMULATE PAYROLL OK：${passed} 项全部通过`)
}
