import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc2b-'))
process.env.DATA_DIR = dataDir
process.env.PAYMENT_MODE = 'mock'
process.env.DATABASE_URL = await createDisposablePgSchema('report_center_rc2b')

const { createApp } = await import('../server/app.js')
const { prisma } = await import('../server/pg.js')
const { hashPassword } = await import('../server/auth.js')
const { paymentService } = await import('../server/payments/index.js')
const { normalizeAccountPermissions } = await import('../shared/accountPermissions.js')

const server = createApp().listen(0)
const json = async (response) => ({ status: response.status, body: await response.json() })
const request = (origin, pathname, { cookie = '', method = 'GET', body } = {}) => fetch(`${origin}${pathname}`, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
const rejectedByDb = (error) => ['P2002', 'P2003', 'P2004'].includes(error?.code)
  || /23503|23505|23514|authority|mismatch|unique|constraint/i.test(String(error?.message || ''))

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = await request(origin, '/api/auth/register', { method: 'POST', body: { username: 'rc2b-developer', password: '123456' } })
  assert.equal(register.status, 200)
  const developerCookie = register.headers.get('set-cookie')?.split(';')[0] || ''

  await prisma.store.createMany({ data: [{ key: 'store-a', name: '测试门店 A' }, { key: 'store-b', name: '测试门店 B' }] })
  await prisma.inventoryItem.create({
    data: {
      id: 'product-rc2b', name: '统一退款商品', category: 'product', sku: 'RC2B-SKU', unit: '件',
      salePriceCents: 10_000n, costPriceCents: 4_321n, isActive: true,
    },
  })
  const createUser = (id, username, storeKeys, permissions) => prisma.user.create({
    data: {
      id, username, passwordHash: hashPassword('123456'), role: 'staff', storeKeys, status: 'active',
      permissions: normalizeAccountPermissions(permissions, 'staff'),
    },
  })
  await createUser('staff-none', 'staff-none', ['store-a'], {})
  await createUser('staff-record-only', 'staff-record-only', ['store-a'], { manualExternalRefundRecord: true })
  await createUser('staff-other-store', 'staff-other-store', ['store-b'], {
    manualExternalRefundRecord: true, manualExternalRefundConfirm: true,
  })
  const login = async (username) => {
    const response = await request(origin, '/api/auth/login', { method: 'POST', body: { username, password: '123456' } })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')?.split(';')[0] || ''
  }
  const noCapCookie = await login('staff-none')
  const oneCapCookie = await login('staff-record-only')
  const otherStoreCookie = await login('staff-other-store')

  const createExternal = async (source, key, quantity = 1, businessDate = '2026-08-20') => {
    const result = await json(await request(origin, '/api/v2/pos/external-orders', {
      cookie: developerCookie,
      method: 'POST',
      body: {
        storeId: 'store-a', orderSource: source, requestKey: key,
        items: [{ productId: 'product-rc2b', quantity }], discountPercent: 100,
        businessDate, confirm: true,
      },
    }))
    assert.equal(result.status, 201, JSON.stringify(result.body))
    return result.body
  }
  const refundBody = (key, itemId, quantity, amount, overrides = {}) => ({
    requestKey: key,
    items: [{ orderItemId: itemId, quantity }],
    refundAmount: String(amount),
    reason: '平台已完成退款',
    externalCompletedAt: '2026-08-25T03:04:05.000Z',
    ...overrides,
  })
  const manualRefund = async (orderId, body, cookie = developerCookie) => json(await request(origin, `/api/v2/pos/orders/${orderId}/manual-external-refunds`, {
    cookie, method: 'POST', body,
  }))

  // Existing PAYMENT authority remains operational on migration 59.
  const posOrder = await json(await request(origin, '/api/v2/pos/orders', {
    cookie: developerCookie, method: 'POST',
    body: { storeId: 'store-a', checkoutKey: 'rc2b-payment-order', items: [{ productId: 'product-rc2b', quantity: 2 }], discountPercent: 100 },
  }))
  assert.equal(posOrder.status, 201)
  const cashPayment = await json(await request(origin, `/api/v2/pos/orders/${posOrder.body.order.id}/payments`, {
    cookie: developerCookie, method: 'POST', body: { channel: 'cash', requestKey: 'rc2b-cash-payment' },
  }))
  assert.equal(cashPayment.status, 201)
  const cashRefund = await json(await request(origin, `/api/v2/pos/orders/${posOrder.body.order.id}/refunds`, {
    cookie: developerCookie, method: 'POST',
    body: { requestKey: 'rc2b-cash-refund', items: [{ orderItemId: posOrder.body.order.items[0].id, quantity: 1 }] },
  }))
  assert.equal(cashRefund.status, 201)
  assert.equal(cashRefund.body.refund.refundMode, 'PAYMENT')
  assert.equal(cashRefund.body.refund.externalSettlementId, null)
  assert.equal(cashRefund.body.order.status, 'partially_refunded')

  let providerInvocationCount = 0
  const restores = []
  const wrapMethod = (target, name) => {
    if (typeof target?.[name] !== 'function') return
    const original = target[name]
    target[name] = function (...args) { providerInvocationCount += 1; return original.apply(this, args) }
    restores.push(() => { target[name] = original })
  }
  wrapMethod(paymentService, 'resolveProvider')
  for (const provider of paymentService.providers.values()) {
    for (const method of ['refundPayment', 'queryRefund', 'queryPayment', 'closePayment']) wrapMethod(provider, method)
  }

  const meituan = await createExternal('MEITUAN', 'rc2b-meituan-order', 2)
  const meituanItem = meituan.order.items[0]
  const inventoryBefore = await prisma.inventoryItem.findUnique({ where: { id: 'product-rc2b' } })
  const stockBefore = await prisma.stockBalance.count()
  const partial = await manualRefund(meituan.order.id, refundBody('rc2b-meituan-partial', meituanItem.id, 1, 10_000, {
    externalRefundReference: 'MT-RF-1',
  }))
  assert.equal(partial.status, 201, JSON.stringify(partial.body))
  assert.equal(partial.body.refund.refundMode, 'MANUAL_EXTERNAL')
  assert.equal(partial.body.refund.paymentId, null)
  assert.equal(partial.body.refund.externalRefundReference, 'MT-RF-1')
  assert.equal(partial.body.order.status, 'partially_refunded')
  assert.equal(partial.body.order.paymentStatus, 'partially_refunded')
  assert.equal(partial.body.order.externalSettlement.status, 'PARTIALLY_REFUNDED')
  assert.equal(partial.body.refund.items.reduce((sum, row) => sum + BigInt(row.amountCents), 0n), 10_000n)

  const replay = await manualRefund(meituan.order.id, refundBody('rc2b-meituan-partial', meituanItem.id, 1, 10_000, {
    externalRefundReference: 'MT-RF-1',
  }))
  assert.equal(replay.status, 200)
  assert.equal(replay.body.reused, true)
  assert.equal(replay.body.refund.id, partial.body.refund.id)
  const replayConflict = await manualRefund(meituan.order.id, refundBody('rc2b-meituan-partial', meituanItem.id, 1, 10_000, {
    externalRefundReference: 'DIFFERENT',
  }))
  assert.equal(replayConflict.status, 409)

  const full = await manualRefund(meituan.order.id, refundBody('rc2b-meituan-full', meituanItem.id, 1, 10_000))
  assert.equal(full.status, 201, JSON.stringify(full.body))
  assert.equal(full.body.order.status, 'refunded')
  assert.equal(full.body.order.paymentStatus, 'refunded')
  assert.equal(full.body.order.externalSettlement.status, 'REFUNDED')
  assert.equal(full.body.order.businessDate, meituan.order.businessDate)
  assert.equal(new Date(full.body.refund.externalCompletedAt).toISOString(), '2026-08-25T03:04:05.000Z')

  for (const source of ['TAOBAO_FLASH', 'JD_INSTANT', 'OTHER']) {
    const external = await createExternal(source, `rc2b-${source.toLowerCase()}-order`)
    const result = await manualRefund(external.order.id, refundBody(`rc2b-${source.toLowerCase()}-refund`, external.order.items[0].id, 1, 10_000))
    assert.equal(result.status, 201, source)
    assert.equal(result.body.order.status, 'refunded')
    assert.equal(result.body.order.externalSettlement.status, 'REFUNDED')
    assert.equal(result.body.order.payments.length, 0)
  }
  assert.equal(providerInvocationCount, 0)
  assert.equal(await prisma.payment.count({ where: { order: { settlementAuthority: 'EXTERNAL' } } }), 0)

  const permissionOrder = await createExternal('MEITUAN', 'rc2b-permission-order')
  const permissionBody = refundBody('rc2b-permission-refund', permissionOrder.order.items[0].id, 1, 10_000)
  assert.equal((await manualRefund(permissionOrder.order.id, permissionBody, noCapCookie)).status, 403)
  assert.equal((await manualRefund(permissionOrder.order.id, permissionBody, oneCapCookie)).status, 403)
  assert.equal((await manualRefund(permissionOrder.order.id, permissionBody, otherStoreCookie)).status, 403)

  for (const controlled of ['status', 'refundMode', 'paymentId', 'externalSettlementId', 'completedAt', 'providerRefundNo']) {
    const result = await manualRefund(permissionOrder.order.id, refundBody(`rc2b-controlled-${controlled}`, permissionOrder.order.items[0].id, 1, 10_000, {
      [controlled]: controlled === 'completedAt' ? new Date().toISOString() : 'client-value',
    }))
    assert.equal(result.status, 400, controlled)
  }
  const numberAmount = await manualRefund(permissionOrder.order.id, { ...permissionBody, requestKey: 'rc2b-number-amount', refundAmount: 10_000 })
  assert.equal(numberAmount.status, 400)

  const overAmount = await manualRefund(permissionOrder.order.id, { ...permissionBody, requestKey: 'rc2b-over-amount', refundAmount: '10001' })
  assert.equal(overAmount.status, 409)
  const overQuantity = await manualRefund(permissionOrder.order.id, { ...permissionBody, requestKey: 'rc2b-over-quantity', items: [{ orderItemId: permissionOrder.order.items[0].id, quantity: 2 }] })
  assert.equal(overQuantity.status, 409)

  const concurrentOrder = await createExternal('JD_INSTANT', 'rc2b-concurrent-order')
  const concurrentBody = refundBody('rc2b-concurrent-a', concurrentOrder.order.items[0].id, 1, 10_000)
  const concurrent = await Promise.all([
    manualRefund(concurrentOrder.order.id, concurrentBody),
    manualRefund(concurrentOrder.order.id, { ...concurrentBody, requestKey: 'rc2b-concurrent-b' }),
  ])
  assert.deepEqual(concurrent.map((entry) => entry.status).sort(), [201, 409])
  assert.equal(await prisma.refund.count({ where: { orderId: concurrentOrder.order.id } }), 1)

  // Database invariants reject crossed authority, XOR and order/item mismatch.
  await assert.rejects(() => prisma.refund.create({ data: {
    id: 'refund-xor-null', refundNo: 'RF-XOR-NULL', orderId: permissionOrder.order.id,
    paymentId: null, externalSettlementId: null, refundMode: 'MANUAL_EXTERNAL', refundAmount: 1n,
    status: 'completed', requestKey: 'rc2b-xor-null', requestedBy: 'tester', approvedBy: 'tester',
    completedAt: new Date(), externalCompletedAt: new Date(),
  } }), rejectedByDb)
  await assert.rejects(() => prisma.refund.create({ data: {
    id: 'refund-cross-payment', refundNo: 'RF-CROSS-PAY', orderId: permissionOrder.order.id,
    paymentId: cashPayment.body.payment.id, externalSettlementId: permissionOrder.externalSettlement.id,
    refundMode: 'MANUAL_EXTERNAL', refundAmount: 1n, status: 'completed', requestKey: 'rc2b-cross-payment',
    requestedBy: 'tester', approvedBy: 'tester', completedAt: new Date(), externalCompletedAt: new Date(),
  } }), rejectedByDb)
  await assert.rejects(() => prisma.refund.create({ data: {
    id: 'refund-cross-external', refundNo: 'RF-CROSS-EXT', orderId: posOrder.body.order.id,
    paymentId: cashPayment.body.payment.id, externalSettlementId: null, refundMode: 'MANUAL_EXTERNAL',
    refundAmount: 1n, status: 'completed', requestKey: 'rc2b-cross-external', requestedBy: 'tester', approvedBy: 'tester',
    completedAt: new Date(), externalCompletedAt: new Date(),
  } }), rejectedByDb)
  await assert.rejects(() => prisma.refund.create({ data: {
    id: 'refund-order-mismatch', refundNo: 'RF-ORDER-MISMATCH', orderId: permissionOrder.order.id,
    paymentId: null, externalSettlementId: concurrentOrder.externalSettlement.id, refundMode: 'MANUAL_EXTERNAL',
    refundAmount: 1n, status: 'completed', requestKey: 'rc2b-order-mismatch', requestedBy: 'tester', approvedBy: 'tester',
    completedAt: new Date(), externalCompletedAt: new Date(),
  } }), rejectedByDb)

  const duplicateRefund = partial.body.refund
  await assert.rejects(() => prisma.refundItem.create({ data: {
    id: 'refund-item-duplicate', refundId: duplicateRefund.id, orderItemId: meituanItem.id, quantity: 1, amountCents: 1n,
  } }), rejectedByDb)
  await assert.rejects(() => prisma.refundItem.create({ data: {
    id: 'refund-item-other-order', refundId: duplicateRefund.id,
    orderItemId: concurrentOrder.order.items[0].id, quantity: 1, amountCents: 1n,
  } }), rejectedByDb)

  const inventoryAfter = await prisma.inventoryItem.findUnique({ where: { id: 'product-rc2b' } })
  assert.equal(inventoryAfter.costPriceCents, inventoryBefore.costPriceCents)
  assert.equal(inventoryAfter.salePriceCents, inventoryBefore.salePriceCents)
  assert.equal(await prisma.stockBalance.count(), stockBefore)
  const cogsSnapshots = await prisma.orderItem.findMany({ where: { orderId: meituan.order.id }, select: { costPriceSnapshot: true } })
  assert.equal(cogsSnapshots.every((row) => row.costPriceSnapshot === 4_321n), true)
  assert.equal(await prisma.refund.count({ where: { refundMode: 'MANUAL_EXTERNAL', status: { not: 'completed' } } }), 0)
  assert.equal(await prisma.refund.count({ where: { refundMode: 'MANUAL_EXTERNAL', paymentId: { not: null } } }), 0)

  const indices = await prisma.$queryRawUnsafe(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'refund_items_refund_id_order_item_id_key'
  `)
  assert.equal(indices.length, 1)
  const invalidAllocation = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count FROM "refunds" r
    WHERE NOT EXISTS (SELECT 1 FROM "refund_items" ri WHERE ri."refund_id" = r."id")
       OR r."refund_amount" <> (SELECT COALESCE(SUM(ri."amount_cents"), 0) FROM "refund_items" ri WHERE ri."refund_id" = r."id")
  `)
  assert.equal(Number(invalidAllocation[0].count), 0)

  for (const restore of restores.reverse()) restore()
  const posUi = fs.readFileSync(path.join(root, 'src', 'components', 'PosPage.jsx'), 'utf8')
  assert.equal(posUi.includes('manual-external-refunds'), false)
  assert.equal(posUi.includes('MANUAL_EXTERNAL'), false)
  console.log('REPORT CENTER RC-2B WORKFLOW TEST OK — required cases 4-30 covered; PAYMENT cases 1-5 run in targeted regression')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
