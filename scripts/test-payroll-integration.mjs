// 集成测试：通过 userData 镜像注入 8 月业绩录入，验证 selectors 的薪酬计算结果
import { createServer } from 'vite'

globalThis.localStorage = {
  _s: {},
  getItem(k) {
    return this._s[k] ?? null
  },
  setItem(k, v) {
    this._s[k] = String(v)
  },
  removeItem(k) {
    delete this._s[k]
  },
}

globalThis.localStorage.setItem(
  'budu-os-cloud-mirror-v1',
  JSON.stringify({
    entries: {
      '2026-08|tongying|10': { inc: 3500, ord: 80, staff: ['叶芷辰'] },
      '2026-08|tongying|08': { inc: 8500, ord: 150, staff: ['叶芷辰', '李飞燕'] },
      '2026-08|guanshe|08-07': { inc: 0, ord: 0, staff: ['隋晓'] },
      '2026-08|xidan|10': { inc: 1200, ord: 30, staff: ['叶芷辰'] },
      '2026-08|store-abc|13': { inc: 1500, ord: 40, staff: ['左可翠'] },
    },
    staff: [],
    removedStaff: [],
    analysis: {},
    productImages: {},
    stores: [{ key: 'store-abc', name: '北京朝外店' }],
  }),
)

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
const { employeeList, entryEmployeePerformance, employeeDayStatus, employeeDailyPayDetail, employeeWeekStatus } =
  await server.ssrLoadModule('/src/utils/selectors.js')

let failed = 0
const check = (name, got, expect) => {
  const ok =
    got != null &&
    Object.entries(expect).every(([k, v]) => {
      if (typeof v === 'number') return Math.abs(got[k] - v) < 1e-6
      if (Array.isArray(v)) return JSON.stringify(got[k]) === JSON.stringify(v)
      return got[k] === v
    })
  if (!ok) {
    failed += 1
    console.log('FAIL:', name, JSON.stringify(got), 'expect', JSON.stringify(expect))
  } else {
    console.log('OK:', name)
  }
}

const month = employeeList('all', '2026-08')
const ye = month.find((e) => e.name === '叶芷辰')
check('employeeList 8 月：叶芷辰薪酬/出勤', ye, {
  salary: 1224,
  perf: 280,
  hours: 32,
  workedDays: 2,
  workedRevenue: 8950,
  payrollComputed: true,
})

const ma = month.find((e) => e.name === '马婧欣')
check('employeeList 8 月：无录入员工薪酬归零', ma, {
  salary: 0,
  perf: 0,
  workedDays: 0,
  hours: 0,
})

const zuo = month.find((e) => e.name === '左可翠')
check('employeeList 8 月：左可翠（新增门店 key 按名称匹配朝外 11.5h）', zuo, {
  salary: 345,
  perf: 0,
  hours: 11.5,
  workedDays: 1,
})

const sui = month.find((e) => e.name === '隋晓')
check('employeeList 8 月：隋晓官舍调货补贴计入工资', sui, {
  salary: 352,
  basePay: 330,
  transferSubsidy: 22,
  hours: 11,
})

const top = entryEmployeePerformance('all', '2026-08')
const topYe = top.find((e) => e.name === '叶芷辰')
check('entryEmployeePerformance 8 月：叶芷辰', topYe, {
  salary: 1224,
  hours: 32,
  workedDays: 2,
  workedRevenue: 8950,
})

const day = employeeDayStatus('2026-08', '10', '叶芷辰')
check('employeeDayStatus 8-10 当日薪酬（通盈+西单）', day, {
  pay: 840,
  basePay: 720,
  commission: 120,
  hours: 24,
  stores: ['tongying', 'xidan'],
})

const day2 = employeeDayStatus('2026-08', '08', '李飞燕')
check('employeeDayStatus 8-08 通盈 2 人日', day2, {
  pay: 384,
  basePay: 224,
  commission: 160,
  hours: 8,
})

const guansheDay = employeeDayStatus('2026-08', '08-07', '隋晓')
check('employeeDayStatus 8-07 官舍调货补贴', guansheDay, {
  pay: 352,
  basePay: 330,
  commission: 0,
  transferSubsidy: 22,
  hours: 11,
})

const guansheDetail = employeeDailyPayDetail('2026-08', '08-07', '隋晓')
check('employeeDailyPayDetail 官舍补贴与明细合计一致', guansheDetail?.totals, {
  pay: 352,
  basePay: 330,
  transferSubsidy: 22,
})
check('employeeDailyPayDetail 官舍门店行单列补贴', guansheDetail?.rows?.[0], {
  transferSubsidyRate: 2,
  transferSubsidy: 22,
  total: 352,
})

const guansheWeek = employeeWeekStatus('2026-08', ['2026-08-07'], '隋晓')
check('employeeWeekStatus 本周调货补贴汇总', guansheWeek, {
  pay: 352,
  transferSubsidy: 22,
})

if (failed) {
  console.log('PAYROLL INTEGRATION FAILED:', failed)
  process.exitCode = 1
} else {
  console.log('PAYROLL INTEGRATION OK')
}

await server.close()
