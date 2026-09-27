import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc2c-'))
process.env.DATA_DIR = dataDir
process.env.PAYMENT_MODE = 'mock'
process.env.DATABASE_URL = await createDisposablePgSchema('report_center_rc2c')

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

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = await request(origin, '/api/auth/register', { method: 'POST', body: { username: 'rc2c-developer', password: '123456' } })
  assert.equal(register.status, 200)
  const developerCookie = register.headers.get('set-cookie')?.split(';')[0] || ''

  await prisma.store.createMany({ data: [{ key: 'store-a', name: '测试门店 A' }, { key: 'store-b', name: '测试门店 B' }] })
  await prisma.inventoryItem.createMany({ data: [
    { id: 'product-a', name: '平台商品 A', category: 'product', sku: 'RC2C-A', unit: '件', salePriceCents: 10_000n, costPriceCents: 3_500n, isActive: true },
    { id: 'product-b', name: '平台商品 B', category: 'product', sku: 'RC2C-B', unit: '件', salePriceCents: 5_000n, costPriceCents: 1_500n, isActive: true },
  ] })
  const createUser = (id, username, storeKeys, permissions) => prisma.user.create({ data: {
    id, username, passwordHash: hashPassword('123456'), role: 'staff', storeKeys, status: 'active',
    permissions: normalizeAccountPermissions(permissions, 'staff'),
  } })
  await createUser('staff-no-cap', 'staff-no-cap', ['store-a'], {})
  await createUser('staff-platform', 'staff-platform', ['store-a'], {
    externalOrderCreate: true, externalSettlementConfirm: true,
    manualExternalRefundRecord: true, manualExternalRefundConfirm: true,
  })
  await createUser('staff-other-store', 'staff-other-store', ['store-b'], {
    externalOrderCreate: true, externalSettlementConfirm: true,
    manualExternalRefundRecord: true, manualExternalRefundConfirm: true,
  })
  const login = async (username) => {
    const response = await request(origin, '/api/auth/login', { method: 'POST', body: { username, password: '123456' } })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')?.split(';')[0] || ''
  }
  const noCapCookie = await login('staff-no-cap')
  const platformCookie = await login('staff-platform')
  const otherStoreCookie = await login('staff-other-store')

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
    for (const method of ['createPayment', 'refundPayment', 'queryRefund', 'queryPayment', 'closePayment']) wrapMethod(provider, method)
  }

  const externalBody = (source, requestKey) => ({
    storeId: 'store-a', orderSource: source, requestKey, confirm: true,
    items: [
      { productId: 'product-a', quantity: 2 },
      { productId: 'product-b', quantity: 1 },
      { productId: 'product-b', quantity: 1, gift: true },
    ],
    discountPercent: 85,
    remark: '平台 POS 人工同步',
  })
  const createExternal = async (source, key, cookie = platformCookie) => json(await request(origin, '/api/v2/pos/external-orders', {
    cookie, method: 'POST', body: externalBody(source, key),
  }))

  const empty = await json(await request(origin, '/api/v2/pos/external-orders', {
    cookie: platformCookie, method: 'POST', body: { ...externalBody('MEITUAN', 'rc2c-empty-cart'), items: [] },
  }))
  assert.equal(empty.status, 400)
  assert.equal((await createExternal('MEITUAN', 'rc2c-no-cap', noCapCookie)).status, 403)
  assert.equal((await createExternal('MEITUAN', 'rc2c-wrong-store', otherStoreCookie)).status, 403)

  const orders = new Map()
  for (const source of ['MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', 'OTHER']) {
    const created = await createExternal(source, `rc2c-${source.toLowerCase()}`)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.order.orderSource, source)
    assert.equal(created.body.order.entryMode, 'MANUAL_POS')
    assert.equal(created.body.order.settlementAuthority, 'EXTERNAL')
    assert.equal(created.body.order.sourceOrderRef, null)
    assert.equal(created.body.order.status, 'completed')
    assert.equal(created.body.order.paymentStatus, 'paid')
    assert.equal(created.body.order.payments.length, 0)
    assert.equal(created.body.externalSettlement.settlementType, source === 'OTHER' ? 'CUSTOM' : 'PLATFORM')
    assert.equal(created.body.externalSettlement.status, 'CONFIRMED')
    assert.equal(created.body.order.items.find((item) => item.isGift).actualAmount, '0')
    orders.set(source, created.body)
  }

  const replay = await createExternal('MEITUAN', 'rc2c-meituan')
  assert.equal(replay.status, 200)
  assert.equal(replay.body.reused, true)
  assert.equal(replay.body.order.id, orders.get('MEITUAN').order.id)
  const changedReplay = await json(await request(origin, '/api/v2/pos/external-orders', {
    cookie: platformCookie, method: 'POST', body: { ...externalBody('MEITUAN', 'rc2c-meituan'), discountPercent: 100 },
  }))
  assert.equal(changedReplay.status, 409)

  const forbiddenState = await json(await request(origin, '/api/v2/pos/external-orders', {
    cookie: platformCookie, method: 'POST', body: { ...externalBody('MEITUAN', 'rc2c-forged-state'), settlementAuthority: 'PAYMENT' },
  }))
  assert.equal(forbiddenState.status, 400)

  const meituan = orders.get('MEITUAN').order
  const normalItems = meituan.items.filter((item) => !item.isGift)
  const productAItem = normalItems.find((item) => item.productId === 'product-a')
  const productBItem = normalItems.find((item) => item.productId === 'product-b')
  const giftItem = meituan.items.find((item) => item.isGift)
  const inventoryBefore = await prisma.inventoryItem.findMany({ orderBy: { id: 'asc' } })
  const balanceBefore = await prisma.stockBalance.findMany({ orderBy: { id: 'asc' } })
  const ledgerBefore = await prisma.stockLedger.findMany({ orderBy: { id: 'asc' } })
  const costSnapshotsBefore = await prisma.orderItem.findMany({ where: { orderId: meituan.id }, orderBy: { id: 'asc' }, select: { id: true, costPriceSnapshot: true } })
  const completedAt = '2026-08-31T08:30:00.000Z'
  const partialBody = {
    requestKey: 'rc2c-refund-partial',
    items: [{ orderItemId: productBItem.id, quantity: 1 }],
    refundAmount: '4250', externalCompletedAt: completedAt, reason: '平台已完成部分退款',
  }
  const refund = async (body, cookie = platformCookie) => json(await request(origin, `/api/v2/pos/orders/${meituan.id}/manual-external-refunds`, { cookie, method: 'POST', body }))
  const partial = await refund(partialBody)
  assert.equal(partial.status, 201, JSON.stringify(partial.body))
  assert.equal(partial.body.order.status, 'partially_refunded')
  assert.equal(partial.body.order.externalSettlement.status, 'PARTIALLY_REFUNDED')
  assert.equal(partial.body.refund.refundMode, 'MANUAL_EXTERNAL')
  assert.equal(partial.body.refund.paymentId, null)
  assert.equal(partial.body.refund.externalRefundReference, null)
  assert.equal(partial.body.refund.items.reduce((sum, item) => sum + BigInt(item.amountCents), 0n), 4250n)
  assert.equal((await refund(partialBody)).status, 200)

  const giftRefund = await refund({ ...partialBody, requestKey: 'rc2c-refund-gift', items: [{ orderItemId: giftItem.id, quantity: 1 }] })
  assert.equal(giftRefund.status, 400)
  const overAmount = await refund({ ...partialBody, requestKey: 'rc2c-refund-over', refundAmount: (BigInt(meituan.payableAmount) + 1n).toString() })
  assert.equal(overAmount.status, 409)
  const overQuantity = await refund({ ...partialBody, requestKey: 'rc2c-refund-over-qty', items: [{ orderItemId: productAItem.id, quantity: 3 }] })
  assert.equal(overQuantity.status, 409)

  const remaining = BigInt(meituan.payableAmount) - 4250n
  const full = await refund({
    requestKey: 'rc2c-refund-full',
    items: [
      { orderItemId: productAItem.id, quantity: 2 },
    ],
    refundAmount: remaining.toString(), externalCompletedAt: completedAt, reason: '平台已完成剩余退款',
  })
  assert.equal(full.status, 201, JSON.stringify(full.body))
  assert.equal(full.body.order.status, 'refunded')
  assert.equal(full.body.order.externalSettlement.status, 'REFUNDED')
  assert.equal(full.body.order.items.reduce((sum, item) => sum + item.quantity, 0), 4)

  const concurrentOrder = orders.get('JD_INSTANT').order
  const concurrentItem = concurrentOrder.items.find((item) => item.productId === 'product-a' && !item.isGift)
  const concurrentRefund = async (requestKey) => json(await request(origin, `/api/v2/pos/orders/${concurrentOrder.id}/manual-external-refunds`, {
    cookie: platformCookie,
    method: 'POST',
    body: {
      requestKey,
      items: [{ orderItemId: concurrentItem.id, quantity: 2 }],
      refundAmount: '17000',
      externalCompletedAt: completedAt,
      reason: '并发平台退款保护',
    },
  }))
  const concurrent = await Promise.all([
    concurrentRefund('rc2c-concurrent-a'),
    concurrentRefund('rc2c-concurrent-b'),
  ])
  assert.deepEqual(concurrent.map((entry) => entry.status).sort(), [201, 409])
  assert.equal(await prisma.refund.count({ where: { orderId: concurrentOrder.id } }), 1)

  assert.equal(providerInvocationCount, 0)
  assert.equal(await prisma.payment.count({ where: { order: { settlementAuthority: 'EXTERNAL' } } }), 0)
  assert.deepEqual(await prisma.inventoryItem.findMany({ orderBy: { id: 'asc' } }), inventoryBefore)
  assert.deepEqual(await prisma.stockBalance.findMany({ orderBy: { id: 'asc' } }), balanceBefore)
  assert.deepEqual(await prisma.stockLedger.findMany({ orderBy: { id: 'asc' } }), ledgerBefore)
  assert.deepEqual(await prisma.orderItem.findMany({ where: { orderId: meituan.id }, orderBy: { id: 'asc' }, select: { id: true, costPriceSnapshot: true } }), costSnapshotsBefore)

  const storePos = await json(await request(origin, '/api/v2/pos/orders', {
    cookie: developerCookie, method: 'POST', body: { storeId: 'store-a', checkoutKey: 'rc2c-store-pos', items: [{ productId: 'product-a', quantity: 1 }], discountPercent: 100 },
  }))
  assert.equal(storePos.status, 201)
  assert.equal(storePos.body.order.settlementAuthority, 'PAYMENT')
  assert.equal(storePos.body.order.externalSettlement, null)

  for (const restore of restores.reverse()) restore()
  console.log(JSON.stringify({
    ok: true,
    platformSources: [...orders.keys()],
    externalPayments: 0,
    providerInvocationCount,
    partialRefund: partial.body.refund.id,
    fullRefund: full.body.refund.id,
  }))
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
