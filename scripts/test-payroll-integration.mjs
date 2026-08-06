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
      '2026-08|guanshe|07': { inc: 0, ord: 0, staff: ['隋晓'] },
      '2026-08|xidan|10': { inc: 1200, ord: 30, staff: ['叶芷辰'] },
      '2026-08|chaowai|13': { inc: 1500, ord: 40, staff: ['左可翠'] },
    },
    staff: [],
    removedStaff: [],
    analysis: {},
    productImages: {},
    stores: [],
  }),
)

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
const { employeeList, entryEmployeePerformance, employeeDayStatus } =
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

if (failed) {
  console.log('PAYROLL INTEGRATION FAILED:', failed)
  process.exitCode = 1
} else {
  console.log('PAYROLL INTEGRATION OK')
}

await server.close()
