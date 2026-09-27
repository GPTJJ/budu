import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc3-'))
process.env.DATA_DIR = dataDir
process.env.PAYMENT_MODE = 'mock'
process.env.DATABASE_URL = await createDisposablePgSchema('report_center_rc3')

const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const { hashPassword } = await import('../server/auth.js')
const { paymentService } = await import('../server/payments/index.js')
const { normalizeAccountPermissions } = await import('../shared/accountPermissions.js')
const { ReportQueryService } = await import('../server/report-center-query.js')

const server = createApp().listen(0)
const json = async (response) => ({ status: response.status, body: await response.json() })
const request = (origin, pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${origin}${pathname}`, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) => {
  if (typeof item === 'bigint') return item.toString()
  if (item instanceof Date) return item.toISOString()
  return item
})).digest('hex')

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = await request(origin, '/api/auth/register', { method: 'POST', body: { username: 'rc3-developer', password: '123456' } })
  assert.equal(register.status, 200)
  const developerCookie = register.headers.get('set-cookie')?.split(';')[0] || ''

  await prisma.store.createMany({ data: [
    { key: 'manual-store', name: '人工汇总门店', salesDataSource: 'manual' },
    { key: 'pos-store', name: 'BUDU POS 门店', salesDataSource: 'pos', salesDataSourceEffectiveDate: new Date('2026-08-31T00:00:00.000Z') },
    { key: 'draft-store', name: '尚未确认门店', salesDataSource: 'manual' },
  ] })
  await prisma.inventoryItem.createMany({ data: [
    { id: 'rc3-product-a', name: '报表商品 A', category: 'product', sku: 'RC3-A', unit: '件', salePriceCents: 10_000n, costPriceCents: 3_000n, isActive: true },
    { id: 'rc3-product-b', name: '报表商品 B', category: 'product', sku: 'RC3-B', unit: '件', salePriceCents: 5_000n, costPriceCents: 1_000n, isActive: true },
  ] })
  await prisma.dailyEntry.createMany({ data: [
    {
      id: 'rc3-manual-entry', storeKey: 'manual-store', date: new Date('2026-08-31T00:00:00.000Z'),
      incCents: 9_000n, ord: 3, status: 'confirmed', salesDataStatus: 'synced',
      confirmedAt: new Date('2026-08-31T15:00:00.000Z'), confirmedBy: 'manager',
    },
    {
      id: 'rc3-pos-entry', storeKey: 'pos-store', date: new Date('2026-08-31T00:00:00.000Z'),
      incCents: 999_999n, ord: 99, status: 'confirmed', salesDataStatus: 'synced',
      posSyncAt: new Date('2026-08-31T15:00:00.000Z'), confirmedAt: new Date('2026-08-31T15:00:00.000Z'), confirmedBy: 'manager',
    },
    {
      id: 'rc3-draft-entry', storeKey: 'draft-store', date: new Date('2026-08-31T00:00:00.000Z'),
      incCents: 888_888n, ord: 88, status: 'draft', salesDataStatus: 'not_applicable',
    },
    {
      id: 'rc5-manual-previous', storeKey: 'manual-store', date: new Date('2026-08-30T00:00:00.000Z'),
      incCents: 8_000n, ord: 4, status: 'confirmed', salesDataStatus: 'synced',
      confirmedAt: new Date('2026-08-30T15:00:00.000Z'), confirmedBy: 'manager',
    },
    {
      id: 'rc5-draft-previous', storeKey: 'draft-store', date: new Date('2026-08-30T00:00:00.000Z'),
      incCents: 7_000n, ord: 2, status: 'confirmed', salesDataStatus: 'synced',
      confirmedAt: new Date('2026-08-30T15:00:00.000Z'), confirmedBy: 'manager',
    },
    {
      id: 'rc5-manual-year', storeKey: 'manual-store', date: new Date('2025-08-31T00:00:00.000Z'),
      incCents: 6_000n, ord: 3, status: 'confirmed', salesDataStatus: 'synced',
      confirmedAt: new Date('2025-08-31T15:00:00.000Z'), confirmedBy: 'manager',
    },
  ] })

  const createUser = (id, username, storeKeys, permissions) => prisma.user.create({ data: {
    id, username, passwordHash: hashPassword('123456'), role: 'staff', storeKeys, status: 'active',
    permissions: normalizeAccountPermissions(permissions, 'staff'),
  } })
  await createUser('rc3-no-report', 'rc3-no-report', ['manual-store'], {})
  await createUser('rc3-store-report', 'rc3-store-report', ['manual-store'], { reportSalesView: true })
  await createUser('rc3-all-report', 'rc3-all-report', ['manual-store'], { reportSalesView: true, reportAllStores: true })
  const login = async (username) => {
    const response = await request(origin, '/api/auth/login', { method: 'POST', body: { username, password: '123456' } })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')?.split(';')[0] || ''
  }
  const noReportCookie = await login('rc3-no-report')
  const storeReportCookie = await login('rc3-store-report')
  const allReportCookie = await login('rc3-all-report')

  const createExternal = async (storeId, source, requestKey, items, discountPercent = 100) => {
    const response = await json(await request(origin, '/api/v2/pos/external-orders', {
      cookie: developerCookie, method: 'POST', body: { storeId, orderSource: source, requestKey, items, discountPercent, confirm: true },
    }))
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return response.body.order
  }
  const manualRefund = async (order, requestKey, items, refundAmount) => {
    const response = await json(await request(origin, `/api/v2/pos/orders/${order.id}/manual-external-refunds`, {
      cookie: developerCookie, method: 'POST', body: {
        requestKey, items, refundAmount: String(refundAmount),
        externalCompletedAt: '2026-08-31T12:00:00.000Z', reason: '平台已完成退款',
      },
    }))
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return response.body
  }

  const meituan = await createExternal('pos-store', 'MEITUAN', 'rc3-meituan-order', [
    { productId: 'rc3-product-a', quantity: 2 },
    { productId: 'rc3-product-b', quantity: 1, gift: true },
  ], 80)
  const meituanA = meituan.items.find((item) => item.productId === 'rc3-product-a')
  await manualRefund(meituan, 'rc3-meituan-refund', [{ orderItemId: meituanA.id, quantity: 1 }], 8_000)

  const other = await createExternal('pos-store', 'OTHER', 'rc3-other-order', [
    { productId: 'rc3-product-b', quantity: 2 },
  ])
  await manualRefund(other, 'rc3-other-refund', [{ orderItemId: other.items[0].id, quantity: 2 }], 10_000)

  const cashOrderResponse = await json(await request(origin, '/api/v2/pos/orders', {
    cookie: developerCookie, method: 'POST', body: {
      storeId: 'pos-store', checkoutKey: 'rc3-cash-order', items: [{ productId: 'rc3-product-a', quantity: 1 }], discountPercent: 100,
    },
  }))
  assert.equal(cashOrderResponse.status, 201)
  const cashPayment = await json(await request(origin, `/api/v2/pos/orders/${cashOrderResponse.body.order.id}/payments`, {
    cookie: developerCookie, method: 'POST', body: { channel: 'cash', requestKey: 'rc3-cash-payment' },
  }))
  assert.equal(cashPayment.status, 201)

  // A real Order can coexist physically on a manual-authority day, but it must
  // not be counted or make item/order coverage appear available.
  await createExternal('manual-store', 'MEITUAN', 'rc3-manual-stray-order', [{ productId: 'rc3-product-a', quantity: 7 }])

  const canonicalBefore = digest({
    entries: await prisma.dailyEntry.findMany({ orderBy: { id: 'asc' } }),
    orders: await prisma.order.findMany({ orderBy: { id: 'asc' } }),
    items: await prisma.orderItem.findMany({ orderBy: { id: 'asc' } }),
    payments: await prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    refunds: await prisma.refund.findMany({ orderBy: { id: 'asc' } }),
    refundItems: await prisma.refundItem.findMany({ orderBy: { id: 'asc' } }),
  })

  let providerInvocationCount = 0
  const originalResolveProvider = paymentService.resolveProvider
  paymentService.resolveProvider = function (...args) {
    providerInvocationCount += 1
    return originalResolveProvider.apply(this, args)
  }

  const pathFor = (endpoint, stores = '') => `/api/v2/report-center/${endpoint}?from=2026-08-31&to=2026-08-31${stores ? `&store=${stores}` : ''}`
  assert.equal((await request(origin, pathFor('summary', 'manual-store'), { cookie: noReportCookie })).status, 403)
  assert.equal((await request(origin, pathFor('summary', 'pos-store'), { cookie: storeReportCookie })).status, 403)
  assert.equal((await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31', { cookie: noReportCookie })).status, 403)
  assert.equal((await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31&store=pos-store', { cookie: storeReportCookie })).status, 403)

  const manualSummary = await json(await request(origin, pathFor('summary', 'manual-store'), { cookie: storeReportCookie }))
  assert.equal(manualSummary.status, 200, JSON.stringify(manualSummary.body))
  assert.equal(manualSummary.body.metrics.revenue.valueCents, '9000')
  assert.equal(manualSummary.body.metrics.orderCount.value, 3)
  assert.equal(manualSummary.body.metrics.aov.valueCents, '3000')
  assert.equal(manualSummary.body.metrics.grossSales.valueCents, null)
  assert.equal(manualSummary.body.coverage.dailySummary.state, 'COMPLETE')
  assert.equal(manualSummary.body.coverage.orders.state, 'UNAVAILABLE')

  const manualOrders = await json(await request(origin, pathFor('orders', 'manual-store'), { cookie: storeReportCookie }))
  assert.equal(manualOrders.status, 200)
  assert.equal(manualOrders.body.total, 0)
  assert.equal(manualOrders.body.coverage.state, 'UNAVAILABLE')

  const posSummary = await json(await request(origin, pathFor('summary', 'pos-store'), { cookie: allReportCookie }))
  assert.equal(posSummary.status, 200, JSON.stringify(posSummary.body))
  assert.equal(posSummary.body.metrics.revenue.valueCents, '18000')
  assert.equal(posSummary.body.metrics.orderCount.value, 2)
  assert.equal(posSummary.body.metrics.aov.valueCents, '9000')
  assert.equal(posSummary.body.metrics.grossSales.valueCents, '40000')
  assert.equal(posSummary.body.metrics.discount.valueCents, '4000')
  assert.equal(posSummary.body.metrics.refund.valueCents, '18000')
  assert.equal(posSummary.body.coverage.orders.state, 'COMPLETE')
  assert.equal(posSummary.body.daily[0].revenueCents, '18000')
  assert.notEqual(posSummary.body.daily[0].revenueCents, '999999')
  assert.deepEqual(posSummary.body.channelComposition.rows.map((row) => row.key).sort(), ['MEITUAN', 'OTHER', 'STORE_POS'])
  assert.deepEqual(posSummary.body.settlementComposition.rows.map((row) => row.key).sort(), ['CASH', 'CUSTOM', 'PLATFORM'])

  const combined = await json(await request(origin, pathFor('summary', 'manual-store,pos-store'), { cookie: allReportCookie }))
  assert.equal(combined.status, 200)
  assert.equal(combined.body.metrics.revenue.valueCents, '27000')
  assert.equal(combined.body.metrics.orderCount.value, 5)
  assert.equal(combined.body.metrics.aov.valueCents, '5400')
  assert.equal(combined.body.metrics.revenue.coverage.state, 'COMPLETE')
  assert.equal(combined.body.metrics.grossSales.coverage.state, 'PARTIAL')
  assert.equal(combined.body.metrics.grossSales.valueCents, '40000')
  assert.deepEqual(combined.body.storeComparison.map((row) => row.storeKey), ['pos-store', 'manual-store'])
  assert.equal(combined.body.storeComparison.find((row) => row.storeKey === 'manual-store').aovCents, '3000')

  const allSummary = await json(await request(origin, pathFor('summary'), { cookie: allReportCookie }))
  assert.equal(allSummary.status, 200)
  assert.equal(allSummary.body.metrics.revenue.coverage.state, 'PARTIAL')
  assert.equal(allSummary.body.metrics.revenue.valueCents, '27000')
  assert.deepEqual(allSummary.body.metrics.revenue.coverage.uncoveredStores, ['draft-store'])

  const dashboard = await json(await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31&compare=previous&period=today', { cookie: allReportCookie }))
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body))
  assert.equal(dashboard.body.metrics.revenue.valueCents, '27000')
  assert.equal(dashboard.body.freshness.state, 'TODAY_PARTIAL')
  assert.deepEqual(dashboard.body.freshness.pendingCloseStores, ['draft-store'])
  assert.equal(dashboard.body.comparisons.revenue.coverage.state, 'PARTIAL')
  assert.deepEqual(dashboard.body.comparisons.revenue.coverage.comparableStores, ['manual-store'])
  assert.equal(dashboard.body.comparisons.revenue.currentValue, '9000')
  assert.equal(dashboard.body.comparisons.revenue.comparisonValue, '8000')
  assert.equal(dashboard.body.comparisons.revenue.changeBps, '1250')
  assert.equal(dashboard.body.comparisons.aov.changeBps, '5000')
  assert.equal(dashboard.body.comparisons.grossSales.coverage.state, 'NO_PRIOR_DATA')
  assert.equal(dashboard.body.trend.granularity, 'DAY')
  assert.equal(dashboard.body.trend.points.length, 1, 'mixed-source today must not manufacture hourly points')
  assert.equal(dashboard.body.trend.points[0].coverage.state, 'PARTIAL')
  assert.equal(dashboard.body.topProducts.coverage.state, 'PARTIAL')
  assert.equal(dashboard.body.topProducts.rows[0].productId, 'rc3-product-a')
  assert.equal(dashboard.body.profit.available, false)

  const dashboardComplete = await json(await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31&store=manual-store&compare=previous&period=today', { cookie: allReportCookie }))
  assert.equal(dashboardComplete.body.comparisons.revenue.coverage.state, 'COMPLETE')
  assert.equal(dashboardComplete.body.comparisons.orderCount.changeBps, '-2500')
  assert.equal(dashboardComplete.body.comparisons.aov.currentValue, '3000')
  assert.equal(dashboardComplete.body.comparisons.aov.comparisonValue, '2000')

  const dashboardYear = await json(await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31&store=manual-store&compare=year&period=today', { cookie: allReportCookie }))
  assert.equal(dashboardYear.body.comparison.range.from, '2025-08-31')
  assert.equal(dashboardYear.body.comparisons.revenue.coverage.state, 'COMPLETE')
  assert.equal(dashboardYear.body.comparisons.revenue.changeBps, '5000')

  const incomparable = await json(await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31&store=pos-store&compare=previous&period=today', { cookie: allReportCookie }))
  assert.equal(incomparable.body.comparisons.revenue.coverage.state, 'NO_PRIOR_DATA')
  assert.equal(incomparable.body.comparisons.revenue.changeBps, null)

  const disjointCoverage = await json(await request(origin, '/api/v2/report-center/dashboard?from=2026-08-31&to=2026-08-31&store=pos-store,draft-store&compare=previous&period=today', { cookie: allReportCookie }))
  assert.equal(disjointCoverage.body.comparisons.revenue.coverage.state, 'INCOMPARABLE')
  assert.deepEqual(disjointCoverage.body.comparisons.revenue.coverage.currentCoveredStores, ['pos-store'])
  assert.deepEqual(disjointCoverage.body.comparisons.revenue.coverage.comparisonCoveredStores, ['draft-store'])
  assert.equal(disjointCoverage.body.comparisons.revenue.changeBps, null)

  const historicalGap = await json(await request(origin, '/api/v2/report-center/dashboard?from=2026-08-29&to=2026-08-29&store=manual-store&compare=previous&period=custom', { cookie: allReportCookie }))
  assert.equal(historicalGap.body.freshness.state, 'HISTORICAL_INCOMPLETE')
  assert.deepEqual(historicalGap.body.freshness.historicalIncompleteStores, ['manual-store'])
  assert.equal(historicalGap.body.metrics.revenue.valueCents, null)

  const orders = await json(await request(origin, `${pathFor('orders', 'pos-store')}&page=1&pageSize=2`, { cookie: allReportCookie }))
  assert.equal(orders.status, 200, JSON.stringify(orders.body))
  assert.equal(orders.body.total, 3)
  assert.equal(orders.body.rows.length, 2)
  assert.ok(orders.body.rows.every((row) => row.createdAt && row.settlementCents && row.settlementType))
  const allOrders = await json(await request(origin, `${pathFor('orders', 'pos-store')}&page=1&pageSize=10`, { cookie: allReportCookie }))
  assert.equal(allOrders.body.rows.find((row) => row.orderSource === 'OTHER').grossCents, '10000')
  assert.equal(allOrders.body.rows.find((row) => row.orderSource === 'OTHER').refundCents, '10000')
  assert.equal(allOrders.body.rows.find((row) => row.orderSource === 'OTHER').revenueCents, '0')
  const filteredOrders = await json(await request(origin, `${pathFor('orders', 'pos-store')}&orderSource=MEITUAN&settlementType=PLATFORM`, { cookie: allReportCookie }))
  assert.equal(filteredOrders.status, 200)
  assert.equal(filteredOrders.body.total, 1)
  assert.equal(filteredOrders.body.rows[0].orderSource, 'MEITUAN')
  const orderDetail = await json(await request(origin, `/api/v2/report-center/orders/${meituan.id}`, { cookie: allReportCookie }))
  assert.equal(orderDetail.status, 200)
  assert.equal(orderDetail.body.refundCents, '8000')
  assert.equal(orderDetail.body.items.find((item) => item.isGift).actualCents, '0')
  assert.equal(orderDetail.body.settlementType, 'PLATFORM')
  assert.equal(orderDetail.body.settlementCents, '16000')
  assert.equal(orderDetail.body.refunds[0].items[0].productName, '报表商品 A')
  const stray = await prisma.order.findFirst({ where: { storeId: 'manual-store' }, select: { id: true } })
  assert.equal((await request(origin, `/api/v2/report-center/orders/${stray.id}`, { cookie: allReportCookie })).status, 409)

  const products = await json(await request(origin, `${pathFor('products', 'pos-store')}&pageSize=10`, { cookie: allReportCookie }))
  assert.equal(products.status, 200, JSON.stringify(products.body))
  assert.equal(products.body.coverage.state, 'COMPLETE')
  const productA = products.body.rows.find((row) => row.productId === 'rc3-product-a')
  const productB = products.body.rows.find((row) => row.productId === 'rc3-product-b')
  assert.equal(productA.productName, '报表商品 A')
  assert.equal(productA.salesQuantity, '3')
  assert.equal(productA.salesCents, '30000')
  assert.equal(productA.discountCents, '4000')
  assert.equal(productA.refundQuantity, '1')
  assert.equal(productA.refundCents, '8000')
  assert.equal(productA.productRevenueCents, '18000')
  assert.equal(productA.orderRateBps, '10000')
  assert.equal(productA.salesQuantityShareBps, '5000')
  assert.equal(productA.salesShareBps, '7500')
  assert.equal(productA.giftShareBps, '0')
  assert.equal(productB.salesQuantity, '3')
  assert.equal(productB.giftQuantity, '1')
  assert.equal(productB.giftCents, '5000')
  assert.equal(productB.salesCents, '10000')
  assert.equal(productB.refundQuantity, '2')
  assert.equal(productB.refundCents, '10000')
  assert.equal(productB.productRevenueCents, '0')
  assert.equal(productB.orderRateBps, '5000')
  assert.deepEqual(products.body.totals, {
    salesQuantity: '6', salesCents: '40000', discountCents: '4000', productRevenueCents: '18000',
    refundQuantity: '3', refundCents: '18000', giftQuantity: '1', giftCents: '5000',
  })
  assert.equal(products.body.rows[0].productId, 'rc3-product-a', '默认按产品收入排序')
  const searchedProducts = await json(await request(origin, `${pathFor('products', 'pos-store')}&search=RC3-A&sort=salesQuantity`, { cookie: allReportCookie }))
  assert.equal(searchedProducts.status, 200)
  assert.equal(searchedProducts.body.total, 1)
  assert.equal(searchedProducts.body.rows[0].productId, 'rc3-product-a')
  assert.equal(searchedProducts.body.rows[0].giftShareBps, null, '占比分母为 0 时必须返回 unavailable 而不是 0%')

  const manualProducts = await json(await request(origin, pathFor('products', 'manual-store'), { cookie: storeReportCookie }))
  assert.equal(manualProducts.body.coverage.state, 'UNAVAILABLE')
  assert.equal(manualProducts.body.total, 0)

  // The three core report queries must stay bounded by a fixed number of
  // server-side queries. This guards against per-store, per-order and
  // per-product N+1 regressions while the realistic fixture grows.
  const queryCounts = { model: 0, raw: 0 }
  const tracedModel = (model, methods) => Object.fromEntries(methods.map((method) => [method, (...args) => {
    queryCounts.model += 1
    return prisma[model][method](...args)
  }]))
  const tracedPrisma = {
    store: tracedModel('store', ['findMany']),
    dailyEntry: tracedModel('dailyEntry', ['findMany']),
    dailyEntryAuditLog: tracedModel('dailyEntryAuditLog', ['findMany']),
    order: tracedModel('order', ['findUnique']),
    $queryRaw: (...args) => {
      queryCounts.raw += 1
      return prisma.$queryRaw(...args)
    },
  }
  const measuredReports = new ReportQueryService(tracedPrisma)
  const reportUser = await prisma.user.findUnique({ where: { id: 'rc3-all-report' } })
  queryCounts.model = 0
  queryCounts.raw = 0
  await measuredReports.summary(reportUser, { from: '2026-08-31', to: '2026-08-31' })
  assert.deepEqual(queryCounts, { model: 3, raw: 3 }, 'summary query count must remain constant')
  queryCounts.model = 0
  queryCounts.raw = 0
  await measuredReports.orders(reportUser, { from: '2026-08-31', to: '2026-08-31', page: 1, pageSize: 1 })
  assert.deepEqual(queryCounts, { model: 3, raw: 1 }, 'orders pagination must remain constant-query')
  queryCounts.model = 0
  queryCounts.raw = 0
  await measuredReports.products(reportUser, { from: '2026-08-31', to: '2026-08-31', page: 1, pageSize: 1 })
  assert.deepEqual(queryCounts, { model: 3, raw: 1 }, 'product aggregation must remain constant-query')
  queryCounts.model = 0
  queryCounts.raw = 0
  await measuredReports.dashboard(reportUser, { from: '2026-08-31', to: '2026-08-31', compare: 'previous', period: 'today' })
  assert.deepEqual(queryCounts, { model: 6, raw: 4 }, 'dashboard must remain one bounded projection without N+1')

  const indexRows = await prisma.$queryRawUnsafe(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname IN (
        'orders_store_id_business_date_idx',
        'orders_order_source_business_date_status_idx',
        'order_items_order_id_idx',
        'order_items_product_id_idx',
        'refunds_order_id_created_at_idx',
        'refund_items_order_item_id_idx'
      )
  `)
  assert.deepEqual(indexRows.map((row) => row.indexname).sort(), [
    'order_items_order_id_idx',
    'order_items_product_id_idx',
    'orders_order_source_business_date_status_idx',
    'orders_store_id_business_date_idx',
    'refund_items_order_item_id_idx',
    'refunds_order_id_created_at_idx',
  ])
  assert.equal(providerInvocationCount, 0)
  paymentService.resolveProvider = originalResolveProvider

  const canonicalAfter = digest({
    entries: await prisma.dailyEntry.findMany({ orderBy: { id: 'asc' } }),
    orders: await prisma.order.findMany({ orderBy: { id: 'asc' } }),
    items: await prisma.orderItem.findMany({ orderBy: { id: 'asc' } }),
    payments: await prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    refunds: await prisma.refund.findMany({ orderBy: { id: 'asc' } }),
    refundItems: await prisma.refundItem.findMany({ orderBy: { id: 'asc' } }),
  })
  assert.equal(canonicalAfter, canonicalBefore)

  console.log(JSON.stringify({
    ok: true,
    manualRevenueSemantics: 'CONFIRMED_DAILY_ENTRY_INC_CENTS_IS_NET_REVENUE',
    combinedRevenueCents: combined.body.metrics.revenue.valueCents,
    orderCoverage: combined.body.coverage.orders.state,
    productCoverage: combined.body.coverage.productSales.state,
    providerInvocationCount,
    queryCountsVerified: true,
    dashboardComparisonCoverage: dashboard.body.comparisons.revenue.coverage.state,
    historicalDigest: canonicalAfter,
  }))
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
