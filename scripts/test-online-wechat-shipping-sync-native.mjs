/**
 * Gate B —— 真实 PostgreSQL × 真实 Prisma Client 集成验证。
 *
 * 为什么必须有这一层：上一轮的 `verify_attempts` bug（把 `'verify_attempts + 1'` 当绑定
 * 参数塞进 INTEGER 列）在 fake Prisma 下完全看不出来。这里让 `$executeRaw` / `$queryRaw`
 * 真正打到 PostgreSQL，因此那种错误会当场炸。
 *
 * 安全边界（硬拒生产）：
 *   - 只接受 BUDU_SHIPPING_NATIVE_URL 指向 127.0.0.1 / localhost；
 *   - 库名必须以 `budu_shipping_native` / `budu_sc11b_` 开头；
 *   - 任一不满足直接抛错退出，绝不用生产库替代。
 *
 * 微信 HTTP 边界用注入的 fetchImpl（外部系统）；数据库层**不 mock**。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import test, { after } from 'node:test'
import { PrismaClient } from '@prisma/client'
import { createWechatShippingInfo } from '../server/wechat-shipping-info.js'
import { createOnlineWechatShippingSync } from '../server/online-wechat-shipping-sync.js'
import { createOnlineMerchantRouter } from '../server/online-merchant-api.js'
import { signProductionGatewayRequest, gatewayBodyHash } from '../server/production-cloudbase-gateway.js'

const RAW_URL = process.env.BUDU_SHIPPING_NATIVE_URL
if (!RAW_URL) throw Error('ISOLATED_NATIVE_URL_REQUIRED')
const parsed = new URL(RAW_URL)
const hostOk = ['127.0.0.1', 'localhost'].includes(parsed.hostname)
const dbOk = /^budu_(shipping_native|sc11b_)/.test(parsed.pathname.replace(/^\//, ''))
if (!hostOk || !dbOk) throw Error('ISOLATED_NATIVE_DB_REQUIRED')

const APP_ID = 'wxfce0a3c4bb430023'
const CONFIG = { appId: APP_ID, appSecret: 'S'.repeat(32), mode: 'PRODUCTION' }
const MERCHANT_PATH = '/api/v2/merchant/online-checkout/fulfill'
const GATEWAY = { enabled: true, mode: 'production', appId: APP_ID,
  cloudBaseEnvId: 'budu-d6gz358ixe39faf43', gatewaySecret: 'g'.repeat(48) }

const prisma = new PrismaClient({ datasourceUrl: RAW_URL })
after(() => prisma.$disconnect())

const uuid = () => crypto.randomUUID()
let seq = 0
const TAG = `${Date.now()}${process.pid}`.slice(-9)

/** 顺序编号，避免与其它测试/历史数据撞唯一键。 */
function nextSeq() { seq += 1; return seq }

/** 数据库要求真实 sha256 十六进制（`^[0-9a-f]{64}$`），不许伪造短串。 */
const fp = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex')

// ---------------------------------------------------------------------------
// 微信 HTTP 边界（外部系统 → 可注入）
// ---------------------------------------------------------------------------
function wechatStub() {
  const calls = { token: 0, upload: [], verify: 0 }
  let uploadResults = [], verifyResults = []
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    const ok = payload => Promise.resolve({ ok: true, status: 200, json: async () => payload })
    if (url.includes('/cgi-bin/stable_token')) {
      calls.token += 1
      return ok({ errcode: 0, access_token: 'TOK-native', expires_in: 7200 })
    }
    if (url.includes('/wxa/sec/order/upload_shipping_info')) {
      calls.upload.push(body)
      const next = uploadResults.shift()
      return ok(next || { errcode: 0, errmsg: 'ok' })
    }
    if (url.includes('/wxa/sec/order/get_order')) {
      calls.verify += 1
      const next = verifyResults.shift()
      return ok(next || { errcode: 0, order: { order_state: 1 } })
    }
    throw new Error('UNEXPECTED_URL ' + url)
  }
  return {
    calls, impl,
    queueUpload: (...r) => { uploadResults = r },
    queueVerify: (...r) => { verifyResults = r },
  }
}

function serviceFor(stub) {
  const shipping = createWechatShippingInfo({ config: CONFIG, fetchImpl: stub.impl, now: () => Date.now() })
  return createOnlineWechatShippingSync(prisma, { shipping, appId: APP_ID })
}

// ---------------------------------------------------------------------------
// 夹具（真实行）
// ---------------------------------------------------------------------------
async function fixture({ carrierCode = 'SF', withTrace = true, receiverPhone = '13800000000',
  fulfillment = 'DELIVERY', withAuthorization = true } = {}) {
  const n = nextSeq()
  const userId = `nativ-u-${TAG}-${n}`
  const quoteId = `nativ-q-${TAG}-${n}`
  const settlementId = `os-native-${TAG}-${n}`
  const txn = `4200${TAG}${String(n).padStart(6, '0')}`
  const trackingNo = `SF${TAG}${n}`

  await prisma.user.create({ data: { id: userId, username: `nativ-${TAG}-${n}`, passwordHash: 'synthetic' } })
  await prisma.weChatAuthIdentity.create({ data: {
    id: uuid(), provider: 'WECHAT_MINIPROGRAM', appId: APP_ID, openId: `oNATIV-${TAG}-${n}`, userId,
  } })
  // 结算必须与报价逐项一致（DB 有延迟约束 ONLINE_QUOTE_AMOUNT_MISMATCH /
  // ONLINE_TENDER_RECONCILIATION），快照金额以**字符串**与列对齐。
  // 延迟约束在**提交时**求值，所以报价、结算、tender、授权必须同一个事务提交。
  const AMOUNTS = { currency: 'CNY', merchandiseCents: '10000', eligibleMerchandiseCents: '10000',
    shippingCents: '0', totalCents: '10000', sweetCardCents: '0', wechatCents: '10000' }
  await prisma.$transaction(async tx => {
    await tx.onlineCheckoutQuote.create({ data: {
      id: quoteId, userId, requestKey: `q-${TAG}-${n}`, requestFingerprint: fp('q', TAG, n),
      snapshot: { namespace: 'cloudbase-miniprogram', fulfillment, ...AMOUNTS,
        lines: [{ name: '92%生巧克力', quantity: 1 }] },
      expiresAt: new Date(Date.now() + 86400000),
    } })
    await tx.onlineSettlement.create({ data: {
      id: settlementId, userId, quoteId, namespace: 'cloudbase-miniprogram', externalOrderId: settlementId,
      requestKey: `s-${TAG}-${n}`, requestFingerprint: fp('s', TAG, n),
      merchandiseCents: 10000n, eligibleMerchandiseCents: 10000n, shippingCents: 0n,
      totalCents: 10000n, sweetCardCents: 0n, wechatCents: 10000n,
      status: 'PAID', paidAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
    } })
    await tx.onlineTender.create({ data: {
      id: `nativ-t-${TAG}-${n}`, settlementId, type: 'WECHAT', amountCents: 10000n,
      status: 'SUCCEEDED', merchantTradeNo: `B${TAG}${n}`, providerTransactionId: txn,
      // online_tender_contract 要求 SUCCEEDED 的 WECHAT tender 必须三件套齐全
      verifiedAt: new Date(), providerSuccessAt: new Date(),
    } })
    if (withAuthorization) {
      await tx.onlineFulfillmentAuthorization.create({ data: {
        id: `ofa-${TAG}-${n}`, settlementId, requestKey: `f-${TAG}-${n}`, requestFingerprint: fp('f', TAG, n),
        method: fulfillment, carrierCode: fulfillment === 'DELIVERY' ? carrierCode : null,
        trackingNo: fulfillment === 'DELIVERY' ? trackingNo : null, actorId: userId, settlementVersion: 1,
      } })
    }
    if (withTrace && fulfillment === 'DELIVERY' && withAuthorization) {
      await tx.onlineLogisticsTrace.create({ data: {
        id: `olt-${TAG}-${n}`, settlementId, authorizationId: `ofa-${TAG}-${n}`,
        receiverPhone, goodsName: '92%生巧克力', goodsImgUrl: 'https://cdn.example.com/p/c1.jpg',
        orderDetailPath: 'pages/order-detail/order-detail?payNo=B1',
      } })
    }
  })
  return { userId, quoteId, settlementId, txn, trackingNo }
}

const row = id => prisma.onlineWechatShippingSync.findUnique({ where: { settlementId: id } })
/** 退避会把 available_at 推到未来；测试里显式放行以推进状态机（不改业务语义）。 */
const release = id => prisma.$executeRaw`
  UPDATE online_wechat_shipping_sync SET available_at = clock_timestamp() - interval '1 second'
  WHERE settlement_id = ${id}`

// tick() 是**全局**批量扫描，所以每个用例前清空同步表，保证 scanned 计数只反映本用例
// 自己的那一行（否则上一次运行/上一个用例遗留的 PENDING 行会混进来）。
test.beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM online_wechat_shipping_sync`
})

test('B-FIX1/root-cause: binding a SQL expression as a parameter is a real PostgreSQL type error', async () => {
  const f = await fixture()
  const stub = wechatStub()
  await serviceFor(stub).register({ settlementId: f.settlementId })

  // 上一轮 bug 的确切形态：把 `'verify_attempts + 1'` 交给 tagged template，Prisma 会把它
  // 变成绑定参数（$n），于是 PostgreSQL 尝试把该字符串写进 INTEGER 列。
  // 这条断言把根因钉死：任何回到「字符串表达式」写法的人都会看到它会炸。
  await assert.rejects(
    () => prisma.$executeRaw`
      UPDATE online_wechat_shipping_sync SET verify_attempts = ${'verify_attempts + 1'}
      WHERE settlement_id = ${f.settlementId}`,
    /invalid input syntax for type integer|integer/i)

  // 正确的写法是让表达式成为 SQL 本身，而不是参数。
  await prisma.$executeRaw`
    UPDATE online_wechat_shipping_sync SET verify_attempts = verify_attempts + 1
    WHERE settlement_id = ${f.settlementId}`
  assert.equal((await row(f.settlementId)).verifyAttempts, 1)
})

// ===========================================================================

test('B-01: a real DELIVERY shipment registers through real Prisma and persists reupload_count = 0', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const registered = await serviceFor(stub).register({ settlementId: f.settlementId })
  assert.equal(registered.status, 'PENDING_UPLOAD')
  const stored = await row(f.settlementId)
  assert.equal(stored.reuploadCount, 0)
  assert.equal(stored.verifyAttempts, 0)
  assert.equal(stored.deliveryId, 'SF', '顺丰的官方编码')
  assert.equal(stored.trackingNo, f.trackingNo)
  assert.equal(stub.calls.upload.length, 0, '登记阶段绝不调用微信')
})

test('B-02/#1: the first upload goes out once and lands in PENDING_VERIFY', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const summary = await sync.tick()
  assert.deepEqual(summary, { scanned: 1, uploaded: 1, synced: 0, unsupported: 0, failed: 0, pending: 1 })
  assert.equal(stub.calls.upload.length, 1)
  const sent = stub.calls.upload[0]
  assert.equal(sent.order_key.transaction_id, f.txn)
  assert.equal(sent.shipping_list[0].express_company, 'SF')
  assert.equal(sent.shipping_list[0].tracking_no, f.trackingNo)
  assert.equal(sent.shipping_list[0].contact.receiver_contact, '138****0000', '顺丰联系方式必须掩码')
  assert.equal(JSON.stringify(sent).includes('13800000000'), false, '完整手机号不得出现在 payload 里')
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_VERIFY')
  assert.equal(stored.uploadAcceptedAt !== null, true)
  assert.equal(stored.reuploadCount, 0, '首次 upload 不计入重传预算')
})

test('B-FIX1: verify_attempts increments 0→1→2→3 through REAL $executeRaw (the上一轮 bug 会在这里炸)', async () => {
  const f = await fixture()
  const stub = wechatStub()  // verify 默认返回 order_state=1 待发货
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()                                    // upload → PENDING_VERIFY, verify_attempts = 0
  assert.equal((await row(f.settlementId)).verifyAttempts, 0)

  for (const expected of [1, 2, 3]) {
    await release(f.settlementId)
    await sync.tick()
    const stored = await row(f.settlementId)
    assert.equal(stored.verifyAttempts, expected,
      `第 ${expected} 次 verify pending 后必须精确等于 ${expected}（字符串写进 INTEGER 会在这里报类型错误）`)
    assert.equal(stored.status, 'PENDING_VERIFY')
  }
  assert.equal(stub.calls.verify, 3)
})

test('B-FIX3/#6: exactly one controlled re-upload is allowed, and it sets reupload_count = 1', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()                                     // upload #1
  for (let i = 0; i < 3; i++) { await release(f.settlementId); await sync.tick() }   // verify ×3

  assert.equal(stub.calls.upload.length, 1)
  await release(f.settlementId)
  await sync.tick()                                     // 核实预算用尽 → 受控重传
  assert.equal(stub.calls.upload.length, 2, '首次 + 一次受控重传')
  const stored = await row(f.settlementId)
  assert.equal(stored.reuploadCount, 1, '预算被原子消费')
  assert.equal(stored.verifyAttempts, 0, '重传后核实预算归零')
  assert.deepEqual(stub.calls.upload[1], stub.calls.upload[0], '重传 payload 与首次逐字节相同')
})

test('B-FIX3/#7: after the budget is spent the upload count can never exceed 2, however long it runs', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  for (let i = 0; i < 10; i++) { await release(f.settlementId); await sync.tick() }  // upload+3v+reupload+Nv

  assert.equal(stub.calls.upload.length, 2, 'upload 总数永远 ≤ 2')
  const stored = await row(f.settlementId)
  assert.equal(stored.reuploadCount, 1)
  assert.equal(stored.status, 'PENDING_VERIFY', '花完预算后只继续核实')
  assert.ok(stored.attempts >= 9)
})

test('B-FIX3/restart: a brand-new service instance over the same database still cannot re-upload', async () => {
  const f = await fixture()
  const first = wechatStub()
  const syncA = serviceFor(first)
  await syncA.register({ settlementId: f.settlementId })
  for (let i = 0; i < 5; i++) { await release(f.settlementId); await syncA.tick() }
  assert.equal(first.calls.upload.length, 2)
  assert.equal((await row(f.settlementId)).reuploadCount, 1)

  // 「换实例 / worker 重启」：全新 client + 全新 service，同一张表
  const second = wechatStub()
  const syncB = serviceFor(second)
  for (let i = 0; i < 3; i++) { await release(f.settlementId); await syncB.tick() }
  assert.equal(second.calls.upload.length, 0, '重启不得重置重传预算')
  assert.equal((await row(f.settlementId)).reuploadCount, 1)
})

test('B-FIX3/concurrent: concurrent claims never produce two re-uploads', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()
  for (let i = 0; i < 3; i++) { await release(f.settlementId); await sync.tick() }
  assert.equal(stub.calls.upload.length, 1)

  // 4 个并发 worker 同时抢这一行：租约 + `AND reupload_count = 0` 双重保证只有一个能
  // 进入上传分支。
  await release(f.settlementId)
  const workers = [serviceFor(stub), serviceFor(stub), serviceFor(stub), serviceFor(stub)]
  const results = await Promise.all(workers.map(w => w.tick()))
  assert.equal(stub.calls.upload.length, 2, '并发也不得产生第二次重传')
  assert.equal((await row(f.settlementId)).reuploadCount, 1)
  assert.equal(results.reduce((n, r) => n + r.scanned, 0), 1, '同一行同一时刻只能被一个 worker 认领')
})

test('B-FIX3/atomic: the conditional UPDATE that grants the budget lets exactly one of two racers win', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await prisma.$executeRaw`
    UPDATE online_wechat_shipping_sync SET status = 'PENDING_VERIFY', lease_owner = 'racer-lease'
    WHERE settlement_id = ${f.settlementId}`
  const grant = () => prisma.$queryRaw`
    UPDATE online_wechat_shipping_sync
    SET reupload_count = reupload_count + 1
    WHERE settlement_id = ${f.settlementId} AND lease_owner = 'racer-lease'
      AND status = 'PENDING_VERIFY' AND reupload_count = 0
    RETURNING reupload_count`
  const [a, b] = await Promise.all([grant(), grant()])
  assert.equal([a, b].filter(r => r.length > 0).length, 1, '两个并发许可请求里只能有一个拿到行')
  assert.equal((await row(f.settlementId)).reuploadCount, 1)
})

test('B-08/#8: the SYNCED path requires WeChat to actually list our waybill', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify({ errcode: 0, order: { order_state: 2, shipping: { finish_shipping: true,
    shipping_list: [{ tracking_no: f.trackingNo, express_company: 'SF' }] } } })
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()                                     // upload
  await release(f.settlementId)
  const summary = await sync.tick()                     // verify → SHIPPED
  assert.equal(summary.synced, 1)
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'SYNCED')
  assert.equal(stored.verifiedAt !== null, true)
  assert.equal(stored.uploadAcceptedAt !== null, true)

  // 终态后不再被认领
  await release(f.settlementId)
  assert.equal((await sync.tick()).scanned, 0)
  assert.equal(stub.calls.upload.length, 1)
})

test('B-09/#9: the lease is real — a second concurrent pass cannot double-claim the same row', async () => {
  const f = await fixture()
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const wave = await Promise.all([sync.tick(), sync.tick(), sync.tick()])
  assert.equal(wave.reduce((n, r) => n + r.scanned, 0), 1, '同一时刻只有一个 worker 能拿到这一行')
  assert.equal(stub.calls.upload.length, 1)
})

test('B-FIX2: an unmaskable 顺丰 contact fails closed in the real database, without calling WeChat', async () => {
  const f = await fixture({ receiverPhone: '021-12345678' })
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const summary = await sync.tick()
  assert.equal(summary.failed, 1)
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'FAILED')
  assert.equal(stored.lastError, 'SHIPPING_CONTACT_INVALID_FORMAT')
  assert.equal(stub.calls.upload.length, 0, '不可掩码就绝不调用微信')
  assert.equal(JSON.stringify(stored).includes('021-12345678'), false, '完整号码不得进错误信息')
})

test('B-FIX2: a missing 顺丰 contact stays retryable rather than terminal', async () => {
  const f = await fixture({ withTrace: false })
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_UPLOAD', '尚未上传过，必须留在可重试上传的状态')
  assert.equal(stored.lastError, 'SHIPPING_CONTACT_PENDING_SF')
  assert.equal(stub.calls.upload.length, 0)

  // 联系方式后到 → 正常继续
  await prisma.onlineLogisticsTrace.create({ data: {
    id: `olt-late-${TAG}-${nextSeq()}`, settlementId: f.settlementId,
    authorizationId: (await prisma.onlineFulfillmentAuthorization.findUnique({ where: { settlementId: f.settlementId } })).id,
    receiverPhone: '13911112222', goodsName: '92%生巧克力', goodsImgUrl: 'https://cdn.example.com/p/c1.jpg',
    orderDetailPath: 'pages/order-detail/order-detail?payNo=B1',
  } })
  await release(f.settlementId)
  await sync.tick()
  assert.equal(stub.calls.upload.length, 1)
  assert.equal(stub.calls.upload[0].shipping_list[0].contact.receiver_contact, '139****2222')
})

test('B-FIX2: 韵达 uses YD, not the merchant page code YUNDA', async () => {
  const f = await fixture({ carrierCode: 'YUNDA', withTrace: false })
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()
  assert.equal(stub.calls.upload.length, 1)
  assert.equal(stub.calls.upload[0].shipping_list[0].express_company, 'YD')
  assert.equal(JSON.stringify(stub.calls.upload[0]).includes('YUNDA'), false)
  // 非顺丰：不带 contact
  assert.equal(stub.calls.upload[0].shipping_list[0].contact, undefined)
})

test('B-FIX4: PICKUP /fulfill 不注册 shipping sync、不调微信、返回结构不变', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false, withAuthorization: false })
  const merchantUserId = f.userId
  const merchantOpenId = (await prisma.weChatAuthIdentity.findFirst({ where: { userId: merchantUserId } })).openId

  const registered = []
  const shippingSync = {
    register: async input => { registered.push(input); return { status: 'PENDING_UPLOAD' } },
    tick: async () => ({ scanned: 0 }),
  }
  const stub = wechatStub()
  const app = express()
  app.use('/api/v2/merchant/online-checkout', express.json({ limit: '256kb' }),
    createOnlineMerchantRouter({ db: prisma, gatewayConfig: GATEWAY, logistics: null,
      wechatLogistics: null, shippingSync }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const body = { actorOpenId: merchantOpenId, settlementId: f.settlementId,
    requestKey: `fulfil-pickup-${TAG}-${nextSeq()}`, method: 'PICKUP' }
  const timestamp = String(Date.now())
  const nonce = crypto.randomBytes(24).toString('base64url')
  const signature = signProductionGatewayRequest({ timestamp, nonce, method: 'POST',
    requestPath: MERCHANT_PATH, bodyHash: gatewayBodyHash(body),
    environment: GATEWAY.cloudBaseEnvId, appId: GATEWAY.appId }, GATEWAY.gatewaySecret)
  const res = await fetch(`${base}${MERCHANT_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json',
      'x-budu-gateway-timestamp': timestamp, 'x-budu-gateway-nonce': nonce,
      'x-budu-gateway-environment': GATEWAY.cloudBaseEnvId, 'x-budu-gateway-appid': GATEWAY.appId,
      'x-budu-gateway-signature': signature },
    body: JSON.stringify(body) })
  const payload = await res.json()
  await new Promise(r => server.close(r))

  assert.equal(res.status, 200, JSON.stringify(payload))
  assert.equal(payload.result.status, 'PICKED_UP', '返回结构与语义不变')
  assert.deepEqual(registered, [], 'PICKUP 绝不调用 shippingSync.register')
  assert.equal(await row(f.settlementId), null, 'PICKUP 不创建 sync row')
  assert.equal(stub.calls.upload.length, 0)
})
