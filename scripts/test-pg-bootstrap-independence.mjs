import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// Gate 1：真实执行 loadUserData，证明 legacy /userdata 不再阻塞 PostgreSQL authority bootstrap。
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getUserData,
  getInventoryRequests,
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


const transferRow = (id, overrides = {}) => ({
  id, storeKey: 'synth-to', fromStoreKey: 'synth-from', status: 'pending',
  createdAt: '2026-10-06T08:00:00.000Z', updatedAt: '2026-10-06T08:00:00.000Z',
  createdBy: 'synthetic-actor', note: 'synthetic-note', items: [], ...overrides,
})
const purchaseRow = (id, overrides = {}) => ({ id, storeKey: 'synth-to', status: 'pending', items: [], ...overrides })
const retiredPurchase = () => json({ error: 'retired purchase endpoint' }, 410)
const transferCache = () => getInventoryRequests().filter(row => row.type === 'transfer')
async function seedPgRequestSnapshot() {
  installFetch({ legacy: {}, pg: pgResponses({
    '/api/v2/transfer-requests': { rows: [transferRow('tr-previous', { createdAt: '2026-10-04T08:00:00.000Z' })] },
    '/api/v2/purchase-requests': { rows: [purchaseRow('purchase-previous')] },
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  return structuredClone(getInventoryRequests())
}

test('Transfer cache CASE1: fresh pending PG transfer replaces old subset despite purchase410', async () => {
  const before = await seedPgRequestSnapshot()
  installFetch({ legacy: { inventoryRequests: [{ id: 'tr-kv', type: 'transfer' }] }, pg: pgResponses({
    '/api/v2/transfer-requests': { rows: [transferRow('tr-new')] },
    '/api/v2/purchase-requests': retiredPurchase(),
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(transferCache().map(row => row.id), ['tr-new'])
  assert.deepEqual(getInventoryRequests().filter(row => row.type === 'purchase'), before.filter(row => row.type === 'purchase'))
})

test('Transfer cache CASE2: authoritative empty PG transfer clears old subset despite purchase failure', async () => {
  const before = await seedPgRequestSnapshot()
  installFetch({ legacy: { inventoryRequests: before }, pg: pgResponses({
    '/api/v2/transfer-requests': { rows: [] }, '/api/v2/purchase-requests': retiredPurchase(),
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(transferCache(), [])
  assert.deepEqual(getInventoryRequests().filter(row => row.type === 'purchase'), before.filter(row => row.type === 'purchase'))
})

test('Transfer cache CASE3: both PG domains failing retain the last successful PG request snapshot', async () => {
  const before = await seedPgRequestSnapshot()
  installFetch({ legacy: {}, pg: pgResponses({
    '/api/v2/transfer-requests': json({ error: 'unavailable' }, 503), '/api/v2/purchase-requests': retiredPurchase(),
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(getInventoryRequests(), before)
})

test('Transfer cache CASE4: both PG domains succeeding preserve transfer/purchase merge and received mapping', async () => {
  await seedPgRequestSnapshot()
  installFetch({ legacy: {}, pg: pgResponses({
    '/api/v2/transfer-requests': { rows: [transferRow('tr-new')] },
    '/api/v2/purchase-requests': { rows: [purchaseRow('purchase-new', { status: 'received', supplier: 'synthetic-supplier' })] },
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(getInventoryRequests().map(row => [row.type, row.id, row.status]), [['transfer', 'tr-new', 'pending'], ['purchase', 'purchase-new', 'done']])
  assert.equal(getInventoryRequests()[1].supplier, 'synthetic-supplier')
})

test('Transfer cache CASE5: failed transfer cannot restore legacy userdata transfers or overwrite successful PG history', async () => {
  const before = await seedPgRequestSnapshot()
  installFetch({ legacy: { inventoryRequests: [{ id: 'tr-kv-old', type: 'transfer', status: 'shipped' }] }, pg: pgResponses({
    '/api/v2/transfer-requests': json({ error: 'unavailable' }, 503), '/api/v2/purchase-requests': retiredPurchase(),
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(getInventoryRequests(), before)
  assert(!getInventoryRequests().some(row => row.id === 'tr-kv-old'))
})

test('Transfer cache CASE6: newest pending stable identity, timestamps, stores, items and delivery facts survive selector', async () => {
  const item = { itemId: 'item-stable', itemCode: 'code-stable', productName: 'synthetic-product', category: 'product', productCategory: 'synthetic-category', quantity: null, boxQuantity: 2, pieceQuantity: 3, shippedQuantity: null, shippedBoxQuantity: 0, shippedPieceQuantity: 0, shipmentRecorded: false, boxWeightGrams: 1000, pieceWeightGrams: 6, estimatedWeightGrams: 2018, note: 'synthetic-item-note' }
  const deliveryRecipients = { source: 'notification_delivery', successful: [{ key: 'synthetic-recipient', label: 'synthetic-recipient', status: 'sent' }], undelivered: [] }
  const row = transferRow('tr-new', { items: [item], deliveryRecipients, storeName: 'synthetic-to', fromStoreName: 'synthetic-from' })
  installFetch({ legacy: {}, pg: pgResponses({ '/api/v2/transfer-requests': { rows: [row] }, '/api/v2/purchase-requests': retiredPurchase() }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  const selected = transferCache().find(value => value.id === 'tr-new')
  assert(selected)
  for (const key of ['status', 'createdAt', 'updatedAt', 'storeKey', 'fromStoreKey', 'storeName', 'fromStoreName', 'createdBy', 'note']) assert.equal(selected[key], row[key])
  assert.deepEqual(selected.items[0], item)
  assert.deepEqual(selected.deliveryRecipients, deliveryRecipients)
})

test('Transfer cache CASE7: historical shipped/canceled transitions and shipment/withdrawal snapshots stay unchanged', async () => {
  const shipped = transferRow('tr-shipped', { status: 'shipped', shippedBy: 'synthetic-shipper', shippedAt: '2026-10-04T09:00:00.000Z', shipmentRecorded: true })
  const canceled = transferRow('tr-canceled', { status: 'canceled', withdrawnBy: 'synthetic-withdrawer', withdrawnAt: '2026-10-04T10:00:00.000Z' })
  installFetch({ legacy: {}, pg: pgResponses({ '/api/v2/transfer-requests': { rows: [shipped, canceled] }, '/api/v2/purchase-requests': retiredPurchase() }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(transferCache().map(row => row.status), ['shipped', 'canceled'])
  for (const source of [shipped, canceled]) {
    const value = transferCache().find(row => row.id === source.id)
    for (const key of ['shippedBy', 'shippedAt', 'withdrawnBy', 'withdrawnAt']) assert.equal(value[key], source[key] || (key.endsWith('At') ? null : ''))
    assert.deepEqual(value.history, [])
  }
  assert.equal(transferCache()[0].shipmentRecorded, true)
})

test('Transfer cache CASE8: load is GET-only and existing create/ship/withdraw/notification/page sources are immutable', async () => {
  const calls = []
  globalThis.fetch = async (url, options = {}) => { calls.push(options.method || 'GET'); return json(String(url) === '/api/userdata' ? {} : { rows: [] }) }
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert(calls.length > 0 && calls.every(method => method === 'GET'))
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  for (const file of ['server/v2.js', 'server/transfer-notification.js', 'src/components/StoreTransferPage.jsx', 'server/purchase-receipt.js', 'prisma/schema.prisma']) {
    const baseline = execFileSync('git', ['-C', root, 'show', '1952969a64ee9d651cf70482e51ccd3928015a49:' + file])
    assert.deepEqual(fs.readFileSync(path.join(root, file)), baseline, file)
  }
})

test('Transfer cache malformed PG rows retain the successful domain while the other domain refreshes independently', async () => {
  const before = await seedPgRequestSnapshot()
  installFetch({ legacy: { inventoryRequests: [{ id: 'tr-kv', type: 'transfer' }] }, pg: pgResponses({
    '/api/v2/transfer-requests': { rows: null }, '/api/v2/purchase-requests': { rows: [] },
  }) })
  await loadUserData({ userId: 'transfer-cache-authority' })
  assert.deepEqual(transferCache(), before.filter(row => row.type === 'transfer'))
  assert.deepEqual(getInventoryRequests().filter(row => row.type === 'purchase'), [])
})
