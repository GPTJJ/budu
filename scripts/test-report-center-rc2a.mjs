import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDisposablePgSchema } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc2a-'))
process.env.DATA_DIR = dataDir
process.env.PAYMENT_MODE = 'mock'
process.env.DATABASE_URL = await createDisposablePgSchema('report_center_rc2a')

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

const externalBody = (orderSource, requestKey, overrides = {}) => ({
  storeId: 'store-a',
  orderSource,
  requestKey,
  items: [{ productId: 'product-bigint', quantity: 1 }],
  discountPercent: 100,
  remark: `${orderSource} isolated test`,
  ...overrides,
})

const isAuthorityConstraintError = (error) => ['P2002', 'P2004'].includes(error?.code)
  || /23514|authority does not match order|cannot coexist/i.test(String(error?.message || ''))

try {
  await new Promise((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = await request(origin, '/api/auth/register', { method: 'POST', body: { username: 'rc2a-developer', password: '123456' } })
  assert.equal(register.status, 200)
  const developerCookie = register.headers.get('set-cookie')?.split(';')[0] || ''
  const developer = (await register.json()).user

  await prisma.store.createMany({ data: [{ key: 'store-a', name: '测试门店 A' }, { key: 'store-b', name: '测试门店 B' }] })
  await prisma.inventoryItem.create({
    data: {
      id: 'product-bigint',
      name: 'BigInt 权威商品',
      category: 'product',
      sku: 'RC2A-BIGINT',
      unit: '件',
      salePriceCents: 99999999999n,
      costPriceCents: 123456789n,
      isActive: true,
    },
  })

  const createUser = (id, username, role, storeKeys, permissions) => prisma.user.create({
    data: {
      id,
      username,
      passwordHash: hashPassword('123456'),
      role,
      storeKeys,
      status: 'active',
      permissions: normalizeAccountPermissions(permissions, role),
    },
  })
  await createUser('staff-no-cap', 'staff-no-cap', 'staff', ['store-a'], {})
  await createUser('manager-other-store', 'manager-other-store', 'manager', ['store-b'], {
    externalOrderCreate: true,
    externalSettlementConfirm: true,
  })
  const login = async (username) => {
    const response = await request(origin, '/api/auth/login', { method: 'POST', body: { username, password: '123456' } })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')?.split(';')[0] || ''
  }
  const noCapabilityCookie = await login('staff-no-cap')
  const otherStoreCookie = await login('manager-other-store')

  assert.equal(await prisma.externalSettlement.count(), 0, 'new authority must start empty')
  const posConfig = await json(await request(origin, '/api/v2/pos/config?storeId=store-a', { cookie: developerCookie }))
  assert.equal(posConfig.status, 200)
  assert.deepEqual(posConfig.body.channels, ['cash'])
  assert.equal(posConfig.body.channels.includes('alipay'), false)

  const denied = await json(await request(origin, '/api/v2/pos/external-orders', {
    cookie: noCapabilityCookie,
    method: 'POST',
    body: externalBody('MEITUAN', 'rc2a-denied-request'),
  }))
  assert.equal(denied.status, 403)

  let providerResolutionCount = 0
  const originalResolveProvider = paymentService.resolveProvider.bind(paymentService)
  paymentService.resolveProvider = (...args) => {
    providerResolutionCount += 1
    return originalResolveProvider(...args)
  }

  const expected = {
    MEITUAN: 'PLATFORM',
    TAOBAO_FLASH: 'PLATFORM',
    JD_INSTANT: 'PLATFORM',
    OTHER: 'CUSTOM',
  }
  const completed = []
  for (const [source, settlementType] of Object.entries(expected)) {
    const result = await json(await request(origin, '/api/v2/pos/external-orders', {
      cookie: developerCookie,
      method: 'POST',
      body: externalBody(source, `rc2a-${source.toLowerCase()}-request`, { confirm: true }),
    }))
    assert.equal(result.status, 201, `${source} create+confirm: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.order.orderSource, source)
    assert.equal(result.body.order.entryMode, 'MANUAL_POS')
    assert.equal(result.body.order.settlementAuthority, 'EXTERNAL')
    assert.equal(result.body.order.sourceOrderRef, null)
    assert.equal(result.body.order.status, 'completed')
    assert.equal(result.body.order.paymentStatus, 'paid')
    assert.equal(result.body.order.payments.length, 0)
    assert.equal(result.body.externalSettlement.settlementType, settlementType)
    assert.equal(result.body.externalSettlement.status, 'CONFIRMED')
    assert.equal(result.body.externalSettlement.amountCents, '99999999999')
    assert.equal(typeof result.body.externalSettlement.amountCents, 'string')
    completed.push(result.body)
  }
  assert.equal(providerResolutionCount, 0)
  assert.equal(await prisma.payment.count(), 0)

  const duplicateBody = externalBody('MEITUAN', 'rc2a-duplicate-request', { confirm: true })
  const duplicateFirst = await json(await request(origin, '/api/v2/pos/external-orders', { cookie: developerCookie, method: 'POST', body: duplicateBody }))
  const duplicateSecond = await json(await request(origin, '/api/v2/pos/external-orders', { cookie: developerCookie, method: 'POST', body: duplicateBody }))
  assert.equal(duplicateFirst.status, 201)
  assert.equal(duplicateSecond.status, 200)
  assert.equal(duplicateSecond.body.reused, true)
  assert.equal(duplicateSecond.body.order.id, duplicateFirst.body.order.id)
  assert.equal(duplicateSecond.body.externalSettlement.id, duplicateFirst.body.externalSettlement.id)

  for (const controlled of ['status', 'paymentStatus', 'completedAt']) {
    const rejected = await json(await request(origin, '/api/v2/pos/external-orders', {
      cookie: developerCookie,
      method: 'POST',
      body: externalBody('MEITUAN', `rc2a-controlled-${controlled}`, { [controlled]: controlled === 'completedAt' ? new Date().toISOString() : 'completed' }),
    }))
    assert.equal(rejected.status, 400, `${controlled} must be rejected`)
  }

  const pendingMismatch = await json(await request(origin, '/api/v2/pos/external-orders', {
    cookie: developerCookie,
    method: 'POST',
    body: externalBody('TAOBAO_FLASH', 'rc2a-mismatch-request'),
  }))
  assert.equal(pendingMismatch.status, 201)
  assert.equal(pendingMismatch.body.order.status, 'pending_payment')
  const mismatch = await json(await request(origin, `/api/v2/pos/external-settlements/${pendingMismatch.body.externalSettlement.id}/confirm`, {
    cookie: developerCookie,
    method: 'POST',
    body: { amountCents: '99999999998' },
  }))
  assert.equal(mismatch.status, 409)
  const numberAmount = await json(await request(origin, `/api/v2/pos/external-settlements/${pendingMismatch.body.externalSettlement.id}/confirm`, {
    cookie: developerCookie,
    method: 'POST',
    body: { amountCents: 99999999999 },
  }))
  assert.equal(numberAmount.status, 400)

  const isolated = await json(await request(origin, `/api/v2/pos/external-settlements/${pendingMismatch.body.externalSettlement.id}/confirm`, {
    cookie: otherStoreCookie,
    method: 'POST',
    body: { amountCents: '99999999999' },
  }))
  assert.equal(isolated.status, 403)

  const concurrentPending = await json(await request(origin, '/api/v2/pos/external-orders', {
    cookie: developerCookie,
    method: 'POST',
    body: externalBody('JD_INSTANT', 'rc2a-concurrent-request'),
  }))
  const concurrentPath = `/api/v2/pos/external-settlements/${concurrentPending.body.externalSettlement.id}/confirm`
  const concurrent = await Promise.all([
    request(origin, concurrentPath, { cookie: developerCookie, method: 'POST', body: { amountCents: '99999999999' } }).then(json),
    request(origin, concurrentPath, { cookie: developerCookie, method: 'POST', body: { amountCents: '99999999999' } }).then(json),
  ])
  assert.deepEqual(concurrent.map((result) => result.status), [200, 200])
  assert.equal((await prisma.externalSettlement.findUnique({ where: { id: concurrentPending.body.externalSettlement.id } })).status, 'CONFIRMED')

  const externalPaymentAttempt = await json(await request(origin, `/api/v2/pos/orders/${completed[0].order.id}/payments`, {
    cookie: developerCookie,
    method: 'POST',
    body: { channel: 'cash', requestKey: 'rc2a-illegal-payment' },
  }))
  assert.equal(externalPaymentAttempt.status, 409)
  assert.equal(providerResolutionCount, 0, 'external order rejection must happen before resolveProvider')
  paymentService.resolveProvider = originalResolveProvider

  await assert.rejects(
    () => prisma.externalSettlement.update({
      where: { id: completed[0].externalSettlement.id },
      data: { confirmedBy: 'rewritten-auditor' },
    }),
    isAuthorityConstraintError,
  )

  await assert.rejects(
    () => prisma.externalSettlement.create({
      data: {
        id: 'ext-duplicate-order',
        settlementNo: 'EXT-DUPLICATE-ORDER',
        orderId: completed[0].order.id,
        settlementType: 'PLATFORM',
        amountCents: 99999999999n,
        requestKey: 'rc2a-duplicate-order-settlement',
        recordedBy: developer.id,
      },
    }),
    isAuthorityConstraintError,
  )

  const paymentOrder = await json(await request(origin, '/api/v2/pos/orders', {
    cookie: developerCookie,
    method: 'POST',
    body: { storeId: 'store-a', checkoutKey: 'rc2a-payment-order', items: [{ productId: 'product-bigint', quantity: 1 }], discountPercent: 100 },
  }))
  assert.equal(paymentOrder.status, 201)
  assert.equal(paymentOrder.body.order.orderSource, 'STORE_POS')
  assert.equal(paymentOrder.body.order.entryMode, 'POS_CHECKOUT')
  assert.equal(paymentOrder.body.order.settlementAuthority, 'PAYMENT')
  await assert.rejects(
    () => prisma.externalSettlement.create({
      data: {
        id: 'ext-payment-order',
        settlementNo: 'EXT-PAYMENT-ORDER',
        orderId: paymentOrder.body.order.id,
        settlementType: 'PLATFORM',
        amountCents: 99999999999n,
        requestKey: 'rc2a-payment-order-external',
        recordedBy: developer.id,
      },
    }),
    isAuthorityConstraintError,
  )
  await assert.rejects(
    () => prisma.order.update({
      where: { id: paymentOrder.body.order.id },
      data: { status: 'completed', paymentStatus: 'paid', completedAt: new Date() },
    }),
    isAuthorityConstraintError,
  )
  const cash = await json(await request(origin, `/api/v2/pos/orders/${paymentOrder.body.order.id}/payments`, {
    cookie: developerCookie,
    method: 'POST',
    body: { channel: 'cash', requestKey: 'rc2a-payment-cash' },
  }))
  assert.equal(cash.status, 201)
  assert.equal(cash.body.order.status, 'completed')
  assert.equal(cash.body.order.paymentStatus, 'paid')
  assert.equal(cash.body.order.settlementAuthority, 'PAYMENT')
  assert.equal(cash.body.order.externalSettlement, null)

  const externalCount = await prisma.externalSettlement.count()
  const externalOrderCount = await prisma.order.count({ where: { settlementAuthority: 'EXTERNAL' } })
  assert.equal(externalCount, externalOrderCount)
  assert.equal(await prisma.payment.count({ where: { order: { settlementAuthority: 'EXTERNAL' } } }), 0)
  const invalidSettled = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count
    FROM "orders" o
    WHERE (o."status" IN ('paid','completed','partially_refunded','refunded') OR o."payment_status" IN ('paid','partially_refunded','refunded'))
      AND NOT (
        (o."settlement_authority" = 'PAYMENT' AND EXISTS (
          SELECT 1 FROM "payments" p WHERE p."order_id" = o."id" AND p."status" IN ('success','partially_refunded','refunded') AND p."amount" = o."payable_amount"
        ) AND NOT EXISTS (SELECT 1 FROM "external_settlements" e WHERE e."order_id" = o."id"))
        OR
        (o."settlement_authority" = 'EXTERNAL' AND EXISTS (
          SELECT 1 FROM "external_settlements" e WHERE e."order_id" = o."id" AND e."status" = 'CONFIRMED' AND e."amount_cents" = o."payable_amount"
        ) AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."order_id" = o."id"))
      )
  `)
  assert.equal(Number(invalidSettled[0].count), 0)

  const sourcePosPage = path.join(root, 'src', 'components', 'PosPage.jsx')
  const builtAssets = path.join(root, 'dist', 'assets')
  const posArtifacts = [
    ...(fs.existsSync(sourcePosPage) ? [sourcePosPage] : []),
    ...(fs.existsSync(builtAssets)
      ? fs.readdirSync(builtAssets).filter((name) => /^PosPage-.*\.js$/.test(name)).map((name) => path.join(builtAssets, name))
      : []),
  ]
  assert.notEqual(posArtifacts.length, 0, 'POS source or built artifact must be available for UI exposure audit')
  const posSource = posArtifacts.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  for (const platformToken of ['MEITUAN', 'TAOBAO_FLASH', 'JD_INSTANT', '美团外卖', '淘宝闪购', '京东秒送']) {
    assert.equal(posSource.includes(platformToken), false, `POS UI must not expose ${platformToken}`)
  }
  console.log('REPORT CENTER RC-2A WORKFLOW TEST OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
