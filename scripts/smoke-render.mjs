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
    ['App 登录门', await render('/src/App.jsx'), ['加载中']],
    ['LoginPage', await render('/src/components/LoginPage.jsx', { onLogin: () => {} }), ['budu', 'Operating System', '登录', '新账号由开发者创建']],
    [
      'AccountAdminPage',
      await render('/src/components/AccountAdminPage.jsx', {
        currentUser: { id: '1', username: 'budu', role: 'developer' },
        onBack: () => {},
      }),
      ['账号管理', '新增账号'],
    ],
    [
      'Dashboard unbound store account',
      await render('/src/components/Dashboard.jsx', {
        user: { username: 'staff1', role: 'staff', storeKeys: [] },
        onLogout: () => {},
        onUserChange: () => {},
      }),
      ['账号尚未绑定门店'],
    ],
    [
      'InventoryRequestPage',
      await render('/src/components/InventoryRequestPage.jsx', {
        type: 'transfer',
        currentUser: { username: 'store1', role: 'store' },
        onBack: () => {},
      }),
      ['申请调货', '提交申请', '自定义门店', '物料', '待处理', '已处理'],
    ],
    [
      'InventoryListModal',
      await render('/src/components/InventoryListModal.jsx', {
        request: {
          type: 'transfer',
          fromStoreKey: 'tongying',
          fromStoreName: '',
          storeKey: 'guanshe',
          storeName: '',
          items: [{ category: 'product', productName: '榛子生巧', quantity: 2 }],
          status: 'pending',
          createdBy: 'store1',
          createdAt: new Date().toISOString(),
        },
        onClose: () => {},
      }),
      ['货品清单', '下载图片'],
    ],
    [
      'FinancePage',
      await render('/src/components/FinancePage.jsx', {
        currentUser: { username: 'budu', role: 'developer' },
        onBack: () => {},
      }),
      ['财务利润', '费用录入'],
    ],
    [
      'Dashboard',
      await render('/src/components/Dashboard.jsx', {
        user: { username: 'budu', role: 'developer' },
        onLogout: () => {},
        onUserChange: () => {},
      }),
      ['首页概览', '门店经营'],
    ],
    ['PersonnelPage', await render('/src/components/PersonnelPage.jsx', { type: 'fulltime', onTypeChange: () => {}, onBack: () => {} }), ['人员管理', '全职人员']],
    [
      'PayrollPage',
      await render('/src/components/PayrollPage.jsx', {
        user: { username: 'budu', role: 'developer' },
        onBack: () => {},
      }),
      ['工资条', '发放工资条', '待签收', '已签收'],
    ],
    ['StoreEntryPage', await render('/src/components/StoreEntryPage.jsx', { onBack: () => {} }), ['值班人员', '选择值班人员（可多选）']],
    ['SchedulePage', await render('/src/components/SchedulePage.jsx', { onBack: () => {}, canEdit: true }), ['门店排班', '周排班表', '添加排班']],
    ['StoreRankingTable', await render('/src/components/StoreRankingTable.jsx', { month: '2026-07', store: 'all', day: null }), ['门店经营排行榜']],
    ['RevenueTrendChart', await render('/src/components/RevenueTrendChart.jsx', { month: '2026-07', store: 'all', day: null }), ['营业额趋势']],
    ['ChannelChart', await render('/src/components/ChannelChart.jsx', { month: '2026-07', store: 'all', day: null }), ['渠道销售构成']],
    ['EmployeePerformanceTable', await render('/src/components/EmployeePerformanceTable.jsx', { store: 'all', month: '2026-08', user: { role: 'developer' } }), ['员工绩效 TOP5']],
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
      'ProductCenterPage',
      await render('/src/components/ProductCenterPage.jsx', { onBack: () => {} }),
      ['商品中心', '新增商品'],
    ],
    [
      'EmployeePerformanceTable store privacy',
      await (async () => {
        const i18n = await server.ssrLoadModule('/src/i18n.jsx')
        const vis = await server.ssrLoadModule('/src/visibility.jsx')
        const mod = await server.ssrLoadModule('/src/components/EmployeePerformanceTable.jsx')
        return renderToString(
          React.createElement(
            i18n.I18nProvider,
            null,
            React.createElement(
              vis.PublicModeProvider,
              { isPublic: false, isStore: true },
              React.createElement(mod.default, { store: 'all', user: { role: 'developer' } }),
            ),
          ),
        )
      })(),
      ['•••'],
    ],
    [
      'NotificationPanel store privacy hides commission',
      await (async () => {
        const i18n = await server.ssrLoadModule('/src/i18n.jsx')
        const vis = await server.ssrLoadModule('/src/visibility.jsx')
        const mod = await server.ssrLoadModule('/src/components/NotificationPanel.jsx')
        const html = renderToString(
          React.createElement(
            i18n.I18nProvider,
            null,
            React.createElement(
              vis.PublicModeProvider,
              { isPublic: false, isStore: true },
              React.createElement(mod.default, { month: '2026-08', day: null }),
            ),
          ),
        )
        if (html.includes('业绩提成合计')) throw new Error('store role sees commission notice')
        return html
      })(),
      ['重要提醒'],
    ],
    [
      'StoreRankingTable store hides revenue',
      await (async () => {
        const i18n = await server.ssrLoadModule('/src/i18n.jsx')
        const vis = await server.ssrLoadModule('/src/visibility.jsx')
        const mod = await server.ssrLoadModule('/src/components/StoreRankingTable.jsx')
        const html = renderToString(
          React.createElement(
            i18n.I18nProvider,
            null,
            React.createElement(
              vis.PublicModeProvider,
              { isPublic: false, isStore: true },
              React.createElement(mod.default, { month: '2026-08', store: 'all', day: null }),
            ),
          ),
        )
        if (html.includes('¥')) throw new Error('store role sees revenue in ranking')
        return html
      })(),
      ['门店运营模式 · 经营数据已隐藏'],
    ],
    [
      'SettingsPage developer stores',
      await render('/src/components/SettingsPage.jsx', {
        user: { role: 'developer' },
        onBack: () => {},
      }),
      ['门店管理', '新增门店'],
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
