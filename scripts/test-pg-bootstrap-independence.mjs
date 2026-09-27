// Gate 1：真实执行 loadUserData，证明 legacy /userdata 不再阻塞 PostgreSQL authority bootstrap。
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getUserData,
  loadUserData,
  resetUserData,
} from '../src/utils/userData.js'
import { transferQuantityLabel } from '../src/utils/storeTransfer.js'

const originalFetch = globalThis.fetch

const pgPaths = [
  '/api/v2/daily-entries',
  '/api/v2/daily-pay-adjustments',
  '/api/v2/pos/daily-summary',
  '/api/v2/pos/product-sales',
  '/api/v2/transfer-requests',
  '/api/v2/purchase-requests',
  '/api/v2/stock',
  '/api/v2/big-bonuses',
  '/api/v2/staff-list',
  '/api/v2/stores',
]

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pgResponses(overrides = {}) {
  return {
    '/api/v2/daily-entries': { rows: [] },
    '/api/v2/daily-pay-adjustments': { rows: [] },
    '/api/v2/pos/daily-summary': { rows: [] },
    '/api/v2/pos/product-sales': { rows: [] },
    '/api/v2/transfer-requests': { rows: [] },
    '/api/v2/purchase-requests': { rows: [] },
    '/api/v2/stock': { rows: [] },
    '/api/v2/big-bonuses': { rows: [] },
    '/api/v2/staff-list': { rows: [] },
    '/api/v2/stores': { rows: [] },
    ...overrides,
  }
}

function installFetch({ legacy, pg = pgResponses() }) {
  const calls = []
  globalThis.fetch = async (url) => {
    const path = String(url)
    calls.push(path)
    if (path === '/api/userdata') return legacy instanceof Response ? legacy : json(legacy)
    const response = pg[path]
    if (response instanceof Response) return response
    if (response !== undefined) return json(response)
    return json({ error: `unexpected request: ${path}` }, 404)
  }
  return calls
}

afterEach(() => {
  resetUserData()
  globalThis.fetch = originalFetch
})

test('Gate 1 Scenario A: legacy 与 PG 都成功时各自数据正常进入缓存', async () => {
  installFetch({
    legacy: {
      analysis: { source: 'legacy' },
      productImages: { skuA: 'legacy-image' },
      staff: [{ name: 'KV 员工不得采用' }],
      stores: [{ key: 'ghost', name: 'KV 幽灵门店' }],
      entries: { legacy: { inc: 999 } },
    },
    pg: pgResponses({
      '/api/v2/daily-entries': {
        rows: [{ date: '2026-08-24', storeKey: 'chaowai', incCents: 19800, ord: 1, staffNames: ['PG 员工'], version: 3 }],
      },
      '/api/v2/staff-list': { rows: [{ id: 'emp-pg', name: 'PG 员工', storeKey: 'chaowai' }] },
      '/api/v2/stores': { rows: [{ key: 'chaowai', name: '北京朝外店' }] },
    }),
  })

  await loadUserData({ userId: 'scenario-a' })
  const data = getUserData()
  assert.deepEqual(data.analysis, { source: 'legacy' })
  assert.deepEqual(data.productImages, { skuA: 'legacy-image' })
  assert.equal(data.staff[0].id, 'emp-pg')
  assert.deepEqual(data.stores, [{ key: 'chaowai', name: '北京朝外店' }])
  assert.equal(data.entries['2026-08|chaowai|08-24'].inc, 198)
})

test('Gate 1 Scenario B: /userdata 未完成并最终失败时，PG 请求仍独立启动并写入缓存', async () => {
  const calls = []
  let resolveLegacy
  const legacyResponse = new Promise((resolve) => { resolveLegacy = resolve })
  const pg = pgResponses({
    '/api/v2/daily-entries': {
      rows: [{ date: '2026-08-24', storeKey: 'chaowai', incCents: 19800, ord: 1, staffNames: ['PG 员工'], version: 1 }],
    },
    '/api/v2/staff-list': { rows: [{ id: 'emp-pg', name: 'PG 员工', storeKey: 'chaowai' }] },
    '/api/v2/stores': { rows: [{ key: 'chaowai', name: '北京朝外店' }] },
  })
  globalThis.fetch = async (url) => {
    const path = String(url)
    calls.push(path)
    if (path === '/api/userdata') return legacyResponse
    return json(pg[path])
  }

  let baseReadyCalls = 0
  const loading = loadUserData({
    userId: 'scenario-b',
    onBaseReady: () => { baseReadyCalls += 1 },
  })
  await new Promise((resolve) => setImmediate(resolve))
  for (const path of pgPaths) {
    assert.ok(calls.includes(path), `${path} 在 /userdata settle 前已经发出`)
  }
  resolveLegacy(json({ error: 'legacy unavailable' }, 500))
  await loading

  const data = getUserData()
  assert.equal(baseReadyCalls, 1)
  assert.equal(data.staff[0].id, 'emp-pg')
  assert.deepEqual(data.stores, [{ key: 'chaowai', name: '北京朝外店' }])
  assert.equal(data.entries['2026-08|chaowai|08-24'].inc, 198)
})

test('Gate 1 Scenario C: PG 权威接口失败时不回退 legacy staff / entries / stores', async () => {
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    installFetch({
      legacy: {
        staff: [{ name: 'KV 员工' }],
        entries: { '2026-08|ghost|08-24': { inc: 999, ord: 9 } },
        stores: [{ key: 'ghost', name: 'KV 幽灵门店' }],
      },
      pg: pgResponses({
        '/api/v2/daily-entries': json({ error: 'postgres unavailable' }, 500),
        '/api/v2/staff-list': json({ error: 'postgres unavailable' }, 500),
        '/api/v2/stores': json({ error: 'postgres unavailable' }, 500),
      }),
    })
    await loadUserData({ userId: 'scenario-c' })
  } finally {
    console.error = originalError
  }

  assert.deepEqual(getUserData().staff, [])
  assert.deepEqual(getUserData().entries, {})
  assert.deepEqual(getUserData().stores, [])
  assert.ok(errors.some((line) => line.includes('员工名单读取失败') && line.includes('不使用 KV 回退')))
  assert.ok(errors.some((line) => line.includes('DailyEntry 读取失败') && line.includes('不使用 KV 回退')))
})

test('Gate 1 Scenario D: PG daily entries 的空数组覆盖 legacy entries', async () => {
  installFetch({
    legacy: { entries: { '2026-08|chaowai|08-24': { inc: 999, ord: 9 } } },
    pg: pgResponses({ '/api/v2/daily-entries': { rows: [] } }),
  })

  await loadUserData({ userId: 'scenario-d' })
  assert.deepEqual(getUserData().entries, {})
})

test('Gate 1 Scenario E: 调拨箱/颗字段从 PG API 完整进入前端缓存', async () => {
  installFetch({
    legacy: {},
    pg: pgResponses({
      '/api/v2/transfer-requests': {
        rows: [{
          id: 'tr-piece-166',
          storeKey: 'chaowai',
          fromStoreKey: 'guanshe',
          status: 'pending',
          createdAt: '2026-08-30T05:47:27.595Z',
          updatedAt: '2026-08-30T05:47:27.595Z',
          items: [{
            itemId: 'product-no2',
            category: 'product',
            productName: 'NO.2 柠檬',
            itemCode: 'NO.2',
            productCategory: '糖果',
            quantity: null,
            boxQuantity: 0,
            pieceQuantity: 166,
            shippedBoxQuantity: 0,
            shippedPieceQuantity: 120,
            shipmentRecorded: true,
            boxWeightGrams: null,
            pieceWeightGrams: 6,
            estimatedWeightGrams: 996,
          }],
        }],
      },
    }),
  })

  await loadUserData({ userId: 'scenario-e' })
  const item = getUserData().inventoryRequests[0].items[0]
  assert.equal(item.quantity, null)
  assert.equal(item.boxQuantity, 0)
  assert.equal(item.pieceQuantity, 166)
  assert.equal(item.shippedBoxQuantity, 0)
  assert.equal(item.shippedPieceQuantity, 120)
  assert.equal(item.shipmentRecorded, true)
  assert.equal(item.pieceWeightGrams, 6)
  assert.equal(item.estimatedWeightGrams, 996)
  assert.equal(item.productCategory, '糖果')
  assert.equal(transferQuantityLabel(item), '166颗')
})
