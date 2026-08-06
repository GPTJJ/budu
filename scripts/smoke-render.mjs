// 冒烟测试：用 Vite SSR 渲染登录门 + 各主要页面组件，捕获组件级渲染错误。
// 用法: node scripts/smoke-render.mjs
import { createServer } from 'vite'
import React from 'react'
import { renderToString } from 'react-dom/server'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})

const render = async (path, props = {}) => {
  const mod = await server.ssrLoadModule(path)
  const i18n = await server.ssrLoadModule('/src/i18n.jsx')
  return renderToString(
    React.createElement(i18n.I18nProvider, null, React.createElement(mod.default, props)),
  )
}

try {
  const checks = [
    ['App 登录门', await render('/src/App.jsx'), ['budu', '正在加载']],
    ['LoginPage', await render('/src/components/LoginPage.jsx', { onLogin: () => {} }), ['budu 甜蜜运营系统', '登录', '注册一个']],
    ['PersonnelPage', await render('/src/components/PersonnelPage.jsx', { type: 'fulltime', onTypeChange: () => {}, onBack: () => {} }), ['人员管理', '全职雇员']],
    ['StoreEntryPage', await render('/src/components/StoreEntryPage.jsx', { onBack: () => {} }), ['门店业绩录入', '值班人员']],
    ['StoreRankingTable', await render('/src/components/StoreRankingTable.jsx', { month: '2026-07', store: 'all', day: null }), ['门店经营排行榜']],
    ['RevenueTrendChart', await render('/src/components/RevenueTrendChart.jsx', { month: '2026-07', store: 'all', day: null }), ['营业额趋势']],
    ['ChannelChart', await render('/src/components/ChannelChart.jsx', { month: '2026-07', store: 'all', day: null }), ['渠道销售构成']],
    ['EmployeePerformanceTable', await render('/src/components/EmployeePerformanceTable.jsx', { store: 'all' }), ['员工绩效 TOP5']],
    ['ProductSalesTable', await render('/src/components/ProductSalesTable.jsx', { month: '2026-07', store: 'all' }), ['商品销售 TOP10']],
    ['NotificationPanel', await render('/src/components/NotificationPanel.jsx', { month: '2026-07', day: null }), ['重要提醒']],
    ['SettingsPage', await render('/src/components/SettingsPage.jsx', { onBack: () => {} }), ['系统设置', '界面语言']],
    [
      'AccountMenu',
      await render('/src/components/AccountMenu.jsx', {
        user: { username: 'budu', role: 'admin' },
        onUserChange: () => {},
        onLogout: () => {},
        variant: 'header',
      }),
      ['打开账号菜单'],
    ],
    [
      'AccountAdminPage',
      await render('/src/components/AccountAdminPage.jsx', {
        currentUser: { id: '1', username: 'budu', role: 'owner' },
        onBack: () => {},
      }),
      ['账号管理', '已注册账号'],
    ],
    [
      'KpiCard public mode',
      await (async () => {
        const i18n = await server.ssrLoadModule('/src/i18n.jsx')
        const vis = await server.ssrLoadModule('/src/visibility.jsx')
        const mod = await server.ssrLoadModule('/src/components/KpiCard.jsx')
        return renderToString(
          React.createElement(
            i18n.I18nProvider,
            null,
            React.createElement(
              vis.PublicModeProvider,
              { isPublic: true },
              React.createElement(mod.default, {
                card: { key: 'income', prefix: '¥', value: '123', unit: '元', change: null, note: 'x', spark: [1, 2] },
              }),
            ),
          ),
        )
      })(),
      ['•••'],
    ],
    [
      'DataAnalysisPage',
      await render('/src/components/DataAnalysisPage.jsx', { onBack: () => {} }),
      ['数据分析', '上传报表文件'],
    ],
    [
      'ProductCatalogPage',
      await render('/src/components/ProductCatalogPage.jsx', { onBack: () => {} }),
      ['商品目录'],
    ],
  ]
  const failures = checks.filter(([name, html, markers]) => {
    const missing = markers.filter((m) => !html.includes(m))
    if (missing.length) console.log(`${name} missing: ${missing.join(', ')}`)
    return missing.length > 0
  })
  if (failures.length) {
    console.log('SSR FAIL:', failures.map(([n]) => n).join(', '))
    process.exitCode = 1
  } else {
    console.log('SSR OK, checked:', checks.length, 'components, html length:', checks.reduce((s, [, h]) => s + h.length, 0))
  }
} catch (e) {
  console.log('SSR FAIL:', e.message)
  process.exitCode = 1
} finally {
  await server.close()
}
