// Independent review tests: real isolated PostgreSQL, synthetic identities only.
// Never invokes an external delivery or a production connection.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'
import { serviceConversion, serviceReportRange } from '../server/store-service-conversion.js'

const appId = 'wx0123456789abcdef'
const envId = 'synthetic-offline-review'
const uid = () => crypto.randomUUID()
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const DEV = { id: 'review-developer', username: 'review-developer', role: 'developer', status: 'active', storeKeys: [], permissions: {} }
const mailing = { recipient: '合成测试收件人', phone: '13800000000', address: '合成测试地址测试路一号', mailingContent: '测试资料', note: '', confirmedAccurate: true }
const invoice = { titleType: 'ENTERPRISE', invoiceTitle: '合成测试企业', taxNo: 'TEST123456789', email: 'synthetic@example.invalid', note: '', confirmedAccurate: true }

test('independent offline-service review: isolated database invariants', async t => {
  const dbUrl = await createDisposablePgDatabase('offline_review')
  process.env.DATABASE_URL = dbUrl
  process.env.PUBLIC_BASE_URL = 'https://synthetic.example.invalid'
  process.env.NODE_ENV = 'test'
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  globalThis.__buduPrisma = db
  const { createCustomerServiceRequest, submitCustomerServiceRequest, resolvePublicCustomerRequest } = await import('../server/customer-requests.js')
  const { confirmService, serviceDetail, listCustomerServices, resolveServiceScene } = await import('../server/store-service-core.js')
  const { deliverStoreServiceOnce } = await import('../server/store-service-notifications.js')
  const a = { userId: 'review-customer-a', appId, envId, openId: 'synthetic-openid-a' }
  const b = { userId: 'review-customer-b', appId, envId, openId: 'synthetic-openid-b' }
  await db.user.createMany({ data: [
    { ...DEV, passwordHash: 'synthetic-not-a-login' },
    ...[a, b].map(identity => ({ id: identity.userId, username: identity.userId, role: 'customer', passwordHash: 'synthetic-not-a-login' })),
  ] })
  await db.weChatAuthIdentity.createMany({ data: [a, b].map(identity => ({ id: uid(), provider: 'WECHAT_MINIPROGRAM', appId, openId: identity.openId, userId: identity.userId })) })

  async function fixture(type = 'MAILING') {
    const storeKey = `review-${crypto.randomBytes(8).toString('hex')}`
    await db.store.create({ data: { key: storeKey, name: storeKey, active: true } })
    const created = await createCustomerServiceRequest({ prismaClient: db, user: DEV, origin: 'https://synthetic.example.invalid', input: {
      type, storeKey, ...(type === 'MAILING' ? { method: '顺丰邮寄', postage: '包邮', shippingTier: 'STANDARD' } : { amountCents: 1200, category: '食品' }),
    } })
    const token = new URLSearchParams(new URL(created.publicUrl).hash.slice(1)).get('token')
    const scene = crypto.randomBytes(16).toString('hex')
    await db.customerServiceRequestToken.update({ where: { tokenHash: hash(token) }, data: { miniSceneHash: hash(scene) } })
    const requestId = created.request.id
    const payload = type === 'MAILING' ? mailing : invoice
    return { requestId, scene, token, type, payload,
      mini: (identity = a, overrides = {}) => submitCustomerServiceRequest({ prismaClient: db, miniScene: scene, customerIdentity: identity, payload, deliverInternal: false, ...overrides }),
      h5: (overrides = {}) => submitCustomerServiceRequest({ prismaClient: db, token, payload, deliverInternal: false, ...overrides }),
      row: () => db.customerServiceRequest.findUnique({ where: { id: requestId }, include: { tokens: true } }),
    }
  }
  const counts = async () => ({
    mailing: await db.mailingRecord.count(), invoice: await db.invoice.count(),
    notifications: await db.notification.count(), deliveries: await db.notificationDelivery.count(), companies: await db.invoiceCompany.count(),
  })

  try {
    await t.test('opening or refreshing the original code never consumes or assigns it', async () => {
      const f = await fixture()
      await resolvePublicCustomerRequest({ prismaClient: db, token: f.token })
      await resolvePublicCustomerRequest({ prismaClient: db, token: f.token })
      const row = await f.row()
      assert.equal(row.status, 'WAITING_CUSTOMER')
      assert.equal(row.customerUserId, null)
      assert.equal(row.tokens[0].status, 'ACTIVE')
      assert.equal(row.tokens[0].consumedAt, null)
      const metadata = { ...row.requestMetadata, paymentConfirmedBy: 'internal-person-identifier' }
      await db.customerServiceRequest.update({ where: { id: f.requestId }, data: { requestMetadata: metadata } })
      const miniPreview = await resolveServiceScene(db, f.scene, a)
      assert.equal('paymentConfirmedBy' in miniPreview.request.requestMetadata, false)
      assert.equal('receiptConfirmedBy' in miniPreview.request, false)
      assert.equal((await f.row()).tokens[0].status, 'ACTIVE')
    })

    await t.test('two distinct customers racing one code create exactly one business record and one owner', async () => {
      const f = await fixture(), before = await counts()
      const outcomes = await Promise.allSettled([f.mini(a), f.mini(b)])
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
      assert.equal(outcomes.find(value => value.status === 'rejected').reason.status, 409)
      const row = await f.row(), after = await counts()
      const winner = outcomes[0].status === 'fulfilled' ? a : b
      const loser = winner === a ? b : a
      assert.equal(row.customerUserId, winner.userId)
      assert.equal(row.customerOpenId, winner.openId)
      assert.equal(row.tokens[0].status, 'CONSUMED')
      assert.equal(after.mailing - before.mailing, 1)
      assert.equal(after.notifications - before.notifications, 1)
      assert.equal(after.deliveries - before.deliveries, 1)
      assert.equal((await f.mini(winner)).requestId, f.requestId)
      await assert.rejects(f.mini(loser), { status: 409 })
      assert.deepEqual(await counts(), after)
    })

    await t.test('same-person parallel submit and lost response retries return the original receipt', async () => {
      const f = await fixture('INVOICE'), before = await counts()
      const receipts = await Promise.all([f.mini(a), f.mini(a), f.mini(a)])
      assert.ok(receipts.every(receipt => receipt.requestId === f.requestId && receipt.status === 'SUBMITTED'))
      const after = await counts(), row = await f.row()
      assert.equal(after.invoice - before.invoice, 1)
      assert.equal(after.notifications - before.notifications, 1)
      // The first response is intentionally discarded: caller repeats its original operation.
      assert.equal((await f.mini(a)).requestId, f.requestId)
      assert.equal((await f.row()).linkedBusinessRecordId, row.linkedBusinessRecordId)
      assert.deepEqual(await counts(), after)
      assert.equal((await db.invoice.findUnique({ where: { id: row.linkedBusinessRecordId } })).status, 'pending')
      assert.equal(row.receiptConfirmedAt, null)
    })

    await t.test('H5 and MiniProgram share one transactional consumption boundary', async () => {
      const f = await fixture(), before = await counts()
      const outcomes = await Promise.allSettled([f.h5(), f.mini(a)])
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
      assert.equal(outcomes.find(value => value.status === 'rejected').reason.status, 409)
      const row = await f.row(), after = await counts()
      assert.equal(after.mailing - before.mailing, 1)
      assert.equal(after.notifications - before.notifications, 1)
      assert.equal(row.customerUserId, outcomes[0].status === 'fulfilled' ? null : a.userId)
    })

    await t.test('invalid customer data leaves code available; a later valid submit succeeds', async () => {
      const f = await fixture(), before = await counts()
      await assert.rejects(f.mini(a, { payload: { ...mailing, phone: 'invalid' } }), { status: 400 })
      const row = await f.row()
      assert.equal(row.status, 'WAITING_CUSTOMER')
      assert.equal(row.customerUserId, null)
      assert.equal(row.linkedBusinessRecordId, null)
      assert.equal(row.tokens[0].status, 'ACTIVE')
      assert.equal(row.tokens[0].consumedAt, null)
      assert.deepEqual(await counts(), before)
      assert.equal((await f.mini(a)).requestId, f.requestId)
    })

    await t.test('failure after claims and business insert rolls the entire transaction back', async () => {
      const f = await fixture('INVOICE'), before = await counts()
      await db.user.update({ where: { id: DEV.id }, data: { status: 'disabled' } })
      try {
        await assert.rejects(f.mini(a), { status: 503 })
        const row = await f.row()
        assert.equal(row.status, 'WAITING_CUSTOMER')
        assert.equal(row.tokens[0].status, 'ACTIVE')
        assert.equal(row.customerUserId, null)
        assert.equal(row.linkedBusinessRecordId, null)
        assert.deepEqual(await counts(), before)
      } finally {
        await db.user.update({ where: { id: DEV.id }, data: { status: 'active' } })
      }
      assert.equal((await f.mini(a)).requestId, f.requestId)
    })

    await t.test('equal recipient phones do not confer ownership or cross-application replay', async () => {
      const first = await fixture(), second = await fixture()
      await first.mini(a)
      await second.mini(b)
      assert.equal((await first.row()).customerUserId, a.userId)
      assert.equal((await second.row()).customerUserId, b.userId)
      await assert.rejects(first.mini(b), { status: 409 })
      await assert.rejects(first.mini({ ...a, appId: 'wx0000000000000000' }), { status: 409 })
      await assert.rejects(first.mini({ ...a, envId: 'different-environment' }), { status: 409 })
    })

    await t.test('old H5 submission remains unbound and cannot later be claimed using the same phone', async () => {
      const f = await fixture(), receipt = await f.h5(), row = await f.row()
      assert.equal(receipt.status, 'SUBMITTED')
      assert.equal('requestId' in receipt, false)
      assert.equal(row.customerUserId, null)
      assert.equal(row.customerAppId, null)
      assert.equal(row.customerOpenId, null)
      await assert.rejects(f.mini(a), { status: 409 })
      const publicReceipt = await resolvePublicCustomerRequest({ prismaClient: db, token: f.token })
      assert.equal(publicReceipt.status, 'SUBMITTED')
      assert.equal('phone' in publicReceipt, false)
      assert.equal('address' in publicReceipt, false)
      assert.equal('linkedBusinessRecordId' in publicReceipt, false)
    })

    await t.test('declined or unavailable subscription never blocks lawful submission', async () => {
      for (const status of ['reject', 'cancel', 'unavailable']) {
        const f = await fixture()
        const receipt = await f.mini(a, { subscription: { status } })
        assert.equal(receipt.requestId, f.requestId)
        assert.equal((await f.row()).customerUserId, a.userId)
      }
    })

    await t.test('expired unused codes fail without creating any service fact', async () => {
      const f = await fixture(), before = await counts()
      await db.customerServiceRequestToken.update({ where: { tokenHash: hash(f.token) }, data: { expiresAt: new Date(Date.now() - 1000) } })
      await assert.rejects(f.mini(a), { status: 410 })
      assert.equal((await f.row()).customerUserId, null)
      assert.deepEqual(await counts(), before)
    })

    await t.test('successful owner can recover the original receipt after code expiry', async () => {
      const f = await fixture()
      await f.mini(a)
      const expired = new Date(Date.now() - 1000)
      await db.customerServiceRequestToken.update({ where: { tokenHash: hash(f.token) }, data: { expiresAt: expired } })
      await db.customerServiceRequest.update({ where: { id: f.requestId }, data: { expiresAt: expired } })
      assert.equal((await f.mini(a)).requestId, f.requestId)
      await assert.rejects(f.mini(b), { status: 409 })
    })

    await t.test('customer detail and pagination deny another owner and another identity scope', async () => {
      const f = await fixture()
      await f.mini(a)
      assert.equal((await serviceDetail(db, f.requestId, a)).request.id, f.requestId)
      await assert.rejects(serviceDetail(db, f.requestId, b), { status: 404 })
      await assert.rejects(serviceDetail(db, f.requestId, { ...a, envId: 'different' }), { status: 404 })
      const list = await listCustomerServices(db, b)
      assert.ok(list.rows.every(row => row.id !== f.requestId))
      await assert.rejects(listCustomerServices(db, b, { cursor: f.requestId }), { status: 400 })
    })

    await t.test('only developer confirms reception, without changing a later issued invoice', async () => {
      const f = await fixture('INVOICE')
      await f.mini(a)
      const row = await f.row()
      await db.invoice.update({ where: { id: row.linkedBusinessRecordId }, data: { status: 'done' } })
      for (const role of ['admin', 'finance', 'manager', 'staff', 'customer']) {
        await assert.rejects(confirmService(db, { requestId: f.requestId, user: { ...DEV, role }, action: 'receipt' }), { status: 403 })
      }
      const results = await Promise.all([1, 2].map(() => confirmService(db, { requestId: f.requestId, user: DEV, action: 'receipt' })))
      assert.equal(results.filter(value => !value.alreadyConfirmed).length, 1)
      assert.equal((await db.invoice.findUnique({ where: { id: row.linkedBusinessRecordId } })).status, 'done')
      assert.ok((await f.row()).receiptConfirmedAt)
      assert.equal(await db.storeServiceDelivery.count({ where: { requestId: f.requestId, event: 'INVOICE_RECEIVED' } }), 1)
      assert.equal(await db.storeServiceAudit.count({ where: { requestId: f.requestId, action: 'receipt' } }), 1)
      const rows = (await listCustomerServices(db, a, { type: 'INVOICE' })).rows
      assert.equal(rows.find(value => value.id === f.requestId).invoiceStatus, 'done')
      const recovery = await resolveServiceScene(db, f.scene, a)
      assert.equal('receiptConfirmedBy' in recovery.request, false)
      assert.equal('requestMetadata' in recovery.request, false)
    })

    await t.test('shipment needs real customer lookup data; correction updates detail but creates no extra message', async () => {
      const f = await fixture()
      await f.mini(a)
      await assert.rejects(confirmService(db, { requestId: f.requestId, user: DEV, action: 'shipment', input: { carrier: '测试快递' } }), { status: 400 })
      assert.equal((await f.row()).shipmentConfirmedAt, null)
      await confirmService(db, { requestId: f.requestId, user: DEV, action: 'shipment', input: { carrier: '测试快递', trackingNo: 'SYNTHETIC123' } })
      await confirmService(db, { requestId: f.requestId, user: DEV, action: 'shipment', input: { carrier: '测试快递', trackingNo: 'SYNTHETIC123' } })
      await assert.rejects(confirmService(db, { requestId: f.requestId, user: DEV, action: 'correct-shipment', input: { carrier: '测试快递', trackingNo: 'SYNTHETIC456' } }), { status: 400 })
      await confirmService(db, { requestId: f.requestId, user: DEV, action: 'correct-shipment', input: { carrier: '测试快递', trackingNo: 'SYNTHETIC456', reason: '合成测试更正' } })
      const detail = await serviceDetail(db, f.requestId, a)
      assert.equal(detail.mailing.trackingNo, 'SYNTHETIC456')
      assert.equal(detail.mailing.logisticsStatus, 'NOT_CONNECTED')
      assert.equal(await db.storeServiceDelivery.count({ where: { requestId: f.requestId } }), 1)
      assert.equal(await db.storeServiceAudit.count({ where: { requestId: f.requestId } }), 2)
    })

    await t.test('outbox persistence failure rolls back the business confirmation', async () => {
      const f = await fixture()
      await f.mini(a)
      // A malformed preexisting recipient demonstrates a real DB write failure,
      // rather than replacing the transaction with a mock.
      await db.customerServiceRequest.update({ where: { id: f.requestId }, data: { customerOpenId: null } })
      await assert.rejects(confirmService(db, { requestId: f.requestId, user: DEV, action: 'shipment', input: { carrier: '测试快递', trackingNo: 'SYNTHETIC789' } }))
      const row = await f.row()
      assert.equal(row.shipmentConfirmedAt, null)
      assert.equal((await db.mailingRecord.findUnique({ where: { id: row.linkedBusinessRecordId } })).status, 'pending')
      assert.equal(await db.storeServiceDelivery.count({ where: { requestId: f.requestId } }), 0)
      assert.equal(await db.storeServiceAudit.count({ where: { requestId: f.requestId } }), 0)
    })

    const templates = { MAILING: { id: 'synthetic-review-template', semantic: 'SHIPMENT_CONFIRMED', fields: { thing1: 'status' } } }
    async function pendingNotification() {
      const f = await fixture()
      await f.mini(a, { subscription: { status: 'accept', templateId: templates.MAILING.id } })
      await confirmService(db, { requestId: f.requestId, user: DEV, action: 'shipment', templates, input: { carrier: '测试快递', trackingNo: 'SYNTHETIC123' } })
      return { ...f, delivery: () => db.storeServiceDelivery.findFirst({ where: { requestId: f.requestId } }) }
    }
    await t.test('two workers claim a persisted event once; platform acceptance is not customer read', async () => {
      const f = await pendingNotification()
      let sends = 0
      const send = async () => { sends++; return { status: 'ACCEPTED', code: '0' } }
      await Promise.all([deliverStoreServiceOnce(db, send), deliverStoreServiceOnce(db, send)])
      assert.equal(sends, 1)
      assert.equal((await f.delivery()).status, 'ACCEPTED')
      await deliverStoreServiceOnce(db, send)
      assert.equal(sends, 1)
    })

    await t.test('ambiguous platform outcome is durable UNKNOWN and never blindly resent', async () => {
      const f = await pendingNotification()
      let sends = 0
      const send = async () => { sends++; throw new Error('synthetic transport timeout') }
      await deliverStoreServiceOnce(db, send)
      assert.equal((await f.delivery()).status, 'UNKNOWN')
      await deliverStoreServiceOnce(db, send, { now: new Date(Date.now() + 3600000) })
      assert.equal(sends, 1)
      assert.ok((await f.row()).shipmentConfirmedAt)
    })

    await t.test('a crashed claimed event recovers to UNKNOWN without an external call', async () => {
      const f = await pendingNotification(), delivery = await f.delivery()
      await db.storeServiceDelivery.update({ where: { id: delivery.id }, data: { status: 'SENDING', claimedAt: new Date(Date.now() - 120000), claimId: uid(), attempts: 1 } })
      let sends = 0
      await deliverStoreServiceOnce(db, async () => { sends++; return { status: 'ACCEPTED', code: '0' } })
      assert.equal(sends, 0)
      assert.equal((await f.delivery()).status, 'UNKNOWN')
    })

    await t.test('only definite pre-send failures retry, with a persisted finite attempt budget', async () => {
      const f = await pendingNotification(), start = new Date()
      let sends = 0
      const send = async () => { sends++; return { status: 'PENDING', code: 'TOKEN_UNAVAILABLE' } }
      for (let step = 0; step < 5; step++) await deliverStoreServiceOnce(db, send, { now: new Date(+start + step * 3600000), maxAttempts: 3 })
      assert.equal(sends, 3)
      assert.equal((await f.delivery()).status, 'FAILED')
      assert.equal((await f.delivery()).attempts, 3)
      assert.ok((await f.row()).shipmentConfirmedAt)
    })

    await t.test('HTTP identity boundary rejects spoofing, mismatched principals, wrong scopes and replay', async () => {
      const express = (await import('express')).default
      const { createStoreServiceCustomerRouter } = await import('../server/store-service-api.js')
      const { createCustomerSession } = await import('../server/customer-auth.js')
      const { signProductionGatewayRequest, gatewayBodyHash } = await import('../server/production-cloudbase-gateway.js')
      const config = { enabled: true, mode: 'production', appId, cloudBaseEnvId: envId, markerKey: 'synthetic-review-marker-key-only', gatewaySecret: 'synthetic-review-gateway-key-only-1234567890' }
      const sessionA = await createCustomerSession({ userId: a.userId, markerKey: config.markerKey, db })
      const sessionB = await createCustomerSession({ userId: b.userId, markerKey: config.markerKey, db })
      const env = { STORE_SERVICE_SUBMISSIONS_ENABLED: '1' }
      const app = express(), prefix = '/api/v2/customer/store-services'
      app.use(prefix, express.json(), createStoreServiceCustomerRouter({ db, config, env, deliverInternal: false }))
      const server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const base = `http://127.0.0.1:${server.address().port}`
      function signed(pathname, payload, session = sessionA, identity = a) {
        const body = { sessionHash: hash(session.rawToken), openId: identity.openId, ...payload }
        const timestamp = String(Date.now()), nonce = crypto.randomBytes(18).toString('base64url')
        const signature = signProductionGatewayRequest({ timestamp, nonce, method: 'POST', requestPath: prefix + pathname,
          bodyHash: gatewayBodyHash(body), environment: envId, appId }, config.gatewaySecret)
        return { body, headers: { 'content-type': 'application/json', authorization: `Bearer ${session.rawToken}`,
          'x-budu-gateway-timestamp': timestamp, 'x-budu-gateway-nonce': nonce, 'x-budu-gateway-environment': envId,
          'x-budu-gateway-appid': appId, 'x-budu-gateway-signature': signature } }
      }
      const post = (pathname, input) => fetch(base + prefix + pathname, { method: 'POST', headers: input.headers, body: JSON.stringify(input.body) })
      try {
        const f = await fixture()
        const unauthenticated = await post('/submit', { headers: { 'content-type': 'application/json' }, body: { scene: f.scene, payload: f.payload, userId: a.userId, openId: a.openId } })
        assert.equal(unauthenticated.status, 401)
        assert.equal((await post('/list', signed('/list', {}, sessionA, b))).status, 403)
        assert.equal((await post('/list', signed('/list', { sessionHash: hash('different-token') }))).status, 401)
        const wrongScope = signed('/list', {})
        wrongScope.headers['x-budu-gateway-environment'] = 'other-environment'
        assert.equal((await post('/list', wrongScope)).status, 403)
        const replay = signed('/list', {})
        assert.equal((await post('/list', replay)).status, 200)
        assert.equal((await post('/list', replay)).status, 409)
        const legitimate = await post('/submit', signed('/submit', { scene: f.scene, payload: { ...f.payload, storeKey: 'forged-store' }, customerIdentity: b, userId: b.userId, role: 'developer' }))
        assert.equal(legitimate.status, 200)
        assert.equal((await f.row()).customerUserId, a.userId)
        assert.notEqual((await f.row()).storeKey, 'forged-store')
        assert.equal((await post('/detail', signed('/detail', { requestId: f.requestId }, sessionB, b))).status, 404)
        env.STORE_SERVICE_SUBMISSIONS_ENABLED = '0'
        assert.equal((await post('/detail', signed('/detail', { requestId: f.requestId }))).status, 200)
        const recovered = await post('/submit', signed('/submit', { scene: f.scene, payload: f.payload }))
        assert.equal(recovered.status, 200)
        assert.equal((await recovered.json()).result.requestId, f.requestId)
        const fresh = await fixture()
        const admission = await post('/submit', signed('/submit', { scene: fresh.scene, payload: fresh.payload }))
        assert.equal(admission.status, 503)
        assert.equal((await admission.json()).error, 'SERVICE_DISABLED')
        assert.equal((await fresh.row()).status, 'WAITING_CUSTOMER')
      } finally {
        await new Promise(resolve => server.close(resolve))
      }
    })
  } finally {
    await db.$disconnect()
    delete globalThis.__buduPrisma
    await dropDisposablePgDatabase(dbUrl)
  }
})

test('independent conversion examples: provider time, global attribution, deduplication and cumulative boundaries', () => {
  const day = 86400000, start = new Date('2026-10-01T00:00:00+08:00')
  const at = offset => new Date(+start + offset)
  const request = (id, userId, storeKey, offset = 0) => ({ id, customerUserId: userId, storeKey, type: 'MAILING', status: 'SUBMITTED', submittedAt: at(offset) })
  const payment = (id, userId, offset, totalCents) => ({ id, userId, status: 'PAID', paidAt: at(offset), totalCents: String(totalCents), wechatCents: '0', tenders: [], refunds: [] })
  const requests = [request('a', 'one', 'first'), request('b', 'one', 'second', day), request('c', 'two', 'first'), request('d', 'three', 'first'), request('e', 'four', 'first')]
  const purchased = { ...payment('purchase-one', 'one', 2 * day, 1000), refunds: [{ id: 'refund-one', status: 'SETTLED', totalCents: '100', settledAt: at(3 * day) },
    { id: 'pending-refund', status: 'PENDING', totalCents: '300', settledAt: null }] }
  const payments = [payment('older', 'one', -day, 500), purchased, { ...purchased }, payment('seven-exact', 'two', 7 * day, 100),
    payment('seven-plus-one-ms', 'two', 7 * day + 1, 200), payment('simultaneous-not-after', 'two', 0, 900),
    { ...payment('late-notify', 'three', day, 700), wechatCents: '700', tenders: [{ type: 'WECHAT', status: 'SUCCEEDED', providerSuccessAt: at(-3600000) }] },
    { ...payment('missing-provider-time', 'four', day, 900), wechatCents: '900', tenders: [{ type: 'WECHAT', status: 'SUCCEEDED' }] }]
  const range = { start, end: at(2 * day), storeKey: '', type: '' }, now = at(40 * day)
  const report = serviceConversion({ requests, payments, visits: [], range, now })
  assert.deepEqual(report.windows.map(w => [w.days, w.orders, w.paidCents, w.refundCents]), [[7, 2, '1100', '100'], [30, 3, '1300', '100']])
  assert.equal(report.windows[0].returningCustomers, 1)
  assert.equal(report.windows[0].unknownHistoryCustomers, 1)
  const first = serviceConversion({ requests, payments, visits: [], range: { ...range, storeKey: 'first' }, now })
  assert.deepEqual(first.windows.map(w => [w.orders, w.paidCents]), [[1, '100'], [2, '300']])
  const second = serviceConversion({ requests, payments, visits: [], range: { ...range, storeKey: 'second' }, now })
  assert.deepEqual(second.windows.map(w => [w.orders, w.paidCents]), [[1, '1000'], [1, '1000']])
  const immature = serviceConversion({ requests, payments, visits: [], range, now: at(8 * day) })
  assert.equal(immature.windows[0].immatureApplications, 0)
  assert.equal(immature.windows[1].immatureApplications, 5)
  const tied = serviceConversion({ requests: [request('a', 'one', 'first'), request('z', 'one', 'second')], payments: [purchased], visits: [],
    range: { ...range, storeKey: 'first' }, now })
  assert.equal(tied.windows[0].orders, 0)
  const beijing = serviceReportRange({ from: '2026-10-01', to: '2026-10-01' }, now)
  assert.equal(beijing.start.toISOString(), '2026-09-30T16:00:00.000Z')
  assert.equal(beijing.end.toISOString(), '2026-10-01T16:00:00.000Z')
  assert.throws(() => serviceReportRange({ from: '2026-02-30', to: '2026-03-02' }, now), { status: 400 })
  assert.throws(() => serviceReportRange({ from: ['2026-10-01'], to: '2026-10-01' }, now), { status: 400 })
  assert.equal(serviceReportRange({ from: '2028-02-29', to: '2028-02-29' }, now).end.toISOString(), '2028-02-29T16:00:00.000Z')
})
