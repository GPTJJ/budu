import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
after(() => vite.close())

const dashboard = await vite.ssrLoadModule('/src/components/Dashboard.jsx')
const privacyMask = await vite.ssrLoadModule('/src/utils/privacyMask.js')

test('首页默认开启防窥脱敏且渲染紧凑状态卡、工作台与待办', () => {
  const html = renderToString(
    React.createElement(dashboard.default, {
      user: { id: 'dev-1', username: 'budu', role: 'developer', status: 'active', storeKeys: [] },
      onLogout: () => {},
      onUserChange: () => {},
    }),
  )

  assert.match(html, /经营状态/)
  assert.match(html, /按住偷看业绩/)
  assert.match(html, /营业收入/)
  assert.match(html, /功能工作台/)
  assert.match(html, /日常运营/)
  assert.match(html, /业务与卡券/)
  assert.match(html, /数据与系统/)
  assert.match(html, /待办事项/)
  assert.match(html, /门店经营/)
  assert.match(html, /最近动态/)
  // 默认防窥态不直接渲染 ¥ 金额
  assert.doesNotMatch(html, /¥\d/)
  assert.doesNotMatch(html, /重要提醒/)
  assert.doesNotMatch(html, /门店经营排行榜/)
  assert.doesNotMatch(html, /营业额趋势/)
  assert.doesNotMatch(html, /员工绩效 TOP5/)
})

test('动态金额正则脱敏准确替换元与人民币符号并保留日期单量', () => {
  const { maskSensitiveAmounts, calcTargetProgressPct, periodTargetTotal } = privacyMask
  assert.equal(
    maskSensitiveAmounts('报销审批通过：1195.59 元，收款 ¥1,280.00，共 3 单'),
    '报销审批通过：•••• 元，收款 •••• 元，共 3 单',
  )
  assert.equal(
    maskSensitiveAmounts('2026-08-20 10:21 门店退款 -￥88.5元 已处理', true),
    '2026-08-20 10:21 门店退款 •••• 元 已处理',
  )
  assert.equal(
    maskSensitiveAmounts('报销 1195.59 元', false),
    '报销 1195.59 元',
  )
  // 工作日 4 店目标 = 2000 * 4 = 8000；节假日通盈目标 = 5000，4 店合计 = 11000
  const weekdayTarget = periodTargetTotal(['tongying', 'guanshe', 'chaowai', 'xidan'], '2026-08', '08-20', null)
  assert.equal(weekdayTarget, 8000)
  assert.equal(calcTargetProgressPct(4000, weekdayTarget), 50)
  const holidayTarget = periodTargetTotal(['tongying', 'guanshe', 'chaowai', 'xidan'], '2026-08', '08-22', null)
  assert.equal(holidayTarget, 11000)
  // 未配置目标的门店返回 null，不套用默认保底，且对 0 / NaN / Infinity 安全防护
  assert.equal(privacyMask.singleStoreDailyTarget('unconfigured-partner-store', '2026-08-20'), null)
  assert.equal(periodTargetTotal(['unconfigured-partner-store'], '2026-08', '08-20', null), null)
  assert.equal(calcTargetProgressPct(5000, null), null)
  assert.equal(calcTargetProgressPct(5000, 0), null)
  assert.equal(calcTargetProgressPct(Number.POSITIVE_INFINITY, 2000), 0)
  assert.equal(calcTargetProgressPct(Number.NaN, 2000), 0)
})

test('首页保持轻量图表、自然周筛选并融合闭店过滤与小程序管理台入口', async () => {
  const homeSource = fs.readFileSync(new URL('../src/components/HomeWorkspace.jsx', import.meta.url), 'utf8')
  const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const calendarSource = fs.readFileSync(new URL('../src/components/CalendarPicker.jsx', import.meta.url), 'utf8')
  const selectors = await vite.ssrLoadModule('/src/utils/selectors.js')

  assert.doesNotMatch(homeSource, /from ['"]recharts['"]/)
  assert.match(homeSource, /<svg/)
  assert.match(homeSource, /budu-no-callout/)
  assert.match(homeSource, /onPointerCancel/)
  assert.match(homeSource, /visibilitychange/)
  assert.match(homeSource, /useOperatingStores/)
  assert.match(homeSource, /storeVisibleInOperatingPeriod/)
  assert.match(homeSource, /label:\s*'小程序管理台',\s*href:\s*'\/mini-program'/)
  assert.match(cssSource, /\.budu-no-callout\s*\{[\s\S]*?-webkit-touch-callout:\s*none;/)
  assert.match(calendarSource, /onWeekSelect/)
  assert.deepEqual(selectors.periodDates('2026-08', null, '2026-08-31'), [
    '2026-08-31',
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
    '2026-09-05',
    '2026-09-06',
  ])
  assert.equal(selectors.prevMonthKey('2027-01'), '2026-12')
  const week = selectors.periodStats('2026-08', 'all', null, '2026-08-03')
  const previousWeek = selectors.periodStats('2026-08', 'all', null, '2026-07-27')
  const weeklyIncome = selectors.kpiCards('2026-08', 'all', null, '2026-08-03')[0]
  assert.equal(weeklyIncome.change, selectors.changePct(week.inc, previousWeek.inc))
})

test('分析组件与首页主包解耦并保留独立入口', () => {
  const dashboardSource = fs.readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8')
  const analysisSource = fs.readFileSync(new URL('../src/components/BusinessAnalysisPage.jsx', import.meta.url), 'utf8')
  const sidebarSource = fs.readFileSync(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8')

  assert.match(dashboardSource, /lazy\(\(\) => import\('\.\/BusinessAnalysisPage'\)\)/)
  assert.doesNotMatch(dashboardSource, /import\('\.\/RevenueTrendChart'\)/)
  assert.match(analysisSource, /import\('\.\/RevenueTrendChart'\)/)
  assert.match(analysisSource, /import\('\.\/ProductSalesTable'\)/)
  assert.match(sidebarSource, /key: 'analysis', label: '经营分析'/)
  assert.match(sidebarSource, /if \(subs\.length > 0\)/)
  assert.doesNotMatch(sidebarSource, /if \(subs\) \{/)
})
