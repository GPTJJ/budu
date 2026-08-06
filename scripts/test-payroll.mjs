import {
  calcDailyPay,
  commissionRate,
  isHoliday,
  monthlyPayrollFromEntries,
} from '../src/utils/payroll.js'

const cases = [
  {
    name: '通盈工作日 3500 元 / 1 人 12h → 提成 120',
    got: calcDailyPay({ storeKey: 'tongying', revenue: 3500, date: '2026-08-10', staffCount: 1 }),
    expect: { hours: 12, baseRate: 30, basePay: 360, commissionRate: 10, commission: 120, total: 480 },
  },
  {
    name: '通盈节假日 8500 元 / 2 人 8h → 提成 160',
    got: calcDailyPay({ storeKey: 'tongying', revenue: 8500, date: '2026-08-08', staffCount: 2 }),
    expect: { hours: 8, baseRate: 28, basePay: 224, commissionRate: 20, commission: 160, total: 384 },
  },
  {
    name: '官舍 1 人 11h → 基础薪资 330',
    got: calcDailyPay({ storeKey: 'guanshe', revenue: 0, date: '2026-08-07', staffCount: 1 }),
    expect: { hours: 11, baseRate: 30, basePay: 330, commissionRate: 0, commission: 0, total: 330 },
  },
  {
    name: '西单 2 人 8h 2000 达标 → 基础时薪 28 + 提成 40',
    got: calcDailyPay({ storeKey: 'xidan', revenue: 2000, date: '2026-08-12', staffCount: 2 }),
    expect: { hours: 8, baseRate: 28, basePay: 224, commissionRate: 5, commission: 40, total: 264 },
  },
  {
    name: '朝外 1 人 11.5h 未达标 → 仅基础薪资 345',
    got: calcDailyPay({ storeKey: 'chaowai', revenue: 1500, date: '2026-08-13', staffCount: 1 }),
    expect: { hours: 11.5, baseRate: 30, basePay: 345, commissionRate: 0, commission: 0, total: 345 },
  },
  {
    name: '新增门店 key（store-abc）+ 名称「北京朝外店」→ 仍按朝外 11.5h',
    got: calcDailyPay({
      storeKey: 'store-abc',
      storeName: '北京朝外店',
      revenue: 1500,
      date: '2026-08-13',
      staffCount: 1,
    }),
    expect: { hours: 11.5, baseRate: 30, basePay: 345, commissionRate: 0, commission: 0, total: 345 },
  },
  {
    name: '通盈周末未达标目标 5000 → 无提成',
    got: calcDailyPay({ storeKey: 'tongying', revenue: 4800, date: '2026-08-09', staffCount: 1 }),
    expect: { hours: 12, baseRate: 30, basePay: 360, commissionRate: 0, commission: 0, total: 360 },
  },
  {
    name: '通盈周末 6000 达标 → 10 元/h',
    got: calcDailyPay({ storeKey: 'tongying', revenue: 6000, date: '2026-08-09', staffCount: 1 }),
    expect: { hours: 12, baseRate: 30, basePay: 360, commissionRate: 10, commission: 120, total: 480 },
  },
]

const holidayCases = [
  ['2026-01-01', true, '元旦放假'],
  ['2026-01-04', false, '元旦调休上班'],
  ['2026-02-15', true, '春节放假'],
  ['2026-02-14', false, '春节调休上班'],
  ['2026-04-04', true, '清明放假'],
  ['2026-05-01', true, '劳动节放假'],
  ['2026-05-09', false, '劳动节调休上班'],
  ['2026-06-19', true, '端午放假'],
  ['2026-09-25', true, '中秋放假'],
  ['2026-09-20', false, '中秋调休上班'],
  ['2026-10-01', true, '国庆放假'],
  ['2026-10-10', false, '国庆调休上班'],
  ['2026-08-08', true, '周六'],
  ['2026-08-10', false, '周一工作日'],
]

let failed = 0
for (const c of cases) {
  const ok = Object.entries(c.expect).every(([k, v]) => Math.abs(c.got[k] - v) < 1e-9)
  if (!ok) {
    failed += 1
    console.log('FAIL:', c.name, JSON.stringify(c.got), 'expect', JSON.stringify(c.expect))
  } else {
    console.log('OK:', c.name)
  }
}
for (const [date, expect, label] of holidayCases) {
  const got = isHoliday(date)
  if (got !== expect) {
    failed += 1
    console.log('FAIL holiday:', date, label, 'got', got)
  } else {
    console.log('OK holiday:', date, label)
  }
}

/** 按月聚合测试：模拟 8 月录入（含工作日/周末/多店同日） */
const entries = {
  '2026-08|tongying|10': { inc: 3500, ord: 80, staff: ['叶芷辰'] },
  '2026-08|tongying|08': { inc: 8500, ord: 150, staff: ['叶芷辰', '李飞燕'] },
  '2026-08|guanshe|07': { inc: 0, ord: 0, staff: ['隋晓'] },
  '2026-08|xidan|10': { inc: 1200, ord: 30, staff: ['叶芷辰'] },
  '2026-08|store-abc|13': { inc: 1500, ord: 40, staff: ['左可翠'] },
}
const monthPay = monthlyPayrollFromEntries(entries, '2026-08', { 'store-abc': '北京朝外店' })
const monthCases = [
  {
    name: '叶芷辰 8 月：通盈 480 + 通盈 384 + 西单 360（同日两店只算 1 个出勤日）',
    got: monthPay.get('叶芷辰'),
    expect: { salary: 1224, basePay: 944, commission: 280, hours: 32, workedDays: 2, workedRevenue: 8950 },
  },
  {
    name: '李飞燕 8 月：通盈 2 人日 384',
    got: monthPay.get('李飞燕'),
    expect: { salary: 384, basePay: 224, commission: 160, hours: 8, workedDays: 1, workedRevenue: 4250 },
  },
  {
    name: '隋晓 8 月：官舍 1 人 330',
    got: monthPay.get('隋晓'),
    expect: { salary: 330, basePay: 330, commission: 0, hours: 11, workedDays: 1, workedRevenue: 0 },
  },
  {
    name: '左可翠 8 月：朝外 1 人 11.5h 未达标 345',
    got: monthPay.get('左可翠'),
    expect: { salary: 345, basePay: 345, commission: 0, hours: 11.5, workedDays: 1, workedRevenue: 1500 },
  },
]
for (const c of monthCases) {
  const ok =
    c.got &&
    Object.entries(c.expect).every(([k, v]) => Math.abs(c.got[k] - v) < 1e-6)
  if (!ok) {
    failed += 1
    console.log('FAIL:', c.name, JSON.stringify(c.got), 'expect', JSON.stringify(c.expect))
  } else {
    console.log('OK:', c.name)
  }
}

console.log('提成时薪示例：通盈 3500 →', commissionRate('tongying', 3500, '2026-08-10'), '元/h；通盈 8500 节假日 →', commissionRate('tongying', 8500, '2026-08-08'), '元/h')
if (failed) {
  console.log('PAYROLL TEST FAILED:', failed)
  process.exitCode = 1
} else {
  console.log('PAYROLL TEST OK')
}
