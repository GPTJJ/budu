/**
 * BUDU 前端选择器模拟测试（浏览器环境）
 *
 * 在 Vite dev server 中动态 import 真实 src/utils/selectors.js，
 * 用测试专用内存缓存播种验证（DA-5 后 localStorage 镜像已退役）：
 * - 员工当日工资（多店同日 / 普通 / 展示姓名不影响工资资格）
 * - 自然周汇总（含跨月周 8.31-9.6）
 * - 大单奖按日/按月
 * - 每日工资明细
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORT = 5199
const BASE = `http://localhost:${PORT}`

const mirror = {
  entries: {
    '2026-08|tongying|08-08': { inc: 8500, ord: 150, staff: ['叶芷辰', '李飞燕'] },
    '2026-08|xidan|08-08': { inc: 3000, ord: 50, staff: ['叶芷辰'] },
    '2026-08|tongying|08-09': { inc: 6000, ord: 100, staff: ['叶芷辰'] },
    '2026-08|tongying|08-10': { inc: 3500, ord: 80, staff: ['叶芷辰'] },
    '2026-08|tongying|08-11': { inc: 5000, ord: 60, staff: ['卡皮巴拉', '叶芷辰'] },
    '2026-08|tongying|08-31': { inc: 7000, ord: 120, staff: ['叶芷辰', '李飞燕'] },
    '2026-09|tongying|09-01': { inc: 4000, ord: 70, staff: ['叶芷辰'] },
    '2026-09|xidan|09-05': { inc: 2500, ord: 45, staff: ['李飞燕'] },
  },
  staff: [
    { name: '叶芷辰', type: 'parttime', storeKey: 'tongying', storeName: '通盈中心店' },
    { name: '李飞燕', type: 'parttime', storeKey: 'tongying', storeName: '通盈中心店' },
    { name: '卡皮巴拉', type: 'parttime', storeKey: 'tongying', storeName: '通盈中心店' },
    { name: '隋晓', type: 'fulltime', storeKey: 'guanshe', storeName: '官舍店' },
  ],
  removedStaff: [],
  analysis: {},
  productImages: {},
  stores: [
    { key: 'tongying', name: '通盈中心店' },
    { key: 'xidan', name: '西单店' },
    { key: 'chaowai', name: '朝外店' },
    { key: 'guanshe', name: '官舍店' },
  ],
  schedules: {},
  products: [],
  inventoryRequests: [],
  inventory: [],
  bigBonuses: [
    { id: 'bb-1', staffKey: 'tongying::叶芷辰', storeKey: 'tongying', date: '2026-08-09', amountCents: 200000, bonusCents: 10000 },
    { id: 'bb-2', staffKey: 'tongying::叶芷辰', storeKey: 'tongying', date: '2026-08-31', amountCents: 100000, bonusCents: 5000 },
  ],
}

let failed = 0
let passed = 0

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1
    console.log('OK:', name)
  } else {
    failed += 1
    console.log('FAIL:', name, extra)
  }
}

const near = (a, b) => Math.abs(a - b) < 1e-6

const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
vite.stdout.on('data', () => {})
vite.stderr.on('data', () => {})

async function waitReady() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE)
      if (r.ok) return
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('Vite dev server 启动超时')
}

try {
  await waitReady()
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })

  const r = await page.evaluate(async (fixture) => {
    const userData = await import('/src/utils/userData.js')
    userData.seedCachedDataForTest(fixture)
    const sel = await import('/src/utils/selectors.js')
    const out = {}

    // 1. 当日多店同日
    const dayYe = sel.employeeDayStatus('2026-08', '08-08', '叶芷辰')
    out.dayYe = dayYe

    // 2. Gate 29E：历史吉祥物展示姓名按普通工资公式计算
    const dayCapy = sel.employeeDayStatus('2026-08', '08-11', '卡皮巴拉')
    out.dayCapy = dayCapy

    // 3. 自然周（8.3-8.9）
    const week = sel.employeeWeekStatus('2026-08', [
      '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
      '2026-08-07', '2026-08-08', '2026-08-09',
    ], '叶芷辰')
    out.week = week

    // 4. 跨月自然周（8.31-9.6）
    const crossWeek = sel.employeeWeekStatus('2026-08', [
      '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
      '2026-09-04', '2026-09-05', '2026-09-06',
    ], '叶芷辰')
    out.crossWeek = crossWeek

    // 5. 每日工资明细（含大单奖）
    const detail = sel.employeeDailyPayDetail('2026-08', '08-09', '叶芷辰')
    out.detail = detail

    // 6. 卡皮巴拉明细
    const detailCapy = sel.employeeDailyPayDetail('2026-08', '08-11', '卡皮巴拉')
    out.detailCapy = detailCapy

    // 7. 大单奖按日 / 按月
    out.bonusDay = sel.bigBonusYuanOn('叶芷辰', '2026-08-09')
    out.bonusMonth = sel.bigBonusYuanMonth('叶芷辰', '2026-08')
    out.hasLocal = sel.hasLocalEntry('2026-08', '08-09')
    return out
  }, mirror)

  // ---- 断言 ----
  const d = r.dayYe
  check(
    '当日多店同日：叶芷辰 8.8（通盈2人 384 + 西单1人 480）',
    near(d.inc, 4250 + 3000) && near(d.hours, 20) && near(d.basePay, 584) && near(d.commission, 280) && near(d.pay, 864),
    JSON.stringify(d),
  )

  const c = r.dayCapy
  check(
    '卡皮巴拉当日：展示姓名不排除普通工资',
    c && near(c.hours, 8) && c.basePay === 224 && c.commission === 160 && c.pay === 384,
    JSON.stringify(c),
  )

  const w = r.week
  check(
    '自然周 8.3-8.9：叶芷辰 2 个出勤日 32h / 944 基础 / 400 提成 / 100 大单奖 / 1444 工资',
    w && w.workedDays === 2 && near(w.hours, 32) && near(w.basePay, 944) && near(w.commission, 400) && near(w.bigBonus, 100) && near(w.pay, 1444),
    JSON.stringify(w),
  )

  const xw = r.crossWeek
  check(
    '跨月自然周 8.31-9.6：叶芷辰 2 天 20h / 1054 工资（含 50 大单奖）',
    xw && xw.workedDays === 2 && near(xw.hours, 20) && near(xw.basePay, 584) && near(xw.commission, 420) && near(xw.bigBonus, 50) && near(xw.pay, 1054),
    JSON.stringify(xw),
  )

  const dl = r.detail
  check(
    '每日工资明细 8.9：基础 360 + 提成 120 + 大单奖 100 = 580',
    dl && dl.rows.length === 1 && near(dl.totals.basePay, 360) && near(dl.totals.commission, 120) && near(dl.totals.bigBonus, 100) && near(dl.totals.pay, 580),
    JSON.stringify(dl),
  )

  const dc = r.detailCapy
  check(
    '卡皮巴拉明细：展示姓名按普通工资公式计算',
    dc && near(dc.totals.hours, 8) && dc.totals.basePay === 224 && dc.totals.commission === 160 && dc.totals.bigBonus === 0 && dc.totals.pay === 384,
    JSON.stringify(dc),
  )

  check('大单奖按日 100 元', near(r.bonusDay, 100), String(r.bonusDay))
  check('大单奖按月 150 元', near(r.bonusMonth, 150), String(r.bonusMonth))
  check('hasLocalEntry 命中', r.hasLocal === true)

  await browser.close()
} finally {
  vite.kill()
}

if (failed) {
  console.log(`\nSIMULATE SELECTORS FAILED: ${failed} 项失败，${passed} 项通过`)
  process.exitCode = 1
} else {
  console.log(`\nSIMULATE SELECTORS OK：${passed} 项全部通过`)
}
