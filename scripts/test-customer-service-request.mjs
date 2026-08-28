import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const SCHEMA = `customer_request_${process.pid}`
const TEST_URL = (() => {
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', SCHEMA)
  return url.toString()
})()

process.env.DATABASE_URL = TEST_URL
process.env.PUBLIC_BASE_URL = 'https://budu.example'
delete process.env.WXWORK_CORP_ID
delete process.env.WXWORK_AGENT_ID
delete process.env.WXWORK_SECRET
delete process.env.MP_APP_ID
delete process.env.MP_APP_SECRET
delete process.env.MP_TEMPLATE_ID

const DEV = {
  id: 'dev-csr', username: 'dev-csr', role: 'developer', status: 'active', storeKeys: [], permissions: {}, assetCenter: false,
}

test('Customer Self-Service Request：token、并发事务、业务记录与通知完整链路', async (t) => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await admin.$queryRaw`SELECT 1`
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`)
  } finally {
    await admin.$disconnect()
  }
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'pipe',
    timeout: 180000,
  })

  const { prisma } = await import('../server/pg.js')
  const {
    cancelCustomerServiceRequest,
    createCustomerServiceRequest,
    publicCustomerRequestRouter,
    resetPublicCustomerRequestRateLimitsForTest,
    resolvePublicCustomerRequest,
    submitCustomerServiceRequest,
  } = await import('../server/customer-requests.js')
  const {
    CUSTOMER_REQUEST_TTL_MS,
    createCustomerToken,
    createFixedWindowLimiter,
    hashCustomerToken,
    redactCustomerRequestUrl,
    validateInvoiceSubmission,
  } = await import('../server/customer-request-core.js')

  const extractToken = (publicUrl) => new URLSearchParams(new URL(publicUrl).hash.slice(1)).get('token')

  await prisma.store.create({ data: { key: 'xidan', name: '测试门店' } })
  await prisma.user.createMany({ data: [
    { ...DEV, passwordHash: 'test' },
    { id: 'finance-csr', username: 'finance-csr', passwordHash: 'test', role: 'finance', status: 'active', storeKeys: [], permissions: {} },
    { id: 'staff-csr', username: 'staff-csr', passwordHash: 'test', role: 'staff', status: 'active', storeKeys: ['xidan'], permissions: {} },
  ] })

  await t.test('Public API 无登录可访问自己的 token，固定路径不暴露 token，且 POST 严格 JSON', async () => {
    const generated = await createCustomerServiceRequest({ prismaClient: prisma, user: DEV, input: { type: 'INVOICE', storeKey: 'xidan', amountCents: 1000, category: '商品' } })
    const token = extractToken(generated.publicUrl)
    resetPublicCustomerRequestRateLimitsForTest()
    const express = (await import('express')).default
    const app = express()
    app.use(express.json())
    app.use(publicCustomerRequestRouter)
    const server = app.listen(0)
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      const get = await fetch(`${base}/customer-request`, { headers: { 'X-Customer-Request-Token': token } })
      assert.equal(get.status, 200)
      const body = await get.json()
      assert.equal(body.request.type, 'INVOICE')
      assert.equal('id' in body.request, false)
      assert.equal(get.url.includes(token), false)
      const unsupported = await fetch(`${base}/customer-request/submit`, {
        method: 'POST', headers: { 'X-Customer-Request-Token': token, 'Content-Type': 'text/plain' }, body: '{}',
      })
      assert.equal(unsupported.status, 415)
    } finally {
      server.close()
    }
  })

  await t.test('高熵 token 只以 hash 入库，URL fragment 不进入请求路径', async () => {
    const token = createCustomerToken()
    assert.equal(token.length >= 40, true)
    assert.match(hashCustomerToken(token), /^[a-f0-9]{64}$/)
    assert.equal(redactCustomerRequestUrl(`/api/public/customer-request?token=${token}`), '/api/public/customer-request?token=[redacted]')
  })

  let mailing
  let mailingToken
  await t.test('生成 Mailing QR：2 小时有效、明文 token 不落库', async () => {
    const now = new Date('2026-08-28T06:00:00.000Z')
    mailing = await createCustomerServiceRequest({
      prismaClient: prisma,
      user: DEV,
      now,
      input: { type: 'MAILING', storeKey: 'xidan', method: '顺丰邮寄', postage: '包邮', fee: '' },
    })
    mailingToken = extractToken(mailing.publicUrl)
    assert.equal(new URL(mailing.publicUrl).pathname, '/customer-request')
    assert.ok(new URL(mailing.publicUrl).hash.startsWith('#token='))
    assert.equal(new Date(mailing.request.expiresAt).getTime() - now.getTime(), CUSTOMER_REQUEST_TTL_MS)
    const stored = await prisma.customerServiceRequestToken.findFirst({ where: { requestId: mailing.request.id } })
    assert.equal(stored.tokenHash, hashCustomerToken(mailingToken))
    assert.equal(JSON.stringify(stored).includes(mailingToken), false)
    const publicView = await resolvePublicCustomerRequest({ prismaClient: prisma, token: mailingToken, now })
    assert.deepEqual(Object.keys(publicView).sort(), ['expiresAt', 'status', 'type'])
  })

  await t.test('并发双提交：仅一个 Mailing、一个 Notification、一个 SUBMITTED', async () => {
    const submitNow = new Date('2026-08-28T06:30:00.000Z')
    const payload = {
      recipient: '测试顾客',
      phone: '13800138000',
      address: '北京市朝阳区测试路1号2单元301',
      mailingContent: '测试礼盒1份',
      note: '下午送达',
      confirmedAccurate: true,
      companyWebsite: '',
    }
    const results = await Promise.allSettled([
      submitCustomerServiceRequest({ prismaClient: prisma, token: mailingToken, payload, now: submitNow }),
      submitCustomerServiceRequest({ prismaClient: prisma, token: mailingToken, payload, now: submitNow }),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected.reason.status, 409)
    assert.equal(await prisma.mailingRecord.count(), 1)
    assert.equal(await prisma.notification.count({ where: { refType: 'mailing' } }), 1)
    const request = await prisma.customerServiceRequest.findUnique({ where: { id: mailing.request.id } })
    assert.equal(request.status, 'SUBMITTED')
    assert.ok(request.linkedBusinessRecordId)
    const tokenRow = await prisma.customerServiceRequestToken.findFirst({ where: { requestId: request.id } })
    assert.equal(tokenRow.status, 'CONSUMED')
    const notification = await prisma.notification.findFirst({ where: { refType: 'mailing' } })
    assert.equal(notification.username, DEV.username)
    assert.equal(notification.title, '新的邮寄信息')
    assert.equal(notification.target, 'store-mailing')
    assert.equal(notification.refId, request.linkedBusinessRecordId)
    let wecomDelivery = null
    for (let attempt = 0; attempt < 50 && !wecomDelivery; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      wecomDelivery = await prisma.notificationDelivery.findFirst({
        where: { notificationId: notification.id, channel: 'wecom' },
      })
    }
    assert.ok(wecomDelivery, 'CustomerRequest 必须触发独立企微投递记录')
    assert.equal(wecomDelivery.status, 'skipped', '企微缺配置不得阻塞正式 Mailing 与站内通知')
  })

  await t.test('重新生成语义：同门店旧 WAITING token 立即失效', async () => {
    const first = await createCustomerServiceRequest({ prismaClient: prisma, user: DEV, input: { type: 'MAILING', storeKey: 'xidan', method: '顺丰邮寄', postage: '包邮', fee: '' } })
    const firstToken = extractToken(first.publicUrl)
    const second = await createCustomerServiceRequest({ prismaClient: prisma, user: DEV, input: { type: 'MAILING', storeKey: 'xidan', method: '同城闪送', postage: '不包邮', fee: '' } })
    await assert.rejects(
      () => resolvePublicCustomerRequest({ prismaClient: prisma, token: firstToken }),
      (error) => error.status === 410,
    )
    const old = await prisma.customerServiceRequest.findUnique({ where: { id: first.request.id } })
    assert.equal(old.status, 'CANCELLED')
    assert.equal((await resolvePublicCustomerRequest({ prismaClient: prisma, token: extractToken(second.publicUrl) })).status, 'WAITING_CUSTOMER')
  })

  await t.test('工作人员取消 WAITING request 后 token 立即失效且不创建业务记录', async () => {
    const created = await createCustomerServiceRequest({ prismaClient: prisma, user: DEV, input: { type: 'MAILING', storeKey: 'xidan', method: '顺丰邮寄', postage: '包邮', fee: '' } })
    const before = await prisma.mailingRecord.count()
    await cancelCustomerServiceRequest({ prismaClient: prisma, requestId: created.request.id, user: DEV })
    await assert.rejects(
      () => resolvePublicCustomerRequest({ prismaClient: prisma, token: extractToken(created.publicUrl) }),
      (error) => error.status === 410,
    )
    assert.equal(await prisma.mailingRecord.count(), before)
    assert.equal((await prisma.customerServiceRequest.findUnique({ where: { id: created.request.id } })).status, 'CANCELLED')
  })

  await t.test('过期 token fail closed，不创建业务记录', async () => {
    const createdAt = new Date('2026-08-28T00:00:00.000Z')
    const expiring = await createCustomerServiceRequest({ prismaClient: prisma, user: DEV, now: createdAt, input: { type: 'MAILING', storeKey: 'xidan', method: '顺丰邮寄', postage: '包邮', fee: '' } })
    const before = await prisma.mailingRecord.count()
    await assert.rejects(
      () => resolvePublicCustomerRequest({ prismaClient: prisma, token: extractToken(expiring.publicUrl), now: new Date(createdAt.getTime() + CUSTOMER_REQUEST_TTL_MS + 1) }),
      (error) => error.status === 410,
    )
    assert.equal(await prisma.mailingRecord.count(), before)
    assert.equal((await prisma.customerServiceRequest.findUnique({ where: { id: expiring.request.id } })).status, 'EXPIRED')
  })

  await t.test('Invoice：金额由后台锁定，顾客 payload 无法篡改；通知定向财务', async () => {
    const request = await createCustomerServiceRequest({
      prismaClient: prisma,
      user: DEV,
      input: { type: 'INVOICE', storeKey: 'xidan', amountCents: 12345, category: '商品' },
    })
    const token = extractToken(request.publicUrl)
    const publicView = await resolvePublicCustomerRequest({ prismaClient: prisma, token })
    assert.equal(publicView.invoiceAmountCents, '12345')
    await submitCustomerServiceRequest({
      prismaClient: prisma,
      token,
      payload: {
        titleType: 'ENTERPRISE', invoiceTitle: '测试企业有限公司', taxNo: '91110108MA01TEST2X',
        email: 'invoice@example.test', note: '测试备注', amountCents: 99999999,
        confirmedAccurate: true, companyWebsite: '',
      },
    })
    const invoice = await prisma.invoice.findFirst({ where: { createdBy: DEV.username }, orderBy: { createdAt: 'desc' } })
    assert.equal(invoice.amountCents, 12345n)
    assert.equal(invoice.status, 'pending')
    const notification = await prisma.notification.findFirst({ where: { refType: 'invoice', refId: invoice.id } })
    assert.equal(notification.username, 'finance-csr')
    assert.equal(notification.title, '新的开票申请')
    assert.equal(notification.target, 'finance-invoice')
  })

  await t.test('Invoice 个人抬头不要求税号；企业税号 fail-safe', () => {
    const personal = validateInvoiceSubmission({ titleType: 'PERSONAL', invoiceTitle: '测试个人', email: 'person@example.test', confirmedAccurate: true })
    assert.equal(personal.taxNo, '')
    assert.throws(
      () => validateInvoiceSubmission({ titleType: 'ENTERPRISE', invoiceTitle: '测试企业', taxNo: '含中文', email: 'corp@example.test', confirmedAccurate: true }),
      /纳税人识别号/,
    )
  })

  await t.test('固定窗口限流拒绝超额请求并提供 Retry-After', () => {
    let current = 1000
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 10000, now: () => current })
    assert.equal(limiter.consume('safe').allowed, true)
    assert.equal(limiter.consume('safe').allowed, true)
    const denied = limiter.consume('safe')
    assert.equal(denied.allowed, false)
    assert.equal(denied.retryAfterSeconds, 10)
    current += 10001
    assert.equal(limiter.consume('safe').allowed, true)
  })

  await new Promise((resolve) => setTimeout(resolve, 80))
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await prisma.$disconnect()
})
