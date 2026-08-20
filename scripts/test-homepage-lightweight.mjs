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

test('首页只渲染六个指标卡和重要提醒', () => {
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
  assert.match(html, /重要提醒/)
  assert.doesNotMatch(html, /门店经营排行榜/)
  assert.doesNotMatch(html, /营业额趋势/)
  assert.doesNotMatch(html, /员工绩效 TOP5/)
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
