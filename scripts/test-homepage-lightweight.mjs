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

const i18n = await vite.ssrLoadModule('/src/i18n.jsx')
const dashboard = await vite.ssrLoadModule('/src/components/Dashboard.jsx')

test('首页渲染移动经营工作台且不再堆叠旧卡片与重要提醒', () => {
  const html = renderToString(
    React.createElement(
      i18n.I18nProvider,
      null,
      React.createElement(dashboard.default, {
        user: { id: 'dev-1', username: 'budu', role: 'developer', storeKeys: [] },
        onLogout: () => {},
        onUserChange: () => {},
      }),
    ),
  )

  assert.match(html, /营业收入/)
  assert.match(html, /待办事项/)
  assert.match(html, /门店经营/)
  assert.match(html, /最近动态/)
  assert.doesNotMatch(html, /重要提醒/)
  assert.doesNotMatch(html, /门店经营排行榜/)
  assert.doesNotMatch(html, /营业额趋势/)
  assert.doesNotMatch(html, /员工绩效 TOP5/)
})

test('首页保持轻量图表并启用自然周筛选', async () => {
  const homeSource = fs.readFileSync(new URL('../src/components/HomeWorkspace.jsx', import.meta.url), 'utf8')
  const calendarSource = fs.readFileSync(new URL('../src/components/CalendarPicker.jsx', import.meta.url), 'utf8')
  const selectors = await vite.ssrLoadModule('/src/utils/selectors.js')

  assert.doesNotMatch(homeSource, /from ['"]recharts['"]/)
  assert.match(homeSource, /<svg/)
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
  const weeklyIncome = selectors.kpiCards('2026-08', 'all', null, 'zh', '2026-08-03')[0]
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
})
