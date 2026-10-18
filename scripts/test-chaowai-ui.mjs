import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

globalThis.sessionStorage = { getItem: () => null }
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
after(() => vite.close())
const selectors = await vite.ssrLoadModule('/src/utils/selectors.js')
const data = await vite.ssrLoadModule('/src/utils/userData.js')
const operations = await vite.ssrLoadModule('/src/utils/storeOperations.js')
const stores = ['tongying', 'guanshe', 'chaowai', 'xidan'].map(key => ({ key, name: key, active: true }))
const fixture = {
  stores,
  entries: {
    '2026-10|chaowai|10-13': { inc: 5300, ord: 53, staff: ['合成员工'], status: 'confirmed' },
    '2026-10|tongying|10-13': { inc: 12800, ord: 128, staff: ['合成员工'], status: 'confirmed' },
  },
  staff: [],
}
function seed(active = false) { data.seedCachedDataForTest({ ...fixture, stores: stores.map(row => ({ ...row, active: row.key === 'chaowai' ? active : true })) }) }

test('完整历史目录与营业集合分离、未知状态不回退固定目录', () => {
  data.seedCachedDataForTest({ stores: [] })
  assert.deepEqual(selectors.allStoreKeys(), ['tongying', 'guanshe', 'chaowai', 'xidan'])
  assert.deepEqual(selectors.operatingStores(), [])
  seed()
  assert.deepEqual(selectors.operatingStores().map(row => row.key), ['tongying', 'guanshe', 'xidan'])
  assert.equal(selectors.storeName('chaowai'), 'chaowai')
  assert.equal(selectors.isOperatingStore('chaowai'), false)
})

test('停用前后朝外单店、公司历史合计、历史工资依据不变', () => {
  seed(true)
  const before = {
    all: selectors.aggregate('2026-10', 'all'),
    chaowai: selectors.aggregate('2026-10', 'chaowai'),
    payroll: selectors.entryMonthPayroll('2026-10'),
    entries: structuredClone(selectors.localEntries()),
  }
  assert.equal(before.payroll.size, 1)
  assert(before.payroll.has('合成员工'))
  seed(false)
  assert.deepEqual(selectors.aggregate('2026-10', 'all'), before.all)
  assert.deepEqual(selectors.aggregate('2026-10', 'chaowai'), before.chaowai)
  assert.deepEqual(selectors.entryMonthPayroll('2026-10'), before.payroll)
  assert.deepEqual(selectors.localEntries(), before.entries)
  assert.equal(before.chaowai.inc, 5300)
  assert.equal(before.all.inc, 18100)
})

test('统一中文闭店提示与已有待付提示', () => {
  seed()
  assert.equal(selectors.closedStoreMessage('chaowai'), '朝外店已停止营业，请选择其他门店。')
  assert.equal(selectors.closedStoreMessage('chaowai', true), '朝外店已停止营业，该订单无法继续发起支付，请重新选择门店下单。')
})

test('经营表单 SSR 不提供朝外新单，历史排班仍有原身份', async () => {
  seed()
  const props = { user: { id: 'fixture', username: 'fixture', role: 'developer', storeKeys: [] }, currentUser: { id: 'fixture', role: 'developer', storeKeys: [] }, onBack: () => {}, onExit: () => {} }
  const pos = await vite.ssrLoadModule('/src/components/PosPage.jsx')
  const html = renderToStaticMarkup(React.createElement(pos.default, props))
  assert.doesNotMatch(html, /option[^>]+value="chaowai"/)
  const schedule = await vite.ssrLoadModule('/src/components/SchedulePage.jsx')
  const history = renderToStaticMarkup(React.createElement(schedule.default, props))
  assert.match(history, /chaowai/)
})


test('经营视图按已确认闭店日保留当日及历史月/周，不把旧日期当新增许可', () => {
  const closed = { key: 'chaowai', active: false }
  assert.equal(operations.storeVisibleInOperatingPeriod(closed, '2026-10-13'), true)
  assert.equal(operations.storeVisibleInOperatingPeriod(closed, '2026-10-01'), true)
  assert.equal(operations.storeVisibleInOperatingPeriod(closed, '2026-10-12'), true)
  assert.equal(operations.storeVisibleInOperatingPeriod(closed, '2026-10-14'), false)
  assert.equal(operations.storeVisibleInOperatingPeriod(closed, '2026-10-19'), false)
  assert.equal(operations.storeVisibleInOperatingPeriod({ key: 'chaowai' }, '2026-10-13'), false)
  assert.equal(operations.storeVisibleInOperatingPeriod({ key: 'tongying', active: true }, '2026-10-14'), true)
  seed()
  assert.equal(selectors.isOperatingStore('chaowai'), false)
})


test('实际首页月/含闭店日周保留历史、后续周排除停用店', async () => {
  seed()
  const home = await vite.ssrLoadModule('/src/components/HomeWorkspace.jsx')
  const props = { user: { id: 'fixture', username: 'fixture', role: 'developer', storeKeys: [] }, month: '2026-10', store: 'all', onNavigate: () => {}, onSelectStore: () => {} }
  const render = extra => renderToStaticMarkup(React.createElement(home.default, { ...props, ...extra }))
  assert.match(render({ day: null, weekStart: null }), /chaowai/)
  assert.match(render({ day: null, weekStart: '2026-10-12' }), /chaowai/)
  assert.doesNotMatch(render({ day: null, weekStart: '2026-10-19' }), /chaowai/)
})

test('实际loadUserData只接受合法PG授权门店投影，保留v2优先级与原403', async () => {
  const originalFetch = globalThis.fetch
  const rows = [{ key: 'tongying', name: '通盈合成', active: true }]
  const cases = [
    { label: '营业PG投影', payload: { storesAuthority: 'postgresql', stores: rows }, expected: ['tongying'], readState: 'DATA' },
    { label: '关闭PG投影', payload: { storesAuthority: 'postgresql', stores: [{ key: 'chaowai', name: '朝外合成', active: false }] }, expected: [], readState: 'DATA', closed: true },
    { label: '旧KV无marker', payload: { stores: rows }, expected: [], readState: 'ERROR' },
    { label: '不可用标记', payload: { storesAuthority: 'unavailable', stores: rows }, expected: [], readState: 'ERROR' },
    { label: '非法稳定key', payload: { storesAuthority: 'postgresql', stores: [{ key: 'ghost', active: true }] }, expected: [], readState: 'ERROR' },
    { label: 'active非boolean', payload: { storesAuthority: 'postgresql', stores: [{ key: 'tongying', active: 'true' }] }, expected: [], readState: 'ERROR' },
    { label: '重复门店key', payload: { storesAuthority: 'postgresql', stores: [...rows, ...rows] }, expected: [], readState: 'ERROR' },
    { label: 'v2成功空目录优先', payload: { storesAuthority: 'postgresql', stores: rows }, v2: [], expected: [], readState: 'REAL_EMPTY' },
    { label: 'PG空投影合法', payload: { storesAuthority: 'postgresql', stores: [] }, expected: [], readState: 'REAL_EMPTY' },
  ]
  try {
    for (const scenario of cases) {
      data.resetUserData()
      const calls = []
      globalThis.fetch = async url => {
        calls.push(String(url))
        const response = String(url) === '/api/userdata' ? scenario.payload
          : String(url) === '/api/v2/stores' && scenario.v2 === undefined ? { error: 'permission denied' }
            : { rows: String(url) === '/api/v2/stores' ? scenario.v2 : [] }
        return new Response(JSON.stringify(response), { status: String(url) === '/api/v2/stores' && scenario.v2 === undefined ? 403 : 200, headers: { 'Content-Type': 'application/json' } })
      }
      await data.loadUserData({ userId: `cashier-${scenario.label}` })
      assert.deepEqual(selectors.operatingStores().map(row => row.key), scenario.expected, scenario.label)
      assert.equal(data.getPersonnelReadState('stores').status, scenario.readState, scenario.label)
      if (scenario.closed) assert.equal(selectors.allStores().find(row => row.key === 'chaowai').active, false)
      assert(calls.includes('/api/userdata'))
      assert(calls.includes('/api/v2/stores'))
    }
  } finally { globalThis.fetch = originalFetch }
})
