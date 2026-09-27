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
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'

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
  // 默认健康；A1/A2 会先把它置为不可用，再恢复。
  const state = { tokenHealthy: true }
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    const ok = payload => Promise.resolve({ ok: true, status: 200, json: async () => payload })
    if (url.includes('/cgi-bin/stable_token')) {
      calls.token += 1
      if (!state.tokenHealthy) return ok({ errcode: 40013, errmsg: 'invalid appid' })
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
    calls, impl, state,
    queueUpload: (...r) => { uploadResults = r },
    queueVerify: (...r) => { verifyResults = r },
    tokenDown: () => { state.tokenHealthy = false },
    tokenUp: () => { state.tokenHealthy = true },
  }
}

function serviceFor(stub) {
  // token 权威是**模块级缓存**（keyed by appId）。跨用例必须清掉，否则上一个用例
  // 缓存的好 token 会让「token 不可用」的用例拿到旧 token 而失去意义 —— 这同时也
  // 是「新进程 / 无缓存」的真实起点。
  _resetMiniprogramTokenAuthority()
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
const merchantOpenIdFor = async userId =>
  (await prisma.weChatAuthIdentity.findFirst({ where: { userId, appId: APP_ID } })).openId
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

test('B-08/#8: the SYNCED path requires WeChat to confirm the shipped state', async () => {
  const f = await fixture()
  const stub = wechatStub()
  // 严格终态判据：transaction 归属 + logistics_type=1 + 运单/快递公司严格命中 +
  // post-shipment order_state + finish_shipping=true，五条同时成立才 SHIPPED。
  stub.queueVerify({ errcode: 0, order: { transaction_id: f.txn, order_state: 2,
    shipping: { logistics_type: 1, delivery_mode: 1, finish_shipping: true,
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

test('P6/FIX4: 真实 /fulfill HTTP PICKUP 成功注册 shipping sync，且返回结构完全不变', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false, withAuthorization: false })
  const merchantUserId = f.userId
  const merchantOpenId = (await prisma.weChatAuthIdentity.findFirst({ where: { userId: merchantUserId } })).openId

  const stub = wechatStub()
  const shippingSync = serviceFor(stub)
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

  // canonical fulfillment 成功，返回结构与语义一字未改
  assert.equal(res.status, 200, JSON.stringify(payload))
  assert.deepEqual(Object.keys(payload.result).sort(),
    ['authorizationId', 'carrier', 'requestKey', 'settlementId', 'shippedAt', 'status', 'trackingNo'])
  assert.equal(payload.result.status, 'PICKED_UP')
  assert.equal(payload.result.method, undefined, '返回结构不得因本轮改动而变化')
  const auth = await prisma.onlineFulfillmentAuthorization.findUnique({ where: { settlementId: f.settlementId } })
  assert.equal(auth.method, 'PICKUP')

  // shipping sync row 已创建，且数据满足 PICKUP 约束
  const stored = await row(f.settlementId)
  assert.notEqual(stored, null, 'PICKUP 也必须登记')
  assert.equal(stored.method, 'PICKUP')
  assert.equal(stored.logisticsType, 4)
  assert.equal(stored.deliveryId, null)
  assert.equal(stored.trackingNo, null)
  assert.equal(stored.status, 'PENDING_UPLOAD')

  // worker 真正上传时用官方自提模式，且不伪造任何物流事实
  await release(f.settlementId)
  await shippingSync.tick()
  assert.equal(stub.calls.upload.length, 1)
  const sent = stub.calls.upload[0]
  assert.equal(sent.logistics_type, 4)
  assert.equal(sent.delivery_mode, 1)
  assert.deepEqual(sent.shipping_list, [{ item_desc: '92%生巧克力*1' }])
})

test('P5: PICKUP 不依赖 OnlineLogisticsTrace —— 即使完全没有 trace 行也能同步', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false })
  const traces = await prisma.onlineLogisticsTrace.count({ where: { settlementId: f.settlementId } })
  assert.equal(traces, 0, '此用例本来就没有 trace 行')

  const stub = wechatStub()
  stub.queueVerify({ errcode: 0, order: { transaction_id: f.txn, order_state: 2,
    shipping: { logistics_type: 4, delivery_mode: 1, finish_shipping: true, shipping_list: [] } } })
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()
  await release(f.settlementId)
  const summary = await sync.tick()
  assert.equal(summary.synced, 1, '没有 trace 也必须能核验通过')
  assert.equal((await row(f.settlementId)).status, 'SYNCED')
})

// ===========================================================================
// 第三轮 FIX A —— PENDING 必须区分 ambiguous（真实 PG）
// ===========================================================================

test('A1: token unavailable ⇒ 未上传，留在 PENDING_UPLOAD，预算与核实计数都为 0', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.tokenDown()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const summary = await sync.tick()
  assert.equal(summary.pending, 1)

  // 微信 upload endpoint 一次都没被调用
  assert.equal(stub.calls.upload.length, 0)
  assert.equal(stub.calls.verify, 0, '更不应进入核实路径')
  assert.ok(stub.calls.token >= 1, '确实尝试过换取 token')

  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_UPLOAD')
  assert.equal(stored.reuploadCount, 0)
  assert.equal(stored.verifyAttempts, 0)
  assert.equal(stored.uploadAcceptedAt, null)
})

test('A2: token 恢复后发生第一次正常 upload，且仍不算 reupload', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.tokenDown()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()
  assert.equal((await row(f.settlementId)).status, 'PENDING_UPLOAD')

  stub.tokenUp()
  await release(f.settlementId)
  await sync.tick()
  assert.equal(stub.calls.upload.length, 1, '正常发生第一次 upload')
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_VERIFY')
  assert.equal(stored.reuploadCount, 0, '第一次 upload 绝不算 reupload')
  assert.equal(stored.verifyAttempts, 0)
})

test('A2b: 微信明确 retryable response 也留在 PENDING_UPLOAD，不提前消耗唯一重传预算', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueUpload({ errcode: -1, errmsg: 'system error' })
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()

  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_UPLOAD')
  assert.equal(stored.reuploadCount, 0)
  assert.equal(stored.verifyAttempts, 0)
  assert.equal(stored.uploadAcceptedAt, null)
  assert.equal(stub.calls.verify, 0)
  assert.match(stored.lastError, /SHIPPING_UPLOAD_RETRY_-1/)

  // 后续可正常 retry（并成功）
  await release(f.settlementId)
  await sync.tick()
  assert.equal(stub.calls.upload.length, 2, 'retry 仍然是「首次上传」性质的尝试')
  assert.equal((await row(f.settlementId)).status, 'PENDING_VERIFY')
  assert.equal((await row(f.settlementId)).reuploadCount, 0, '仍未消耗受控重传预算')
})

test('A3: transport ambiguous ⇒ PENDING_VERIFY，下一轮先核实而不是盲目重传', async () => {
  const f = await fixture()
  const stub = wechatStub()
  let explode = true
  const original = stub.impl
  const sync = serviceFor({ ...stub, impl: async (url, options) => {
    if (explode && url.includes('upload_shipping_info')) {
      explode = false
      // 关键：请求**确实已经发出**，只是结果不可知。先记录再抛，才能断言「没有盲目重传」。
      stub.calls.upload.push(JSON.parse(options.body))
      throw new Error('ECONNRESET')
    }
    return original(url, options)
  } })
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()

  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_VERIFY', '请求已发出但结果不确定 ⇒ 可能已收下 ⇒ 必须核实')
  assert.equal(stored.lastError, 'SHIPPING_UPLOAD_AMBIGUOUS')
  assert.equal(stored.reuploadCount, 0)
  assert.equal(stored.verifyAttempts, 0)

  await release(f.settlementId)
  await sync.tick()
  assert.equal(stub.calls.verify, 1, '下一轮必须 get_order')
  assert.equal(stub.calls.upload.length, 1, '不得盲目重传')
})

test('A4: 核实 ×3 之后最多一次受控重传，upload 总数恒 ≤ 2', async () => {
  const f = await fixture()
  const stub = wechatStub()   // verify 默认 order_state=1
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  for (let i = 0; i < 10; i++) { await release(f.settlementId); await sync.tick() }
  assert.equal(stub.calls.upload.length, 2, '首次 + 一次受控重传')
  const stored = await row(f.settlementId)
  assert.equal(stored.reuploadCount, 1)
  assert.equal(stored.status, 'PENDING_VERIFY')
})

// ===========================================================================
// 第三轮 FIX B —— PICKUP 接入微信官方「用户自提」（真实 PG）
// ===========================================================================

test('P1: PICKUP register 落库且满足 PICKUP 约束（无 sentinel）', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false })
  const stub = wechatStub()
  const sync = serviceFor(stub)
  const registered = await sync.register({ settlementId: f.settlementId })
  assert.equal(registered.status, 'PENDING_UPLOAD')
  assert.equal(registered.method, 'PICKUP')
  assert.equal(registered.logisticsType, 4)

  const stored = await row(f.settlementId)
  assert.equal(stored.method, 'PICKUP')
  assert.equal(stored.logisticsType, 4)
  assert.equal(stored.deliveryId, null, '不得写 PICKUP/NONE/SELF 之类的 sentinel')
  assert.equal(stored.trackingNo, null, '不得写空运单号占位')
  assert.equal(stored.lastError, null)

  // 直接违反约束的写法必须被数据库拒绝
  await assert.rejects(() => prisma.$executeRaw`
    UPDATE online_wechat_shipping_sync SET tracking_no = 'FAKE'
    WHERE settlement_id = ${f.settlementId}`, /online_wechat_shipping_sync_check/)
  await assert.rejects(() => prisma.$executeRaw`
    UPDATE online_wechat_shipping_sync SET logistics_type = 1
    WHERE settlement_id = ${f.settlementId}`, /online_wechat_shipping_sync_check/)
})

test('P2: PICKUP upload 用官方自提模式，且不伪造运单/快递公司/联系方式', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false })
  const stub = wechatStub()
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()

  assert.equal(stub.calls.upload.length, 1)
  const sent = stub.calls.upload[0]
  assert.equal(sent.logistics_type, 4, '官方 4 = 用户自提')
  assert.equal(sent.delivery_mode, 1, '分拆发货仅支持物流快递 ⇒ 自提只能统一发货')
  assert.equal(sent.order_key.order_number_type, 2)
  assert.equal(sent.order_key.transaction_id, f.txn, '真实 WECHAT tender')
  assert.equal(sent.payer.openid, await merchantOpenIdFor(f.userId),
    'openid 必须来自 WeChatAuthIdentity 的真实值')
  assert.equal(sent.shipping_list.length, 1)
  assert.deepEqual(sent.shipping_list[0], { item_desc: '92%生巧克力*1' })
  assert.equal(sent.is_all_delivered, undefined)

  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'PENDING_VERIFY')
  assert.equal(stored.uploadAcceptedAt !== null, true)
})

test('P3: PICKUP 核验通过（微信记录 logistics_type=4 且已完成发货）⇒ SYNCED', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false })
  const stub = wechatStub()
  stub.queueVerify({ errcode: 0, order: { transaction_id: f.txn, order_state: 2,
    shipping: { logistics_type: 4, delivery_mode: 1, finish_shipping: true, shipping_list: [] } } })
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()
  await release(f.settlementId)
  const summary = await sync.tick()
  assert.equal(summary.synced, 1)
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'SYNCED')
  assert.equal(stored.verifiedAt !== null, true)
  assert.equal(stored.deliveryId, null, 'SYNCED 的自提行仍然不带任何运单事实')
})

test('P4: PICKUP 但微信记的是别的 logistics_type ⇒ MISMATCH，绝不 SYNCED', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false })
  const stub = wechatStub()
  // 让每一次核实都返回「记成了快递」：连续 MISMATCH 达到阈值后必须判死
  const wrongMode = { errcode: 0, order: { transaction_id: f.txn, order_state: 2,
    shipping: { logistics_type: 1, delivery_mode: 1, finish_shipping: true,
      shipping_list: [{ tracking_no: 'SF-OTHER', express_company: 'SF' }] } } }
  stub.queueVerify(...Array(9).fill(wrongMode))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  for (let i = 0; i < 8; i++) { await release(f.settlementId); await sync.tick() }
  const stored = await row(f.settlementId)
  assert.notEqual(stored.status, 'SYNCED', '微信记的是快递，不是我们的自提履约')
  assert.equal(stored.status, 'FAILED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_MISMATCH')
})

test('P4b: transaction_id 不属于我们 ⇒ MISMATCH', async () => {
  const f = await fixture({ fulfillment: 'PICKUP', withTrace: false })
  const stub = wechatStub()
  const foreign = { errcode: 0, order: { transaction_id: '4200-SOMEONE-ELSE', order_state: 2,
    shipping: { logistics_type: 4, finish_shipping: true } } }
  stub.queueVerify(...Array(9).fill(foreign))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await sync.tick()                       // 首次 upload
  await release(f.settlementId)
  await sync.tick()                       // 核实 → 订单不属于我们
  const stored = await row(f.settlementId)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_MISMATCH')
})

// ===========================================================================
// 第四轮 FIX — DELIVERY 严格终态判据 D1–D7（真实 PostgreSQL）
// ===========================================================================

/** 快递事实完全正确的 get_order 响应；各用例只覆盖自己关心的那一个字段。 */
const orderOk = (txn, trackingNo, over = {}) => ({
  errcode: 0,
  order: {
    transaction_id: txn,
    order_state: 2,
    ...over,
    shipping: { logistics_type: 1, delivery_mode: 1, finish_shipping: true,
      shipping_list: [{ tracking_no: trackingNo, express_company: 'SF' }], ...(over.shipping || {}) },
  },
})

/** 跑 6 轮，返回结算后的行。 */
async function settleRounds(sync, settlementId, rounds = 6) {
  for (let i = 0; i < rounds; i++) { await release(settlementId); await sync.tick() }
  return row(settlementId)
}

test('D1-PG: 运单已出现但 order_state 仍是待发货 ⇒ PENDING，不 SYNCED', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(9).fill(orderOk(f.txn, f.trackingNo, { order_state: 1 })))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const stored = await settleRounds(sync, f.settlementId, 3)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_PENDING_0')
})

test('D2-PG: 已发货、运单正确，但 finish_shipping=false ⇒ PENDING，不 SYNCED', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(9).fill(orderOk(f.txn, f.trackingNo, { shipping: { finish_shipping: false } })))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const stored = await settleRounds(sync, f.settlementId, 3)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_PENDING_0')
})

test('D3-PG: 微信记成自提，即使运单看似正确 ⇒ MISMATCH，不 SYNCED', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(9).fill(orderOk(f.txn, f.trackingNo, { shipping: { logistics_type: 4 } })))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const stored = await settleRounds(sync, f.settlementId, 5)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_MISMATCH')
})

test('D4-PG: 运单号正确但快递公司不是我们的 ⇒ MISMATCH', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(9).fill(orderOk(f.txn, f.trackingNo,
    { shipping: { shipping_list: [{ tracking_no: f.trackingNo, express_company: 'YTO' }] } })))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const stored = await settleRounds(sync, f.settlementId, 5)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_MISMATCH')
})

test('D5-PG: 快递公司字段缺失 ⇒ PENDING，绝不 SYNCED', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(9).fill(orderOk(f.txn, f.trackingNo,
    { shipping: { shipping_list: [{ tracking_no: f.trackingNo }] } })))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const stored = await settleRounds(sync, f.settlementId, 3)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_PENDING_0')
})

test('D6-PG: 五条同时成立 ⇒ SHIPPED → SYNCED', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(3).fill(orderOk(f.txn, f.trackingNo)))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  await release(f.settlementId)
  await sync.tick()
  await release(f.settlementId)
  const summary = await sync.tick()
  assert.equal(summary.synced, 1)
  const stored = await row(f.settlementId)
  assert.equal(stored.status, 'SYNCED')
  assert.equal(stored.verifiedAt !== null, true)
})

test('D7-PG: 更后续的合法状态（确认收货/交易完成/资金待结算）仍能 SYNCED', async () => {
  for (const order_state of [3, 4, 6]) {
    const f = await fixture()
    const stub = wechatStub()
    stub.queueVerify(orderOk(f.txn, f.trackingNo, { order_state }))
    const sync = serviceFor(stub)
    await sync.register({ settlementId: f.settlementId })
    await release(f.settlementId)
    await sync.tick()
    await release(f.settlementId)
    const summary = await sync.tick()
    assert.equal(summary.synced, 1, `order_state=${order_state} 必须能 SYNCED`)
    assert.equal((await row(f.settlementId)).status, 'SYNCED')
  }
})

test('D8-PG/E: 别人的运单占用了这笔支付单 ⇒ MISMATCH', async () => {
  const f = await fixture()
  const stub = wechatStub()
  stub.queueVerify(...Array(9).fill(orderOk(f.txn, f.trackingNo,
    { shipping: { shipping_list: [{ tracking_no: 'YTO-OTHER', express_company: 'YTO' }] } })))
  const sync = serviceFor(stub)
  await sync.register({ settlementId: f.settlementId })
  const stored = await settleRounds(sync, f.settlementId, 5)
  assert.notEqual(stored.status, 'SYNCED')
  assert.equal(stored.lastError, 'SHIPPING_VERIFY_MISMATCH')
})
