import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

// Exercise the actual GET DTO -> UI-shaped JSON -> HTTP review contract. Never
// obtain expected versions from Prisma or silently refresh before a retry.
const databaseUrl = await createDisposablePgDatabase('partner_review_version')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-review-version-'))
process.env.DATABASE_URL = databaseUrl
process.env.DATA_DIR = dataDir
process.env.JWT_SECRET = 'isolated-review-version-test-secret'
const { PrismaClient } = await import('@prisma/client')
const { hashPassword, signToken } = await import('../server/auth.js')
const { createApp } = await import('../server/app.js')
const { prisma: appDb } = await import('../server/pg.js')
const db = new PrismaClient({ datasourceUrl: databaseUrl })
const tag = 'version-' + crypto.randomUUID().slice(0, 8)
const base = '/api/v2/partner-management/replenishment-orders'
const evidence = { result: 'PARTNER_REVIEW_VERSION_HTTP_PASS', cases: [] }
let server
try {
  await db.store.create({ data: { key: 'guanshe', name: 'Isolated review fixture' } })
  const users = {}
  for (const [name, role] of [['a', 'developer'], ['b', 'admin'], ['staff', 'staff'], ['partnerA', 'partner'], ['partnerB', 'partner']]) {
    users[name] = await db.user.create({ data: { id: `${tag}-${name}`, username: `${tag}-${name}`, passwordHash: hashPassword('test-only-password'), role, status: 'active' } })
  }
  const cookies = Object.fromEntries(['a', 'b', 'staff'].map(name => [name, 'budu_token=' + signToken(users[name], process.env.JWT_SECRET)]))
  for (const name of ['A', 'B']) {
    await db.partner.create({ data: { id: `${tag}-${name}`, name: `${tag}-${name}`, defaultStoreKey: 'guanshe', defaultDiscountBps: 6500 } })
    await db.partnerStore.create({ data: { id: `${tag}-store-${name}`, partnerId: `${tag}-${name}`, name: 'Test partner store' } })
    await db.partnerUser.create({ data: { id: `${tag}-binding-${name}`, partnerId: `${tag}-${name}`, userId: users['partner' + name].id } })
  }
  await db.productCategory.create({ data: { id: 'pc-mtd9xjer-sfcmx2', name: 'Canonical candy fixture' } })
  await db.inventoryItem.create({ data: { id: tag, name: tag, sku: tag, productCategoryId: 'pc-mtd9xjer-sfcmx2', category: 'product', unit: '颗', salePriceCents: 500n, isActive: true, partnerReplenishmentEnabled: true, partnerOrderUnit: 'PCS', partnerMinOrderBaseQty: 1, partnerOrderStepBaseQty: 1 } })
  const inventoryBefore = { balances: await db.stockBalance.count(), ledger: await db.stockLedger.count() }
  server = createApp({ partnerDomainMirrorUsers: async () => {} }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(route, { method = 'GET', body, cookie = cookies.a, key } = {}) {
    const response = await fetch(origin + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  for (const name of ['A', 'B']) {
    const login = await request('/api/partner/auth/login', { method: 'POST', cookie: '', body: { username: users['partner' + name].username, password: 'test-only-password' } })
    assert.equal(login.status, 200)
    cookies['partner' + name] = login.cookie
  }
  const pcsQuote = await request('/api/partner/catalogue/quote', { method: 'POST', cookie: cookies.partnerA, body: { productId: tag, orderUnit: 'PCS', quantityPieces: 10 } })
  assert.equal(pcsQuote.status, 200)
  assert.equal(pcsQuote.body.quote.finalAmountCents, '3250')
  const kgQuote = await request('/api/partner/catalogue/quote', { method: 'POST', cookie: cookies.partnerA, body: { productId: tag, orderUnit: 'KG', quantityGrams: 60 } })
  assert.equal(kgQuote.status, 409)
  assert.equal(kgQuote.body.error, 'PARTNER_CANDY_PCS_ONLY')
  evidence.cases.push({ case: 'canonical-candy-pcs-only', pcsQuote: 200, kgQuote: 409, quantity: 10, amountCents: '3250' })
  async function submit(key) {
    const response = await request('/api/partner/replenishment-orders', { method: 'POST', cookie: cookies.partnerA, key, body: { partnerStoreId: `${tag}-store-A`, items: [{ inventoryItemId: tag, quantity: 10, orderUnit: 'PCS' }] } })
    assert.equal(response.status, 201)
    const detail = await request(`${base}/${response.body.order.id}`)
    assert.equal(detail.status, 200)
    const list = await request(base)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.rows.find(row => row.id === detail.body.order.id), detail.body.order)
    return detail.body.order
  }
  const approval = order => ({ version: order.version, reason: 'Isolated review', items: order.items.map(item => ({ itemId: item.id, approvedQuantityBase: 10, reason: '' })) })
  const rejection = order => ({ version: order.version, reason: 'Isolated rejection' })
  const post = (order, action, body, key, cookie = cookies.a) => request(`${base}/${order.id}/${action}`, { method: 'POST', body, key, cookie })
  const first = await submit(tag + '-first')

  if (process.argv.includes('--reproduce-base')) {
    assert.equal(Object.hasOwn(first, 'version'), false)
    const failures = []
    for (const action of ['review-preview', 'approve', 'reject']) {
      const body = action === 'reject' ? rejection(first) : approval(first)
      const wire = JSON.parse(JSON.stringify(body))
      assert.equal(Object.hasOwn(wire, 'version'), false)
      const response = await post(first, action, body, tag + '-' + action)
      assert.equal(response.status, 400)
      assert.equal(response.body.error, 'REPLENISHMENT_REVIEW_VERSION_INVALID')
      failures.push({ route: `${base}/[TEST_ORDER]/${action}`, caller: 'ReviewSheet-shaped HTTP client', payload: { ...wire, ...(wire.items ? { items: wire.items.map(item => ({ ...item, itemId: '[TEST_ITEM]' })) } : {}) }, status: response.status, error: response.body.error, versionPresent: false })
    }
    console.log(JSON.stringify({ result: 'PR_C2_P1_001_REPRODUCED', failures }))
  } else {
    assert.equal(first.version, 1, 'PR-C2-P1-001: internal GET/list must carry the canonical integer version')
    // The real component uses this same resource version for preview/approve and
    // reject; guard both call sites in addition to the executable HTTP chain.
    const ui = fs.readFileSync(new URL('../src/components/PartnerReplenishmentReviewPage.jsx', import.meta.url), 'utf8')
    assert.match(ui, /const reviewPayload = useMemo\(\(\) => \(\{\s*version: order\.version,/)
    assert.match(ui, /action === 'approve' \? reviewPayload : \{ version: order\.version, reason \}/)
    assert.match(ui, /review-preview[^\n]+JSON\.stringify\(reviewPayload\)/)
    const body = approval(first)
    assert.equal(JSON.parse(JSON.stringify(body)).version, first.version)
    const beforePreview = await db.replenishmentOrder.findUnique({ where: { id: first.id } })
    const auditsBeforePreview = await db.partnerAuditLog.count()
    const preview = await post(first, 'review-preview', body)
    assert.equal(preview.status, 200)
    assert.deepEqual(await db.replenishmentOrder.findUnique({ where: { id: first.id } }), beforePreview)
    assert.equal(await db.partnerAuditLog.count(), auditsBeforePreview)
    evidence.cases.push({ case: 'preview', status: 200, expectedVersion: first.version, readOnly: true })
    for (const action of ['review-preview', 'approve', 'reject']) {
      const invalid = action === 'reject' ? rejection(first) : body
      const { version, ...missing } = invalid
      const response = await post(first, action, missing, `${tag}-missing-${action}`)
      assert.equal(response.status, 400)
      assert.equal(response.body.error, 'REPLENISHMENT_REVIEW_VERSION_INVALID')
    }
    const approved = await post(first, 'approve', body, tag + '-approve')
    assert.equal(approved.status, 201)
    assert.equal(approved.body.order.status, 'APPROVED')
    assert.equal(approved.body.order.version, first.version + 1)
    assert.equal(approved.body.order.items[0].approvedQuantityBase, 10)
    for (const action of ['review-preview', 'approve', 'reject']) {
      const response = await post(first, action, action === 'reject' ? rejection(first) : body, `${tag}-stale-${action}`)
      assert.equal(response.status, 409)
      assert.equal(response.body.error, 'REPLENISHMENT_REVIEW_STALE')
      evidence.cases.push({ case: 'stale-' + action, status: response.status, error: response.body.error, expectedVersion: first.version, currentVersion: approved.body.order.version })
    }
    const retry = await post(first, 'approve', body, tag + '-approve')
    assert.equal(retry.status, 200)
    assert.equal(retry.body.reused, true)
    assert.equal(retry.body.order.version, 2)
    assert.equal(await db.partnerAuditLog.count({ where: { entityId: first.id, action: 'REPLENISHMENT_ORDER_APPROVED' } }), 1)
    assert.equal((await post(first, 'approve', { ...body, version: 2 }, tag + '-approve')).status, 409, 'same key with a refreshed version changes the payload and must fail')
    evidence.cases.push({ case: 'approve-retry', first: 201, retry: 200, reused: true, audits: 1 })

    const shipBody = (order, quantity, tracking) => ({ fulfillmentStoreKey: 'guanshe', carrier: 'TEST ONLY', trackingNumber: tracking, freightType: 'PREPAID', items: [{ orderItemId: order.items[0].id, shippedQuantityBase: quantity }] })
    const shipped1 = await post(first, 'shipments', shipBody(approved.body.order, 4, 'TEST-1'), tag + '-ship1')
    assert.equal(shipped1.status, 201)
    assert.equal(shipped1.body.order.status, 'PARTIALLY_SHIPPED')
    assert.equal(shipped1.body.order.version, 3)
    assert.equal(shipped1.body.order.items[0].shippedQuantityBase, 4)
    assert.equal(shipped1.body.order.items[0].remainingQuantityBase, 6)
    const shipRetry = await post(first, 'shipments', shipBody(approved.body.order, 4, 'TEST-1'), tag + '-ship1')
    assert.equal(shipRetry.status, 200)
    assert.equal(shipRetry.body.reused, true)
    assert.equal(shipRetry.body.order.version, 3)
    const fresh = (await request(`${base}/${first.id}`)).body.order
    assert.equal(fresh.version, 3)
    const excessive = await post(first, 'shipments', shipBody(fresh, 7, 'TEST-OVER'), tag + '-over')
    assert.equal(excessive.status, 409)
    assert.equal(excessive.body.error, 'REPLENISHMENT_SHIPMENT_OVER_SHIP')
    // Shipment has no client expected-version contract: server locks and reads
    // current remaining quantity. Do not invent a new shipment API in this fix.
    assert.equal((await post(first, 'shipments', { ...shipBody(fresh, 6, 'TEST-2'), version: 1 }, tag + '-ship-version')).status, 400)
    const shipped2 = await post(first, 'shipments', shipBody(fresh, 6, 'TEST-2'), tag + '-ship2')
    assert.equal(shipped2.status, 201)
    assert.equal(shipped2.body.order.status, 'SHIPPED')
    assert.equal(shipped2.body.order.version, 4)
    assert.equal(shipped2.body.order.items[0].approvedQuantityBase, 10)
    assert.equal(shipped2.body.order.items[0].shippedQuantityBase, 10)
    assert.equal(shipped2.body.order.items[0].remainingQuantityBase, 0)
    const finalRetry = await post(first, 'shipments', shipBody(fresh, 6, 'TEST-2'), tag + '-ship2')
    assert.equal(finalRetry.status, 200)
    assert.equal(finalRetry.body.order.version, 4)
    assert.equal(await db.replenishmentShipment.count({ where: { replenishmentOrderId: first.id } }), 2)
    evidence.cases.push({ case: 'multi-shipment', versions: [1, 2, 3, 4], quantities: [4, 6], total: 10, retriesReused: true, overship: excessive.status, inventoryChanged: false })

    const second = await submit(tag + '-reject-order')
    assert.equal((await post(second, 'review-preview', approval(second))).status, 200)
    const rejectBody = rejection(second)
    assert.equal(JSON.parse(JSON.stringify(rejectBody)).version, second.version)
    const rejected = await post(second, 'reject', rejectBody, tag + '-reject')
    assert.equal(rejected.status, 201)
    assert.equal(rejected.body.order.status, 'REJECTED')
    assert.equal(rejected.body.order.version, 2)
    assert.equal(rejected.body.order.reviewReason, rejectBody.reason)
    const rejectRetry = await post(second, 'reject', rejectBody, tag + '-reject')
    assert.equal(rejectRetry.status, 200)
    assert.equal(rejectRetry.body.reused, true)
    assert.equal(rejectRetry.body.order.version, 2)
    assert.equal(await db.partnerAuditLog.count({ where: { entityId: second.id, action: 'REPLENISHMENT_ORDER_REJECTED' } }), 1)
    for (const action of ['review-preview', 'approve', 'reject']) {
      const response = await post(second, action, action === 'reject' ? rejectBody : approval(second), `${tag}-rejected-${action}`)
      assert.equal(response.status, 409)
      assert.equal(response.body.error, 'REPLENISHMENT_REVIEW_STALE')
    }
    assert.equal((await post(second, 'approve', approval(rejected.body.order), tag + '-revive')).status, 409)
    assert.equal((await post(second, 'shipments', shipBody(rejected.body.order, 1, 'TEST-DENIED'), tag + '-ship-rejected')).status, 409)
    evidence.cases.push({ case: 'reject', status: 201, retry: 200, version: 2, illegalApprovalAndShipmentDenied: true })

    for (let round = 0; round < 3; round++) {
      const order = await submit(`${tag}-race-order-${round}`)
      const competing = await Promise.all([
        post(order, 'approve', approval(order), `${tag}-race-approve-${round}`, cookies.a),
        post(order, 'reject', rejection(order), `${tag}-race-reject-${round}`, cookies.b),
      ])
      assert.deepEqual(competing.map(x => x.status).sort(), [201, 409])
      assert(['REPLENISHMENT_REVIEW_STALE', 'REPLENISHMENT_REVIEW_CONFLICT'].includes(competing.find(x => x.status === 409).body.error))
      const current = (await request(`${base}/${order.id}`)).body.order
      assert.equal(current.version, 2)
      assert.equal(current.status, competing.find(x => x.status === 201).body.order.status)
      assert.equal(await db.partnerAuditLog.count({ where: { entityId: order.id, action: { in: ['REPLENISHMENT_ORDER_APPROVED', 'REPLENISHMENT_ORDER_REJECTED'] } } }), 1)
      evidence.cases.push({ case: 'concurrent-approve-reject', round, statuses: competing.map(x => x.status), finalState: current.status, version: current.version, auditCount: 1 })
    }

    const authOrder = await submit(tag + '-authorization')
    for (const role of ['staff', 'partnerA', 'partnerB']) {
      for (const action of ['review-preview', 'approve', 'reject']) {
        const denied = await post(authOrder, action, action === 'reject' ? rejection(authOrder) : approval(authOrder), `${tag}-denied-${role}-${action}`, cookies[role])
        assert([401, 403].includes(denied.status))
        evidence.cases.push({ case: 'authorization', role, action, status: denied.status, validVersionDoesNotGrantAccess: true })
      }
    }
    assert.equal((await request(`/api/partner/replenishment-orders/${authOrder.id}`, { cookie: cookies.partnerB })).status, 404)
    const external = await request(`/api/partner/replenishment-orders/${authOrder.id}`, { cookie: cookies.partnerA })
    assert.equal(external.status, 200)
    assert.equal(Object.hasOwn(external.body.order, 'version'), false, 'only internal review DTO gains the version')
    assert.equal((await request(`${base}/${authOrder.id}`)).body.order.version, 1)
    assert.deepEqual({ balances: await db.stockBalance.count(), ledger: await db.stockLedger.count() }, inventoryBefore)
    console.log(JSON.stringify(evidence))
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await db.$disconnect()
  await appDb.$disconnect()
  await dropDisposablePgDatabase(databaseUrl)
  fs.rmSync(dataDir, { recursive: true, force: true })
}
