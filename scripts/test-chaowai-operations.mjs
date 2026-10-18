import assert from 'node:assert/strict'
import test from 'node:test'

// Synthetic-only route tests. No network, real Prisma client or database is created.
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/chaowai_synthetic_only'
for (const key of ['WECHAT_WORK_WEBHOOK_URL', 'WXWORK_CORP_ID', 'WXWORK_AGENT_ID', 'WXWORK_SECRET', 'MP_APP_ID', 'MP_APP_SECRET', 'MP_TEMPLATE_ID']) delete process.env[key]
const externalAttempts = []
globalThis.fetch = async (...args) => { externalAttempts.push('BLOCKED_EXTERNAL_ATTEMPT'); throw new Error('external calls forbidden in synthetic operation tests') }
let writes = []
let rawQueries = []
let fixture = {}
const operatingKeys = ['tongying', 'guanshe', 'xidan']
let stores = new Map()
const user = (role = 'developer', storeKeys = ['chaowai', ...operatingKeys]) => ({
  id: `synthetic-${role}`, username: `synthetic-${role}`, role, status: 'active', storeKeys,
  permissions: { purchaseManage: true },
})
const known = {
  dailyEntry: { id: 'historical-daily', storeKey: 'chaowai', date: new Date('2026-10-13'), incCents: 10000n, ord: 2, staffNames: [], status: 'confirmed', version: 1, salesDataStatus: 'synced', hybridAdjustmentCents: 0n },
  expense: { id: 'historical-expense', storeKey: 'chaowai', date: new Date('2026-10-13'), amountCents: 2000n },
  purchaseRequest: { id: 'historical-purchase', storeKey: 'chaowai', status: 'pending', items: [] },
  procurementOrder: { id: 'historical-procurement', storeKey: 'chaowai', status: 'ORDERED', version: 1, orderRevision: 1, createdById: 'synthetic-developer', lines: [], receipts: [], draftContent: { storeKey: 'chaowai', supplierNameSnapshot: '合成供应商', storeNameSnapshot: '朝外', items: [{ productNameSnapshot: '合成货品', quantity: '1', unit: '箱' }] } },
  invoice: { id: 'historical-invoice', storeKey: 'chaowai', status: 'pending', amountCents: 10000n },
  mailingRecord: { id: 'historical-mailing', storeKey: 'chaowai', status: 'pending' },
  transferRequest: { id: 'historical-transfer', fromStoreKey: 'chaowai', toStoreKey: 'guanshe', status: 'pending', items: [] },
  replenishmentOrder: { id: 'synthetic-replenishment', status: 'APPROVED', partnerId: 'synthetic-partner', items: [] },
  member: { id: 'synthetic-member', points: 10, consumptions: [{ id: 'historical-consumption', storeKey: 'chaowai', date: new Date('2026-10-13'), amountCents: 10000n }] },
}
function reset(active = false) {
  writes = []; rawQueries = []; fixture = {}
  stores = new Map(['chaowai', ...operatingKeys].map(key => [key, { key, name: key === 'chaowai' ? '朝外' : key, active: key !== 'chaowai' || active, salesDataSource: 'manual' }]))
}
const models = new Map()
function model(name) {
  if (models.has(name)) return models.get(name)
  const value = new Proxy({}, { get(_, method) {
    return async input => {
      if (fixture[`${name}.${method}`]) return fixture[`${name}.${method}`](input)
      if (method === 'findUnique' || method === 'findFirst') {
        if (name === 'store') return stores.get(input.where.key) || null
        if (name === 'user') return user()
        if (name === 'customerServiceRequestToken') return null
        if (name === 'procurementAudit' || name === 'orderPurposeAudit') return null
        return known[name] || null
      }
      if (method === 'findMany') {
        if (name === 'store') return [...stores.values()].filter(row => {
          if (typeof input?.where?.active === 'boolean' && row.active !== input.where.active) return false
          if (typeof input?.where?.key === 'string' && row.key !== input.where.key) return false
          if (input?.where?.key?.in && !input.where.key.in.includes(row.key)) return false
          return true
        })
        if (name === 'dailyEntry') return [known.dailyEntry]
        if (name === 'expense') return [known.expense]
        if (name === 'schedule') return [{ id: 'historical-schedule', weekStart: '2026-10-12', storeKey: 'chaowai', date: '2026-10-13', shifts: [], updatedAt: new Date('2026-10-13') }]
        return []
      }
      if (method === 'count') return 0
      writes.push({ name, method, input })
      if (name === 'store' && method === 'upsert') {
        const existing = stores.get(input.where.key)
        const row = existing ? { ...existing, ...input.update } : { ...input.create }
        stores.set(row.key, row)
        return row
      }
      if (method === 'updateMany' || method === 'deleteMany') return { count: 1 }
      const data = input?.data || {}
      if (name === 'procurementOrder') return { ...known.procurementOrder, ...data, lines: [], receipts: [] }
      if (name === 'customerServiceRequest') return { ...data, tokens: [] }
      return { ...known[name], ...data }
    }
  } })
  models.set(name, value)
  return value
}
const db = new Proxy({}, { get(_, name) {
  if (name === '$transaction') return async fn => Array.isArray(fn) ? Promise.all(fn) : fn(db)
  if (name === '$queryRawUnsafe') return async (sql, ...params) => {
    rawQueries.push({ sql, params })
    if (sql.includes('"Store"')) {
      const keys = params.flat().filter(key => typeof key === 'string')
      return keys.map(key => stores.get(key)).filter(Boolean)
    }
    return [{ locked: 1 }]
  }
  if (name === '$executeRaw') return async () => 0
  if (name === '$disconnect') return async () => {}
  return model(name)
} })
globalThis.__buduPrisma = db
const { v2Router } = await import('../server/v2.js')
const { scheduleRouter, replaceScheduleStoresAtomic, EMPTY_SCHEDULE_VERSION } = await import('../server/schedule.js')
const { dailyEntryUpgradeRouter, confirmDailyEntryAtomic, reviseConfirmedDailyEntryAtomic } = await import('../server/daily-entry-upgrade.js')
const { purchaseReceiptRouter } = await import('../server/purchase-receipt.js')
const { getDailyCorrectionContext, correctDailyPerformance } = await import('../server/daily-performance-correction.js')
const { CHAOWAI_BUSINESS_CLOSED_ON } = await import('../shared/storeOperationDates.js')
const { createReplenishmentShipment } = await import('../server/replenishment-shipment-service.js')
const { createCustomerServiceRequest, submitCustomerServiceRequest } = await import('../server/customer-requests.js')

async function route(router, method, path, { body = {}, actor = user(), params = {}, query = {} } = {}) {
  const layer = router.stack.find(row => row.route?.path === path && row.route.methods[method.toLowerCase()])
  assert.ok(layer, `real route exists: ${method} ${path}`)
  const req = { method, path, body, user: actor, params, query, get: () => 'synthetic-request-20261014' }
  const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; return this }, status(value) { this.statusCode = value; return this }, json(value) { this.body = value; return this } }
  await layer.route.stack[0].handle(req, response)
  return response
}
function expectClosed(response) {
  assert.equal(response.statusCode, 409)
  assert.equal(response.body.code, 'STORE_CLOSED')
  assert.equal(writes.length, 0, 'no synthetic business changes before rejection')
}

for (const role of ['developer', 'admin', 'manager']) {
  for (const direction of ['from', 'to']) test(`transfer ${direction} rejects closed store for ${role}`, async () => {
    reset()
    const response = await route(v2Router, 'POST', '/transfer-requests', { actor: user(role), body: {
      fromStoreKey: direction === 'from' ? 'chaowai' : 'guanshe',
      toStoreKey: direction === 'to' ? 'chaowai' : 'guanshe',
      items: [{ name: '合成货品', itemId: 'synthetic-item', quantity: 1, category: 'product' }],
    } })
    expectClosed(response)
  })
}
const closedRoutes = [
  [v2Router, 'PUT', '/daily-entries', { storeKey: 'chaowai', date: '2026-01-01', incCents: 1, ord: 1 }],
  [dailyEntryUpgradeRouter, 'PUT', '/daily-staff', { storeKey: 'chaowai', date: '2026-01-01', items: [] }],
  [v2Router, 'POST', '/stock/adjust', { storeKey: 'chaowai', items: [{ itemId: 'synthetic-item', quantity: 1 }] }],
  [v2Router, 'POST', '/stock/waste', { storeKey: 'chaowai', items: [{ itemId: 'synthetic-item', quantity: 1 }] }],
  [v2Router, 'POST', '/expenses', { storeKey: 'chaowai', date: '2026-01-01', amountCents: 1 }],
  [v2Router, 'POST', '/members/:id/consumptions', { storeKey: 'chaowai', date: '2026-01-01', amountCents: 1 }],
  [v2Router, 'POST', '/purchase-requests/:id/receive', { items: [] }],
  [v2Router, 'POST', '/mailing-records', { storeKey: 'chaowai' }],
  [purchaseReceiptRouter, 'POST', '/procurement/orders', { requestKey: 'synthetic-create-20261014', content: { storeKey: 'chaowai', items: [] } }],
  [purchaseReceiptRouter, 'PUT', '/procurement/orders/:id', { requestKey: 'synthetic-edit-20261014', version: 1, content: { storeKey: 'guanshe', items: [] } }],
  [purchaseReceiptRouter, 'POST', '/procurement/orders/:id/mark-ordered', { requestKey: 'synthetic-order-20261014', version: 1 }],
  [purchaseReceiptRouter, 'POST', '/procurement/orders/:id/receipts', { requestKey: 'synthetic-receipt-20261014', receivedDate: '2026-01-01', items: [] }],
]
for (const [router, method, path, body] of closedRoutes) test(`${method} ${path} rejects closed operational store before side effects`, async () => {
  reset()
  if (path === '/procurement/orders') fixture['procurementOrder.findUnique'] = async input => input?.where?.createRequestKey ? null : known.procurementOrder
  if (path === '/procurement/orders/:id/mark-ordered') fixture['procurementOrder.findUnique'] = async () => ({ ...known.procurementOrder, status: 'DRAFT' })
  const response = await route(router, method, path, { body, params: { id: path.includes('purchase-requests') ? 'historical-purchase' : 'historical-procurement' } })
  expectClosed(response)
})

test('old date cannot bypass batch or legacy schedule save', async () => {
  for (const requireVersions of [true, false]) {
    reset()
    await assert.rejects(replaceScheduleStoresAtomic(db, { weekStart: '2026-01-05', requireVersions, stores: [{ storeKey: 'chaowai', days: {}, version: EMPTY_SCHEDULE_VERSION }] }), error => error.status === 409 && error.code === 'STORE_CLOSED')
    assert.equal(writes.length, 0)
  }
})

test('unauthorized route returns original permission error before revealing closed status', async () => {
  reset()
  const response = await route(v2Router, 'POST', '/expenses', { actor: user('staff', ['guanshe']), body: { storeKey: 'chaowai', amountCents: 1 } })
  assert.equal(response.statusCode, 403)
  assert.equal(response.body.code, undefined)
  assert.equal(rawQueries.length, 0)
  assert.equal(writes.length, 0)
})

test('closed single-store actor cannot omit mailing store to bypass rejection', async () => {
  reset()
  expectClosed(await route(v2Router, 'POST', '/mailing-records', { actor: user('staff', ['chaowai']), body: {} }))
})

test('normal confirmation of a closed store rejects even for developer and backdated facts', async () => {
  reset()
  await assert.rejects(confirmDailyEntryAtomic(db, { storeKey: 'chaowai', date: '2026-01-01', version: 0, actor: user(), items: [{ employeeId: 'synthetic-employee', actualHours: 8 }], manualSales: { incCents: 1, ord: 1 } }), error => error.code === 'STORE_CLOSED')
  assert.equal(writes.length, 0)
})

test('closed-store confirmed history revision rejects administrator while leaving old records untouched', async () => {
  reset()
  await assert.rejects(reviseConfirmedDailyEntryAtomic(db, { storeKey: 'chaowai', date: '2026-10-13', version: 1, actor: user('admin'), reason: '合成历史纠错', items: [{ employeeId: 'synthetic-employee', actualHours: 8 }], manualSales: { incCents: 11000, ord: 2 } }), error => error.status === 403)
  assert.equal(writes.length, 0)
})

test('new mailing request checks active authority and not the client date or object', async () => {
  reset()
  await assert.rejects(createCustomerServiceRequest({ prismaClient: db, user: user(), origin: 'https://synthetic.example.test', input: { type: 'MAILING', storeKey: 'chaowai', date: '2026-01-01', store: { key: 'chaowai', active: true } } }), error => error.code === 'STORE_CLOSED')
  assert.equal(writes.length, 0)
})

test('old mailing token uses saved closed store before token consumption or new notification', async () => {
  reset()
  const now = new Date('2026-10-14T01:00:00Z')
  fixture['customerServiceRequestToken.findUnique'] = async () => ({ id: 'synthetic-token', tokenHash: 'synthetic', requestId: 'old-request', status: 'ACTIVE', expiresAt: new Date(+now + 60000), request: { id: 'old-request', type: 'MAILING', storeKey: 'chaowai', status: 'WAITING_CUSTOMER', expiresAt: new Date(+now + 60000) } })
  await assert.rejects(submitCustomerServiceRequest({ prismaClient: db, token: 'A'.repeat(43), now, payload: { storeKey: 'guanshe', address: '合成地址' } }), error => error.code === 'STORE_CLOSED')
  assert.equal(writes.length, 0)
})

for (const key of operatingKeys) test(`new expense in ${key} preserves existing business behavior`, async () => {
  reset()
  const response = await route(v2Router, 'POST', '/expenses', { body: { storeKey: key, date: '2026-10-14', amountCents: 123, category: '合成支出' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.expense.storeKey, key)
  assert.equal(response.body.expense.amountCents, '123')
  assert.ok(rawQueries.some(query => query.sql.includes('FOR SHARE') && query.params.includes(key)))
  assert.equal(writes.filter(write => write.name === 'expense' && write.method === 'create').length, 1)
})

test('historical daily/expense/schedule/member views keep the same values and names after stopping store', async () => {
  const before = []
  const after = []
  const paths = [
    [v2Router, '/daily-entries', { store: 'chaowai', month: '2026-10' }],
    [v2Router, '/expenses', { store: 'chaowai', month: '2026-10' }],
    [scheduleRouter, '/schedules', { store: 'chaowai', weekStart: '2026-10-12' }],
    [v2Router, '/members/:id', {}],
    [purchaseReceiptRouter, '/procurement/orders/:id/export-data', {}],
    [v2Router, '/profit', { month: '2026-10' }],
    [v2Router, '/profit', { month: '2026-10', store: 'chaowai' }],
  ]
  for (const [active, outputs] of [[true, before], [false, after]]) {
    reset(active)
    for (const [router, path, query] of paths) {
      const response = await route(router, 'GET', path, { params: { id: path.includes('member') ? 'synthetic-member' : 'historical-procurement' }, query })
      assert.equal(response.statusCode, 200, path)
      outputs.push(response.body)
    }
    assert.equal(writes.length, 0)
  }
  assert.deepEqual(after, before)
  assert.equal(after[0].rows[0].incCents, '10000')
  assert.equal(after[1].rows[0].amountCents, '2000')
  assert.equal(after[2].rows[0].storeKey, 'chaowai')
  assert.equal(after[3].consumptions[0].storeKey, 'chaowai')
  assert.equal(after[4].store, '朝外')
  for (const index of [5, 6]) {
    assert.equal(after[index].monthly[0].storeKey, 'chaowai')
    assert.equal(after[index].monthly[0].incCents, '10000')
    assert.equal(after[index].monthly[0].expenseCents, '2000')
    assert.equal(after[index].monthly[0].profitCents, '8000')
  }
})

test('developer after-sales invoice preserves existing store flag/name without upsert', async () => {
  reset()
  const response = await route(v2Router, 'POST', '/invoices', { body: { storeKey: 'chaowai', titleType: 'personal', amountCents: 100, category: '食品' } })
  assert.equal(response.statusCode, 200)
  assert.equal(stores.get('chaowai').active, false)
  assert.equal(writes.some(write => write.name === 'store'), false)
  assert.equal(stores.get('chaowai').name, '朝外')
  assert.equal(response.body.invoice.storeKey, 'chaowai')
  assert.equal(response.body.invoice.amountCents, '100')
})

test('administrator cannot create closed-store after-sales invoice or change business source config', async () => {
  for (const [router, method, path, body] of [
    [v2Router, 'POST', '/invoices', { storeKey: 'chaowai', titleType: 'personal', amountCents: 100 }],
    [dailyEntryUpgradeRouter, 'PUT', '/store-sales-source', { storeKey: 'chaowai', salesDataSource: 'manual' }],
  ]) {
    reset()
    const response = await route(router, method, path, { actor: user('admin'), body })
    assert.equal(response.statusCode, 403)
    assert.equal(writes.length, 0)
    assert.equal(stores.get('chaowai').active, false)
  }
})

test('closed-store existing back-office actions require developer without denying historical read', async () => {
  for (const [router, method, path, body] of [
    [v2Router, 'POST', '/transfer-requests/:id/reject', {}],
    [v2Router, 'POST', '/invoices/:id/status', { status: 'done' }],
    [v2Router, 'POST', '/mailing-records/:id/ship', {}],
    [purchaseReceiptRouter, 'POST', '/procurement/orders/:id/cancel', { requestKey: 'synthetic-cancel-20261014', version: 1 }],
  ]) {
    reset()
    fixture['user.findUnique'] = async () => user('admin')
    const response = await route(router, method, path, { actor: user('admin'), body, params: { id: 'synthetic-history' } })
    assert.equal(response.statusCode, 403, path)
    assert.equal(writes.length, 0, path)
  }
})

test('actual replenishment shipment service rejects closed fulfillment store after original actor checks', async () => {
  reset()
  await assert.rejects(createReplenishmentShipment({ db, actor: { id: user().id }, orderId: 'synthetic-replenishment', idempotencyKey: 'synthetic-shipment-20261014', body: {
    fulfillmentStoreKey: 'chaowai', carrier: '合成快递', trackingNumber: 'synthetic-only', freightType: 'PREPAID', items: [{ orderItemId: 'synthetic-rpl-item', shippedQuantityBase: 1 }],
  } }), error => error.status === 409 && error.code === 'STORE_CLOSED')
  assert.equal(writes.length, 0)
})

test('procurement store directory keeps authorized historical closed identity plus explicit active flag', async () => {
  reset()
  let selection
  fixture['store.findMany'] = async input => { selection = input; return [...stores.values()] }
  const response = await route(purchaseReceiptRouter, 'GET', '/procurement/stores')
  assert.equal(response.statusCode, 200)
  assert.equal(selection.where.active, undefined)
  assert.equal(selection.select.active, true)
  assert.ok(response.body.rows.some(row => row.key === 'chaowai' && row.active === false))
  assert.equal(response.body.rows.filter(row => row.active).length, 3)
  assert.equal(writes.length, 0)
})

test('primary OS store directory returns all four historical identities with active booleans and original permission denial', async () => {
  reset()
  const response = await route(v2Router, 'GET', '/stores')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.rows.length, 4)
  assert.deepEqual(response.body.rows.filter(row => row.active).map(row => row.key).sort(), operatingKeys.slice().sort())
  assert.equal(response.body.rows.find(row => row.key === 'chaowai').active, false)
  assert.ok(response.body.rows.every(row => typeof row.active === 'boolean'))
  for (const role of ['public', 'cashier']) {
    const denied = await route(v2Router, 'GET', '/stores', { actor: user(role) })
    assert.equal(denied.statusCode, 403)
  }
  assert.equal(writes.length, 0)
})

test('completeness metadata suppresses closed-day operating reminders without rewriting historical/payroll facts', async () => {
  reset()
  fixture['dailyEntry.findUnique'] = async () => null
  const historical = await route(dailyEntryUpgradeRouter, 'GET', '/daily-entry/completeness', { query: { store: 'chaowai', date: CHAOWAI_BUSINESS_CLOSED_ON } })
  const closedDay = await route(dailyEntryUpgradeRouter, 'GET', '/daily-entry/completeness', { query: { store: 'chaowai', date: '2026-10-15' } })
  assert.equal(historical.statusCode, 200)
  assert.equal(historical.body.dailyEntryExpected, true)
  assert.equal(closedDay.body.dailyEntryExpected, false)
  assert.equal(closedDay.body.storeActive, false)
  assert.equal(closedDay.body.businessClosedOn, CHAOWAI_BUSINESS_CLOSED_ON)
  assert.deepEqual(historical.body.completeness, closedDay.body.completeness)
  assert.equal(closedDay.body.completeness.code, 'MISSING_DAILY_ENTRY')
  const operatingDay = await route(dailyEntryUpgradeRouter, 'GET', '/daily-entry/completeness', { query: { store: 'guanshe', date: '2026-10-15' } })
  assert.equal(operatingDay.body.dailyEntryExpected, true)
  assert.equal(operatingDay.body.businessClosedOn, null)
  assert.equal(writes.length, 0)
})

test('business closure date is historical metadata and cannot automatically deactivate a still-active store', async () => {
  reset(true)
  const response = await route(dailyEntryUpgradeRouter, 'GET', '/daily-entry/completeness', { query: { store: 'chaowai', date: '2026-10-15' } })
  assert.equal(response.body.dailyEntryExpected, true)
  assert.equal(response.body.storeActive, true)
  assert.equal(stores.get('chaowai').active, true)
  assert.equal(writes.length, 0)
})

test('correction context authenticates original role before Store lock or employee/history reads', async () => {
  reset()
  await assert.rejects(getDailyCorrectionContext(db, { actor: user('staff'), storeKey: 'chaowai', date: '2026-10-13' }), error => error.status === 403)
  assert.equal(rawQueries.length, 0)
  assert.equal(writes.length, 0)
})

test('administrator cannot obtain closed-store correction context or employee facts', async () => {
  reset()
  fixture['dailyEntry.findUnique'] = async () => { throw Error('closed context must deny before history read') }
  fixture['employee.findMany'] = async () => { throw Error('closed context must deny before employee read') }
  await assert.rejects(getDailyCorrectionContext(db, { actor: user('admin'), storeKey: 'chaowai', date: '2026-10-13' }), error => error.status === 403)
  assert.ok(rawQueries.some(query => query.sql.includes('"Store"') && query.sql.includes('FOR SHARE')))
  assert.equal(writes.length, 0)
})

for (const closedSide of ['source', 'target']) test(`administrator cannot correct ${closedSide} closed store even with backdated date`, async () => {
  reset()
  await assert.rejects(correctDailyPerformance(db, {
    actor: user('admin'), storeKey: closedSide === 'source' ? 'chaowai' : 'guanshe', targetStoreKey: closedSide === 'target' ? 'chaowai' : 'guanshe',
    date: '2026-10-13', reason: '合成历史更正', requestKey: 'synthetic-correction-20261015', token: '0'.repeat(64), incCents: 1, ord: 1,
    items: [{ employeeId: 'synthetic-employee', actualHours: 8 }],
  }), error => error.status === 403)
  assert.ok(rawQueries.some(query => query.sql.includes('"Store"') && query.sql.includes('FOR SHARE') && query.params.includes('chaowai')))
  assert.equal(writes.length, 0)
})

test('developer closed context and administrator active context preserve the original correction authority', async () => {
  for (const [role, storeKey] of [['developer', 'chaowai'], ['admin', 'guanshe']]) {
    reset()
    const response = await getDailyCorrectionContext(db, { actor: user(role), storeKey, date: '2026-10-13' })
    assert.equal(response.sales.incCents, '10000')
    assert.equal(response.token.length, 64)
    assert.equal(response.entry.id, 'historical-daily')
    assert.ok(rawQueries.some(query => query.sql.includes('FOR SHARE') && query.params.includes(storeKey)))
    assert.equal(writes.length, 0)
  }
})

for (const storeKey of ['guanshe', 'store-0123456789abcdef0123']) test(`registered ${storeKey} procurement draft creation retains the original flow`, async () => {
  reset()
  if (!stores.has(storeKey)) stores.set(storeKey, { key: storeKey, name: '合成新增门店', active: true })
  fixture['procurementOrder.findUnique'] = async input => input?.where?.createRequestKey ? null : known.procurementOrder
  const response = await route(purchaseReceiptRouter, 'POST', '/procurement/orders', { body: { requestKey: 'synthetic-new-operating-20261015', content: { storeKey, items: [] } } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.order.storeKey, storeKey)
  assert.equal(writes.filter(write => write.name === 'procurementOrder' && write.method === 'create').length, 1)
  assert.ok(rawQueries.some(query => query.sql.includes('FOR SHARE') && query.params.includes(storeKey)))
  assert.equal(writes.filter(write => write.name === 'store').length, 0)
})

for (const direction of ['from', 'to']) test(`新增登记门店可作为调拨 ${direction}；沿用商品/库存逻辑且不写 Store`, async () => {
  reset()
  const key = 'store-0123456789abcdef0123'
  stores.set(key, { key, name: '合成新增门店', active: true })
  fixture['inventoryItem.findUnique'] = async () => ({ id: 'synthetic-item', name: '合成货品', transferEnabled: true, category: 'product' })
  fixture['transferRequest.create'] = async input => {
    writes.push({ name: 'transferRequest', method: 'create', input })
    return { ...input.data, status: 'pending', createdAt: new Date(), items: input.data.items.create,
      fromStore: stores.get(input.data.fromStoreKey), toStore: stores.get(input.data.toStoreKey) }
  }
  const response = await route(v2Router, 'POST', '/transfer-requests', { body: {
    fromStoreKey: direction === 'from' ? key : 'guanshe', toStoreKey: direction === 'to' ? key : 'guanshe',
    items: [{ name: '合成货品', itemId: 'synthetic-item', quantity: 1, category: 'product' }],
  } })
  assert.equal(response.statusCode, 200)
  assert.equal(direction === 'from' ? response.body.request.fromStoreKey : response.body.request.storeKey, key)
  assert.equal(direction === 'from' ? response.body.request.fromStoreName : response.body.request.storeName, '合成新增门店')
  assert.equal(writes.filter(write => write.name === 'transferRequest' && write.method === 'create').length, 1)
  assert.equal(writes.filter(write => write.name === 'store').length, 0)
  assert.ok(rawQueries.some(query => query.sql.includes('FOR SHARE') && query.params.includes(key)))
})

test('normal operating-store legacy mailing preserves creation with canonical attribution', async () => {
  reset()
  const response = await route(v2Router, 'POST', '/mailing-records', { actor: user('staff', ['guanshe']), body: {
    method: '顺丰邮寄', postage: '包邮', address: '合成地址，非真实收件地址', recipient: '合成收件人', phone: '000000',
  } })
  assert.equal(response.statusCode, 200)
  const created = writes.find(write => write.name === 'mailingRecord' && write.method === 'create')
  assert.equal(created.input.data.storeKey, 'guanshe')
  assert.equal(created.input.data.status, 'pending')
})

test('normal operating-store mailing QR creation remains available with the original contract', async () => {
  reset()
  const response = await createCustomerServiceRequest({ prismaClient: db, user: user('manager', ['guanshe']), origin: 'https://synthetic.example.test', input: {
    type: 'MAILING', storeKey: 'guanshe', method: '顺丰邮寄', postage: '包邮', shippingTier: 'STANDARD',
  } })
  assert.equal(response.request.storeKey, 'guanshe')
  assert.equal(response.request.status, 'WAITING_CUSTOMER')
  assert.ok(response.publicUrl.startsWith('https://synthetic.example.test/'))
  assert.equal(writes.filter(write => write.name === 'customerServiceRequest' && write.method === 'create').length, 1)
})

test('normal operating-store schedule retains the existing atomic save flow', async () => {
  reset()
  fixture['schedule.findMany'] = async () => []
  const response = await replaceScheduleStoresAtomic(db, { weekStart: '2026-10-12', stores: [{ storeKey: 'guanshe', days: {}, version: EMPTY_SCHEDULE_VERSION }] })
  assert.deepEqual(response.rows, [])
  assert.equal(response.versions.guanshe, EMPTY_SCHEDULE_VERSION)
  assert.equal(writes.filter(write => write.name === 'schedule' && write.method === 'deleteMany').length, 1)
  assert.ok(rawQueries.some(query => query.sql.includes('FOR SHARE') && query.params.includes('guanshe')))
})

function pendingTransferFixture({ fromStoreKey = 'chaowai', toStoreKey = 'guanshe', creator = 'synthetic-manager' } = {}) {
  const row = {
    ...known.transferRequest, fromStoreKey, toStoreKey, purpose: 'LEGACY_UNCLASSIFIED', createdBy: creator,
    fromLocationName: fromStoreKey === null ? '合成历史临时调出地点' : '',
    toLocationName: toStoreKey === null ? '合成历史临时调入地点' : '',
    fromStore: fromStoreKey === null ? null : stores.get(fromStoreKey),
    toStore: toStoreKey === null ? null : stores.get(toStoreKey),
    items: [{ id: 'synthetic-transfer-item', itemId: 'synthetic-item', quantity: 3, quantityUnit: 'legacy', shippedQuantity: null, itemNameSnapshot: '合成货品', categorySnapshot: 'product', item: { id: 'synthetic-item', name: '合成货品', category: 'product' } }],
  }
  fixture['transferRequest.findUnique'] = fixture['transferRequest.findFirst'] = async () => structuredClone(row)
  fixture['transferRequest.updateMany'] = async input => {
    writes.push({ name: 'transferRequest', method: 'updateMany', input })
    Object.assign(row, input.data)
    return { count: 1 }
  }
  fixture['transferItem.updateMany'] = async input => {
    writes.push({ name: 'transferItem', method: 'updateMany', input })
    Object.assign(row.items.find(item => item.id === input.where.id), input.data)
    return { count: 1 }
  }
  return row
}

for (const role of ['manager', 'admin']) test(`closed-store transfer withdrawal denies ${role} after original creator or global permission`, async () => {
  reset()
  fixture['user.findUnique'] = async () => user(role)
  pendingTransferFixture({ creator: user(role).username })
  const response = await route(v2Router, 'DELETE', '/transfer-requests/:id', { actor: user(role), params: { id: 'historical-transfer' }, body: { fromStoreKey: 'tongying', toStoreKey: 'xidan' } })
  assert.equal(response.statusCode, 403)
  assert.equal(writes.length, 0)
  assert.ok(rawQueries.some(query => query.sql.includes('FOR SHARE') && query.params.includes('chaowai')))
})

test('transfer withdrawal rejects an unrelated creator before any closed-store lookup', async () => {
  reset()
  pendingTransferFixture({ creator: 'another-synthetic-creator' })
  const response = await route(v2Router, 'DELETE', '/transfer-requests/:id', { actor: user('staff'), params: { id: 'historical-transfer' } })
  assert.equal(response.statusCode, 403)
  assert.equal(rawQueries.length, 0)
  assert.equal(writes.length, 0)
})

test('developer closed-store withdrawal retains the original tracked cancellation result', async () => {
  reset()
  pendingTransferFixture({ creator: user().username })
  const response = await route(v2Router, 'DELETE', '/transfer-requests/:id', { params: { id: 'historical-transfer' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.request.status, 'canceled')
  assert.equal(response.body.request.withdrawnBy, user().username)
  assert.ok(response.body.request.withdrawnAt instanceof Date)
  assert.equal(response.body.request.fromStoreKey, 'chaowai')
})

test('operating-store original creator keeps the existing withdrawal permission and store identity', async () => {
  reset()
  pendingTransferFixture({ fromStoreKey: 'guanshe', toStoreKey: 'xidan', creator: user('manager').username })
  const response = await route(v2Router, 'DELETE', '/transfer-requests/:id', { actor: user('manager'), params: { id: 'historical-transfer' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.request.status, 'canceled')
  assert.equal(response.body.request.fromStoreKey, 'guanshe')
  assert.equal(response.body.request.storeKey, 'xidan')
})

for (const [fromStoreKey, toStoreKey] of [[null, 'guanshe'], ['guanshe', null], [null, null]]) test(`existing temporary transfer ${fromStoreKey} to ${toStoreKey} retains legitimate super-user shipment`, async () => {
  reset()
  const stored = pendingTransferFixture({ fromStoreKey, toStoreKey })
  const response = await route(v2Router, 'POST', '/transfer-requests/:id/ship', { actor: user('admin'), params: { id: stored.id }, body: { items: [{ itemId: 'synthetic-item', shippedQuantity: 2 }] } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.request.status, 'shipped')
  assert.equal(response.body.request.items[0].shippedQuantity, 2)
  assert.equal(response.body.request.fromStoreKey, fromStoreKey)
  assert.equal(response.body.request.storeKey, toStoreKey)
  if (fromStoreKey === null) assert.equal(response.body.request.fromStoreName, stored.fromLocationName)
  if (toStoreKey === null) assert.equal(response.body.request.storeName, stored.toLocationName)
  assert.ok(rawQueries.every(query => !query.params.includes(null) && !query.params.includes(undefined)))
})

for (const [fromStoreKey, toStoreKey] of [[null, 'chaowai'], ['chaowai', null]]) test(`temporary counterpart does not bypass non-null closed Store in shipment ${fromStoreKey} to ${toStoreKey}`, async () => {
  reset()
  const stored = pendingTransferFixture({ fromStoreKey, toStoreKey })
  const response = await route(v2Router, 'POST', '/transfer-requests/:id/ship', { actor: user('admin'), params: { id: stored.id }, body: { items: [{ itemId: 'synthetic-item', shippedQuantity: 2 }] } })
  expectClosed(response)
})

test('preserving legacy temporary shipments does not reopen new temporary transfer creation', async () => {
  reset()
  const response = await route(v2Router, 'POST', '/transfer-requests', { body: { fromStoreKey: null, toStoreKey: 'guanshe', fromLocationName: '合成临时地点', items: [{ name: '合成货品', quantity: 1 }] } })
  assert.equal(response.statusCode, 400)
  assert.equal(writes.length, 0)
})

test('all synthetic validation attempts remain offline', () => { assert.deepEqual(externalAttempts, []) })


const r1MaintenanceCases = [
  ['DELETE','/daily-entries',{storeKey:'chaowai',date:'2026-10-13'}],
  ['DELETE','/transfer-requests/:id',{}],
  ['POST','/transfer-requests/:id/reject',{}],
  ['DELETE','/expenses/:id',{}],
  ['POST','/invoices/:id/status',{status:'done'}],
  ['POST','/mailing-records/:id/ship',{}],
  ['POST','/invoices',{storeKey:'chaowai',titleType:'personal',amountCents:100}],
]
for(const [method,path,body] of r1MaintenanceCases) test(`R1-02 持久角色降权/停用/缺失拒绝过时developer：${method} ${path}`,async()=>{
  for(const current of [user('staff'),{...user(),status:'disabled'},null]){
    reset();fixture['user.findUnique']=async()=>current
    fixture['dailyEntry.findUnique']=async()=>({...known.dailyEntry,status:'draft'})
    const response=await route(v2Router,method,path,{actor:user(),body,params:{id:'synthetic-history'}})
    assert.equal(response.statusCode,403,`${path} ${current?.role}/${current?.status}`)
    assert.equal(writes.length,0,'no directory or aftercare write before authorization')
    assert(rawQueries[0].sql.includes('"User"'));assert(rawQueries[0].sql.endsWith('FOR SHARE'))
    assert.equal(rawQueries[0].params[0],user().id)
    const storeLocks=rawQueries.slice(1).filter(q=>q.sql.includes('"Store"')).map(q=>q.params[0]);assert(storeLocks.includes('chaowai'))
    assert.deepEqual(storeLocks,[...storeLocks].sort())
  }
})
test('R1-02 当前有效developer可善后；营业门店admin沿用原授权',async()=>{
  for(const active of [false,true]){
    reset(active);fixture['user.findUnique']=async()=>user(active?'admin':'developer')
    const response=await route(v2Router,'POST','/invoices/:id/status',{actor:user(active?'admin':'developer'),body:{status:'done'},params:{id:known.invoice.id}})
    assert.equal(response.statusCode,200);assert.equal(response.body.invoice.status,'done')
    assert.equal(rawQueries[0].params[0],user(active?'admin':'developer').id)
    assert(rawQueries[0].sql.includes('"User"'));assert(rawQueries[1].sql.includes('"Store"'))
  }
})

test('新开票拒绝尚未登记的门店，不能自动初始化身份',async()=>{
  reset();stores.delete('guanshe')
  const response=await route(v2Router,'POST','/invoices',{body:{storeKey:'guanshe',titleType:'personal',amountCents:100}})
  assert.equal(response.statusCode,404);assert.equal(stores.has('guanshe'),false)
  assert.equal(writes.length,0)
})

test('实际新建样式的已登记门店可开票且不改名称、启停或其他门店资料',async()=>{
  reset()
  const key='store-0123456789abcdef0123'
  stores.set(key,{key,name:'合成第五家门店',district:'合成位置',active:true})
  const before=structuredClone([...stores.values()])
  const response=await route(v2Router,'POST','/invoices',{body:{storeKey:key,titleType:'personal',amountCents:100}})
  assert.equal(response.statusCode,200);assert.equal(response.body.invoice.storeKey,key)
  assert.deepEqual([...stores.values()],before)
  assert.equal(writes.filter(w=>w.name==='store').length,0)
})
