/**
 * 微信「发货信息管理」同步：客户端契约 + 独立状态机。
 *
 * 覆盖 Release Gate 指令 §十一 的 18 项要求，以及本实现特有的守卫：
 * 歧义上传必须先核实、核实错配不得声称已同步、顺丰联系人缺失不得编造、
 * payload 指纹不得被改写、任何失败都不得抛出、任何日志都不得泄漏密钥。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWechatShippingInfo, toWechatUploadTime } from '../server/wechat-shipping-info.js'
import { createOnlineWechatShippingSync, buildItemDesc } from '../server/online-wechat-shipping-sync.js'
import {
  resolveShippingDeliveryId, shippingCarrierRequiresContact, SHIPPING_DELIVERY_CODES,
} from '../server/wechat-delivery-codes.js'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'

const APP_ID = 'wxfce0a3c4bb430023'
const CONFIG = { appId: APP_ID, appSecret: 'S'.repeat(32), mode: 'PRODUCTION' }
const SETTLEMENT = 'os-' + 'b'.repeat(64)
const TRANSACTION = '4200003114202609240000000001'
const TRACKING = 'SF1234567890'
const SHIPPED_AT = new Date('2026-09-24T02:05:06.789Z')

// ---------------------------------------------------------------------------
// fetch 桩：按 URL 分派，记录每一次调用，供断言「微信被调了几次、发了什么」
// ---------------------------------------------------------------------------
function stubFetch(handlers = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body, options })
    const token = url.includes('/cgi-bin/stable_token')
    if (token) {
      const next = handlers.token
      return reply(next ? (typeof next === 'function' ? next(calls) : next) : { errcode: 0, access_token: 'TOK-primary', expires_in: 7200 })
    }
    if (url.includes('/wxa/sec/order/upload_shipping_info')) {
      const next = handlers.upload
      return reply(next ? (typeof next === 'function' ? next(calls) : next) : { errcode: 0, errmsg: 'ok' })
    }
    if (url.includes('/wxa/sec/order/get_order')) {
      const next = handlers.verify
      return reply(next ? (typeof next === 'function' ? next(calls) : next) : { errcode: 0, errmsg: 'ok' })
    }
    throw new Error('UNEXPECTED_URL ' + url)
  }
  return { calls, impl }
}

function reply(payload) {
  if (payload instanceof Error) return Promise.reject(payload)
  if (payload && payload.__transport) return Promise.resolve({ ok: false, status: 502, json: async () => ({}) })
  return Promise.resolve({ ok: true, status: 200, json: async () => payload })
}

function client(handlers = {}) {
  _resetMiniprogramTokenAuthority()
  const { calls, impl } = stubFetch(handlers)
  const shipping = createWechatShippingInfo({ config: CONFIG, fetchImpl: impl, now: () => 1_700_000_000_000 })
  return { shipping, calls, impl }
}

const uploadCalls = calls => calls.filter(c => c.url.includes('upload_shipping_info'))
const verifyCalls = calls => calls.filter(c => c.url.includes('get_order'))
const tokenCalls = calls => calls.filter(c => c.url.includes('stable_token'))

const UPLOAD_INPUT = {
  transactionId: TRANSACTION,
  openid: 'oPENID-buyer',
  deliveryId: 'SF',
  trackingNo: TRACKING,
  itemDesc: '92%生巧克力*1',
  receiverContact: '13800000000',
  uploadTime: SHIPPED_AT,
}

// ===========================================================================
// A. HTTP 客户端契约（§二 官方文档字段/枚举）
// ===========================================================================

test('CLI-01: the payload matches the official upload_shipping_info contract exactly', async () => {
  const { shipping, calls } = client()
  const outcome = await shipping.upload(UPLOAD_INPUT)
  assert.deepEqual(outcome, { status: 'ACCEPTED', code: 0 })
  assert.equal(uploadCalls(calls).length, 1)
  const sent = uploadCalls(calls)[0].body
  assert.deepEqual(sent.order_key, { order_number_type: 2, transaction_id: TRANSACTION })
  assert.equal(sent.logistics_type, 1, '实体物流配送 = 1')
  assert.equal(sent.delivery_mode, 1, 'UNIFIED_DELIVERY = 1')
  assert.equal(sent.payer.openid, 'oPENID-buyer')
  assert.equal(sent.shipping_list.length, 1, '统一发货 shipping_list 长度必须为 1')
  assert.deepEqual(sent.shipping_list[0], {
    tracking_no: TRACKING, express_company: 'SF', item_desc: '92%生巧克力*1',
    // 官方要求掩码传输；完整号码绝不外发
    contact: { receiver_contact: '138****0000' },
  })
  assert.equal(sent.is_all_delivered, undefined, '统一发货不带 is_all_delivered')
  // access_token 走查询串，且绝不放进 body
  assert.match(uploadCalls(calls)[0].url, /\?access_token=/)
  assert.equal(JSON.stringify(sent).includes('access_token'), false)
  assert.equal(JSON.stringify(sent).includes('13800000000'), false, '完整手机号不得出现在 payload')
})

test('CLI-02: upload_time is RFC 3339 with milliseconds and an explicit +08:00 offset', () => {
  assert.equal(toWechatUploadTime(SHIPPED_AT), '2026-09-24T10:05:06.789+08:00')
  // 与进程时区无关：容器里是 UTC，也必须输出 +08:00
  const tz = process.env.TZ
  process.env.TZ = 'America/New_York'
  assert.equal(toWechatUploadTime(SHIPPED_AT), '2026-09-24T10:05:06.789+08:00')
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
  assert.equal(toWechatUploadTime('not-a-date'), '')
  // 关键回归：空值绝不能被强转成 1970 而"看起来合法"地通过
  for (const empty of ['', '   ', null, undefined, 0, NaN, 'nope']) {
    assert.equal(toWechatUploadTime(empty), '', `${String(empty)} 必须返回空串`)
  }
})

test('CLI-03: WeChat "already accepted" codes mean verify, never failure', async () => {
  for (const code of [10060002, 10060003, 10060023]) {
    const { shipping } = client({ upload: { errcode: code, errmsg: 'x' } })
    assert.deepEqual(await shipping.upload(UPLOAD_INPUT), { status: 'ALREADY_ACCEPTED', code })
  }
})

test('CLI-04: system-busy and not-yet-ingested payments stay retryable, parameter errors do not', async () => {
  for (const code of [-1, 10060012, 10060019, 10060001]) {
    const { shipping } = client({ upload: { errcode: code } })
    const outcome = await shipping.upload(UPLOAD_INPUT)
    assert.equal(outcome.status, 'PENDING', `errcode ${code} 必须可重试`)
    assert.equal(outcome.code, code)
  }
  for (const code of [10060005, 10060008, 10060024, 268485228, 10060031]) {
    const { shipping } = client({ upload: { errcode: code } })
    assert.deepEqual(await shipping.upload(UPLOAD_INPUT), { status: 'FAILED', code })
  }
})

test('CLI-05: a transport failure is reported as ambiguous, never as success', async () => {
  const { shipping } = client({ upload: { __transport: true } })
  const outcome = await shipping.upload(UPLOAD_INPUT)
  assert.equal(outcome.status, 'PENDING')
  assert.equal(outcome.ambiguous, true, '传输失败时微信可能已收下，必须标记为歧义')
})

test('CLI-06: incomplete inputs are refused locally instead of burning the re-ship chance', async () => {
  for (const key of ['transactionId', 'openid', 'deliveryId', 'trackingNo', 'itemDesc', 'uploadTime']) {
    const { shipping, calls } = client()
    const outcome = await shipping.upload({ ...UPLOAD_INPUT, [key]: '' })
    assert.deepEqual(outcome, { status: 'UNSUPPORTED' }, `${key} 缺失时必须本地拒绝`)
    assert.equal(calls.length, 0)
  }
})

test('CLI-07: verify reports SHIPPED only when WeChat lists OUR waybill', async () => {
  const shipped = {
    errcode: 0, order: { order_state: 2, shipping: { logistics_type: 1, finish_shipping: true, shipping_list: [{ tracking_no: TRACKING, express_company: 'SF' }] } },
  }
  const ok = client({ verify: shipped })
  assert.deepEqual(await ok.shipping.verify({ transactionId: TRANSACTION, trackingNo: TRACKING, deliveryId: 'SF' }),
    { status: 'SHIPPED', code: 0 })

  // 微信已发货，但记录的是别人的运单 —— 绝不能算我们的
  const someoneElse = { errcode: 0, order: { order_state: 2, shipping: { logistics_type: 1, finish_shipping: true, shipping_list: [{ tracking_no: 'YTO9999', express_company: 'YTO' }] } } }
  const mismatch = client({ verify: someoneElse })
  assert.deepEqual(await mismatch.shipping.verify({ transactionId: TRANSACTION, trackingNo: TRACKING, deliveryId: 'SF' }),
    { status: 'MISMATCH', code: 0 })

  // 待发货 → 还没同步
  const notYet = client({ verify: { errcode: 0, order: { order_state: 1 } } })
  assert.deepEqual(await notYet.shipping.verify({ transactionId: TRANSACTION, trackingNo: TRACKING, deliveryId: 'SF' }),
    { status: 'PENDING', code: 0 })

  // 已退款 → 该支付单不会再走发货结算
  const refunded = client({ verify: { errcode: 0, order: { order_state: 5 } } })
  assert.deepEqual(await refunded.shipping.verify({ transactionId: TRANSACTION, trackingNo: TRACKING, deliveryId: 'SF' }),
    { status: 'REFUNDED', code: 0 })
})

test('CLI-08: a stale token is refreshed exactly once, using the single token authority', async () => {
  let uploads = 0
  const { shipping, calls } = client({
    upload: () => (++uploads === 1 ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 0 }),
  })
  assert.deepEqual(await shipping.upload(UPLOAD_INPUT), { status: 'ACCEPTED', code: 0 })
  assert.equal(uploadCalls(calls).length, 2, '刷新后重试恰好一次')
  assert.equal(tokenCalls(calls).length, 2, '失效后必须重新走同一 token 权威（绕过本地缓存）')
  for (const probe of tokenCalls(calls)) {
    assert.equal(probe.body.grant_type, 'client_credential')
    assert.equal(probe.body.appid, APP_ID)
  }
})

test('CLI-09: an expired token that cannot be refreshed stays retryable, not failed', async () => {
  const { shipping } = client({
    upload: { errcode: 40014 },
    token: () => ({ errcode: 40013, errmsg: 'invalid appid' }),
  })
  const outcome = await shipping.upload(UPLOAD_INPUT)
  assert.equal(outcome.status, 'PENDING')
})

test('CLI-10: neither the token nor the app secret ever appears in any outcome or call', async () => {
  const { shipping, calls } = client()
  const outcome = await shipping.upload(UPLOAD_INPUT)
  const serialised = JSON.stringify(outcome)
  assert.equal(serialised.includes('TOK-primary'), false)
  assert.equal(serialised.includes(CONFIG.appSecret), false)
  const probe = calls.find(c => c.url.includes('stable_token'))
  assert.equal(probe.body.secret, CONFIG.appSecret, '密钥只应出现在换取 token 的那一次请求体内')
})

// ===========================================================================
// B. 承运商编码 mapping authority（§五）
// ===========================================================================

test('MAP-01: every approved carrier resolves to the official WeChat delivery_id', () => {
  assert.deepEqual(resolveShippingDeliveryId('SF'), { deliveryId: 'SF', officialName: '顺丰速运' })
  assert.deepEqual(resolveShippingDeliveryId('ZTO'), { deliveryId: 'ZTO', officialName: '中通快递' })
  assert.deepEqual(resolveShippingDeliveryId('YTO'), { deliveryId: 'YTO', officialName: '圆通速递' })
  assert.deepEqual(resolveShippingDeliveryId('STO'), { deliveryId: 'STO', officialName: '申通快递' })
  assert.deepEqual(resolveShippingDeliveryId('JD'), { deliveryId: 'JD', officialName: '京东快递' })
  assert.deepEqual(resolveShippingDeliveryId('EMS'), { deliveryId: 'EMS', officialName: 'EMS' })
  // 关键：BUDU 页面码 YUNDA ≠ 微信 delivery_id，必须是 YD
  assert.deepEqual(resolveShippingDeliveryId('YUNDA'), { deliveryId: 'YD', officialName: '韵达速递' })
  assert.notEqual(resolveShippingDeliveryId('YUNDA').deliveryId, 'YUNDA')
})

test('MAP-02: an unknown carrier fails closed instead of guessing a code', () => {
  for (const code of ['', 'yunda', 'SFX', 'DHL', ' undefined', null, undefined, 42]) {
    assert.equal(resolveShippingDeliveryId(code), null, `${String(code)} 必须 fail closed`)
  }
  assert.equal(shippingCarrierRequiresContact('SF'), true)
  assert.equal(shippingCarrierRequiresContact('YD'), false)
  // 表本身冻结，运行时不可被改写
  assert.equal(Object.isFrozen(SHIPPING_DELIVERY_CODES), true)
})

// ===========================================================================
// C. 状态机（内存 prisma 桩）
// ===========================================================================

const AUTHORIZATION = {
  id: 'ofa-' + 'c'.repeat(8), settlementId: SETTLEMENT, method: 'DELIVERY',
  carrierCode: 'SF', trackingNo: TRACKING, createdAt: SHIPPED_AT,
}
function store(overrides = {}) {
  const tender = overrides.tender === undefined
    ? { type: 'WECHAT', status: 'SUCCEEDED', providerTransactionId: TRANSACTION }
    : overrides.tender
  const state = {
    rows: new Map(),
    row: null,
    claimable: true,
    statements: [],
    traceLookups: 0,
    settlement: 'settlement' in overrides
      ? overrides.settlement
      : { id: SETTLEMENT, userId: 'u1', quoteId: 'q1', tenders: tender ? [tender] : [] },
    authorization: 'authorization' in overrides ? overrides.authorization : AUTHORIZATION,
    identity: 'identity' in overrides ? overrides.identity : { openId: 'oPENID-buyer' },
    quote: 'quote' in overrides ? overrides.quote : { snapshot: { lines: [{ name: '92%生巧克力', quantity: 1 }] } },
    trace: 'trace' in overrides ? overrides.trace : { receiverPhone: '13800000000' },
  }
  const prisma = {
    onlineSettlement: { findUnique: async () => state.settlement },
    onlineFulfillmentAuthorization: { findUnique: async () => state.authorization },
    weChatAuthIdentity: { findFirst: async () => state.identity },
    onlineCheckoutQuote: { findUnique: async () => state.quote },
    onlineLogisticsTrace: { findUnique: async () => { state.traceLookups += 1; return state.trace } },
    onlineWechatShippingSync: {
      findUnique: async ({ where }) => state.rows.get(where.settlementId) || null,
      create: async ({ data }) => {
        if (state.rows.has(data.settlementId)) throw Object.assign(Error('unique'), { code: 'P2002' })
        const row = {
          status: 'PENDING_UPLOAD', method: 'DELIVERY', logisticsType: 1,
          attempts: 0, verifyAttempts: 0, reuploadCount: 0, lastError: null,
          uploadAcceptedAt: null, verifiedAt: null, ...data,
        }
        state.rows.set(data.settlementId, row)
        state.row = row
        return row
      },
    },
    $transaction: async (fn, options) => {
      state.txOptions = options
      return fn(prisma)
    },
    $queryRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('§') : String(strings)
      const row = state.row
      if (sql.includes('SET reupload_count = reupload_count + 1')) {
        state.statements.push({ sql, values, kind: 'claimReupload' })
        // 真实 SQL 的条件是 status='PENDING_VERIFY' AND reupload_count = 0 AND lease_owner 相符；
        // 命中才返回一行，否则 0 行 —— 这就是「最多一次」的原子许可。
        // 归属校验用 includes：真实语句里 lease_owner 既出现在 SET 也出现在 WHERE，
        // 绑定参数位置随写法变化，这里只模拟「必须是本行当前租约持有人」。
        if (!row || row.status !== 'PENDING_VERIFY' || row.reuploadCount >= 1
          || !values.includes(row.leaseOwner)) return []
        row.reuploadCount += 1
        row.verifyAttempts = 0
        return [{ reupload_count: row.reuploadCount }]
      }
      if (!row || !state.claimable) return []
      if (!['PENDING_UPLOAD', 'PENDING_VERIFY'].includes(row.status)) return []
      if (row.attempts >= 12) return []
      state.claimable = false
      row.attempts += 1
      row.leaseOwner = 'lease-owner-1'
      return [{
        id: row.id, settlement_id: row.settlementId, authorization_id: row.authorizationId, status: row.status,
        method: row.method, logistics_type: row.logisticsType,
        delivery_id: row.deliveryId, tracking_no: row.trackingNo, upload_time: row.uploadTime,
        payload_fingerprint: row.payloadFingerprint, attempts: row.attempts, verify_attempts: row.verifyAttempts,
        lease_owner: row.leaseOwner, upload_accepted_at: row.uploadAcceptedAt, reupload_count: row.reuploadCount,
      }]
    },
    $executeRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('§') : String(strings)
      state.statements.push({ sql, values })
      const row = state.row
      if (sql.includes("status = 'SYNCED'")) {
        row.status = 'SYNCED'; row.verifiedAt = 'verified'; row.uploadAcceptedAt = row.uploadAcceptedAt || 'accepted'
        row.lastError = null; row.verifyAttempts = 0
      } else if (sql.includes('upload_accepted_at = COALESCE')) {
        row.status = 'PENDING_VERIFY'; row.uploadAcceptedAt = row.uploadAcceptedAt || 'accepted'
        row.verifyAttempts = 0; row.lastError = null; row.availableAt = 'deferred'
      } else if (sql.includes('SET status = §')) {
        row.status = values[0]; row.lastError = values[1]; row.availableAt = null
      } else if (sql.includes('verify_attempts = verify_attempts + 1')) {
        // Fix 1：非 fresh 分支是**字面 SQL 表达式**，不是绑定参数。
        row.status = 'PENDING_VERIFY'; row.lastError = values[0]; row.availableAt = 'deferred'
        row.verifyAttempts += 1
      } else if (sql.includes("status = 'PENDING_VERIFY'")) {
        // fresh 分支：verify_attempts = 0
        row.status = 'PENDING_VERIFY'; row.lastError = values[0]; row.availableAt = 'deferred'
        row.verifyAttempts = 0
      } else {
        row.lastError = values[0]; row.availableAt = 'deferred'
      }
      row.leaseOwner = null
      return 1
    },
  }
  return { state, prisma }
}

function service(overrides = {}, handlers = {}) {
  const { state, prisma } = store(overrides)
  const { calls, impl } = stubFetch(handlers)
  _resetMiniprogramTokenAuthority()
  const shipping = createWechatShippingInfo({ config: CONFIG, fetchImpl: impl, now: () => 1_700_000_000_000 })
  const sync = createOnlineWechatShippingSync(prisma, { shipping, appId: APP_ID })
  return { sync, state, calls, prisma }
}

const VERIFY_SHIPPED = {
  errcode: 0,
  order: { order_state: 2, shipping: { logistics_type: 1, finish_shipping: true, shipping_list: [{ tracking_no: TRACKING, express_company: 'SF' }] } },
}

test('REG-01: registering the same shipment twice is idempotent', async () => {
  const { sync, state } = service()
  const first = await sync.register({ settlementId: SETTLEMENT })
  const second = await sync.register({ settlementId: SETTLEMENT })
  assert.deepEqual(first, second)
  assert.equal(first.status, 'PENDING_UPLOAD')
  assert.equal(first.synced, false)
  assert.equal(state.rows.size, 1)
  assert.equal(state.txOptions.isolationLevel, 'Serializable')
})

test('REG-02: logistics facts that changed under the same settlement are refused, not overwritten', async () => {
  const moved = { ...AUTHORIZATION, trackingNo: 'SF9999999999', requestFingerprint: 'different' }
  const { state, prisma } = store()
  const { impl } = stubFetch({})
  const sync = createOnlineWechatShippingSync(prisma, {
    shipping: createWechatShippingInfo({ config: CONFIG, fetchImpl: impl, now: () => 1 }),
    appId: APP_ID,
  })
  await sync.register({ settlementId: SETTLEMENT })
  state.authorization = moved
  await assert.rejects(() => sync.register({ settlementId: SETTLEMENT }), /冲突/)
})

test('REG-03: nothing can be registered before the merchant actually shipped', async () => {
  await assert.rejects(
    () => service({ authorization: null }).sync.register({ settlementId: SETTLEMENT }), /尚未发货/)
  await assert.rejects(() => service({ settlement: null }).sync.register({ settlementId: SETTLEMENT }), /订单不存在/)
  await assert.rejects(
    () => service({ authorization: { ...AUTHORIZATION, method: 'SOMETHING' } })
      .sync.register({ settlementId: SETTLEMENT }), /履约方式无效/)
})

test('REG-04: a PICKUP fulfillment registers with NULL carrier/waybill — no sentinel values', async () => {
  const { sync, state } = service({ authorization: { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null } })
  const registered = await sync.register({ settlementId: SETTLEMENT })
  assert.equal(registered.status, 'PENDING_UPLOAD')
  assert.equal(registered.method, 'PICKUP')
  assert.equal(registered.logisticsType, 4, '官方 4 = 用户自提')
  assert.equal(registered.deliveryId, null, '自提不得伪造承运商编码')
  assert.equal(registered.trackingNo, null, '自提不得伪造运单号')
  assert.equal(state.row.lastError, null)
})

test('MAP-03: an unmapped carrier is recorded as FAILED, never uploaded with a guessed code', async () => {
  const { sync, state, calls } = service({ authorization: { ...AUTHORIZATION, carrierCode: 'YUNDA2' } })
  const registered = await sync.register({ settlementId: SETTLEMENT })
  assert.equal(registered.status, 'FAILED')
  assert.equal(state.row.lastError, 'SHIPPING_CARRIER_UNSUPPORTED')
  assert.equal((await sync.tick()).scanned, 0, 'FAILED 行不可被 claim')
  assert.equal(uploadCalls(calls).length, 0)
})

test('SVC-01 / #2 / #8: upload then verify reaches SYNCED, and an already-synced row is never re-uploaded', async () => {
  const { sync, state, calls } = service({}, { verify: VERIFY_SHIPPED })
  await sync.register({ settlementId: SETTLEMENT })

  const first = await sync.tick()
  assert.deepEqual(first, { scanned: 1, uploaded: 1, synced: 0, unsupported: 0, failed: 0, pending: 1 })
  assert.equal(uploadCalls(calls).length, 1)
  const sent = uploadCalls(calls)[0].body
  assert.equal(sent.order_key.transaction_id, TRANSACTION)
  assert.equal(sent.payer.openid, 'oPENID-buyer')
  assert.equal(sent.shipping_list[0].express_company, 'SF')
  assert.equal(sent.upload_time, '2026-09-24T10:05:06.789+08:00', 'upload_time 必须是首次发货时间')
  assert.equal(state.row.status, 'PENDING_VERIFY')

  state.claimable = true
  const second = await sync.tick()
  assert.equal(second.synced, 1, 'get_order 核实后才是 SYNCED')
  assert.equal(verifyCalls(calls).length, 1)
  assert.equal(uploadCalls(calls).length, 1, '核实阶段不得再次上传')
  assert.equal(state.row.status, 'SYNCED')
  assert.equal((await sync.status(SETTLEMENT)).synced, true)

  state.claimable = true
  assert.equal((await sync.tick()).scanned, 0, 'SYNCED 不再被 claim')
  assert.equal(uploadCalls(calls).length, 1)
})

test('SVC-02: WeChat accepted but is not yet showing it → PENDING_VERIFY, never a blind re-upload', async () => {
  const { sync, state, calls } = service({}, { verify: { errcode: 0, order: { order_state: 1 } } })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  assert.equal(state.row.status, 'PENDING_VERIFY')

  for (let i = 0; i < 3; i++) {
    state.claimable = true
    await sync.tick()
  }
  assert.equal(uploadCalls(calls).length, 1, '核实未过期间绝不允许无脑重传')
  assert.equal(verifyCalls(calls).length, 3)
  assert.equal(state.row.status, 'PENDING_VERIFY')
  assert.match(state.row.lastError, /SHIPPING_VERIFY_PENDING/)
})

test('SVC-03: after the verification budget is exhausted the row may re-upload once, then verify', async () => {
  // 核实预算 = 3。第 1 次上传，第 2-4 次核实，第 5 次才轮到受控重传。
  const stuck = service({}, { verify: { errcode: 0, order: { order_state: 1 } } })
  await stuck.sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 4; i++) { stuck.state.claimable = true; await stuck.sync.tick() }
  assert.equal(uploadCalls(stuck.calls).length, 1, '核实预算内绝不允许重传')
  assert.equal(verifyCalls(stuck.calls).length, 3)

  stuck.state.claimable = true
  await stuck.sync.tick()
  assert.equal(uploadCalls(stuck.calls).length, 2, '预算用尽后允许一次受控重传（内容不变 ⇒ 微信判定未更新）')
  assert.equal(stuck.state.row.status, 'PENDING_VERIFY')
  assert.equal(stuck.state.row.verifyAttempts, 0, '重传成功后核实预算归零')

  // 重传 → 核实成功 → SYNCED
  const recovered = service({}, { verify: VERIFY_SHIPPED })
  await recovered.sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 5; i++) { recovered.state.claimable = true; await recovered.sync.tick() }
  assert.equal(recovered.state.row.status, 'SYNCED')
  assert.equal((await recovered.sync.status(SETTLEMENT)).synced, true)
})

test('SVC-04: a permanent WeChat rejection ends as FAILED with the real errcode recorded', async () => {
  const { sync, state } = service({}, { upload: { errcode: 10060005 } })
  await sync.register({ settlementId: SETTLEMENT })
  assert.equal((await sync.tick()).failed, 1)
  assert.equal(state.row.status, 'FAILED')
  assert.equal(state.row.lastError, 'SHIPPING_UPLOAD_REJECTED_10060005')
})

test('SVC-05: a Sweet Card-only settlement is UNSUPPORTED and WeChat is never called', async () => {
  const { sync, state, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', quoteId: 'q1', tenders: [] } })
  await sync.register({ settlementId: SETTLEMENT })
  assert.equal((await sync.tick()).unsupported, 1)
  assert.equal(calls.length, 0, '没有真实微信支付单就绝不调用微信')
  assert.equal(state.row.status, 'UNSUPPORTED')
  assert.equal(state.row.lastError, 'SHIPPING_UNSUPPORTED_NO_WECHAT_TRANSACTION')
  assert.equal((await sync.status(SETTLEMENT)).synced, false)
})

test('SVC-06: a mixed settlement uses the real SUCCEEDED WECHAT transaction, never the Sweet Card part', async () => {
  const tenders = [
    { type: 'SWEET_CARD', status: 'SUCCEEDED', providerTransactionId: null },
    { type: 'WECHAT', status: 'PENDING', providerTransactionId: '4200003-pending' },
    { type: 'WECHAT', status: 'SUCCEEDED', providerTransactionId: TRANSACTION },
  ]
  const { sync, calls } = service({ settlement: { id: SETTLEMENT, userId: 'u1', quoteId: 'q1', tenders } })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  assert.equal(uploadCalls(calls)[0].body.order_key.transaction_id, TRANSACTION)

  // 只有未成功的微信 tender → 视为无真实支付单
  const none = service({
    settlement: { id: SETTLEMENT, userId: 'u1', quoteId: 'q1', tenders: [{ type: 'WECHAT', status: 'PENDING', providerTransactionId: '4200003-pending' }] },
  })
  await none.sync.register({ settlementId: SETTLEMENT })
  assert.equal((await none.sync.tick()).unsupported, 1)
  assert.equal(none.calls.length, 0)
})

test('SVC-07 / #10: a missing buyer identity is a hard failure, never a fabricated openid', async () => {
  const { sync, state, calls } = service({ identity: null })
  await sync.register({ settlementId: SETTLEMENT })
  assert.equal((await sync.tick()).failed, 1)
  assert.equal(state.row.lastError, 'SHIPPING_OPENID_MISSING')
  assert.equal(calls.length, 0)
})

test('SVC-09: an item description always exists and is truncated to the 120-character limit', () => {
  assert.equal(buildItemDesc([{ name: '92%生巧克力', quantity: 2 }]), '92%生巧克力*2')
  assert.equal(buildItemDesc([{ name: 'A', quantity: 1 }, { name: 'B', quantity: 3 }]), 'A*1; B*3')
  const long = buildItemDesc([{ name: 'x'.repeat(200), quantity: 1 }])
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('...'))
  assert.equal(buildItemDesc([]), '')
  assert.equal(buildItemDesc(null), '')

  // 快照缺失 → FAILED，绝不用空 item_desc 去撞 10060008
  const broken = service({ quote: { snapshot: { lines: [] } } })
  return broken.sync.register({ settlementId: SETTLEMENT })
    .then(() => broken.sync.tick())
    .then(() => {
      assert.equal(broken.state.row.status, 'FAILED')
      assert.equal(broken.state.row.lastError, 'SHIPPING_ITEM_DESC_MISSING')
      assert.equal(broken.calls.length, 0)
    })
})

test('SVC-10: 顺丰 requires a contact; a missing one stays PENDING instead of inventing a number', async () => {
  const { sync, state, calls } = service({ trace: null })
  await sync.register({ settlementId: SETTLEMENT })
  assert.equal((await sync.tick()).pending, 1)
  // 尚未上传过，所以必须留在 PENDING_UPLOAD（可重试上传），而不是 PENDING_VERIFY
  assert.equal(state.row.status, 'PENDING_UPLOAD')
  assert.equal(state.row.lastError, 'SHIPPING_CONTACT_PENDING_SF')
  assert.equal(calls.length, 0, '没有联系方式就不调用微信')

  // 号码后到 → 正常上传（说明它没有被打进「只核实不重传」的路径）
  state.claimable = true
  const late = service({ trace: { receiverPhone: '13911112222' } }, { verify: VERIFY_SHIPPED })
  await late.sync.register({ settlementId: SETTLEMENT })
  await late.sync.tick()
  assert.equal(uploadCalls(late.calls).length, 1)
  assert.equal(uploadCalls(late.calls)[0].body.shipping_list[0].contact.receiver_contact, '139****2222')

  // 非顺丰承运商不需要联系方式
  const other = service({ authorization: { ...AUTHORIZATION, carrierCode: 'YTO' }, trace: null }, { verify: VERIFY_SHIPPED })
  await other.sync.register({ settlementId: SETTLEMENT })
  await other.sync.tick()
  assert.equal(uploadCalls(other.calls).length, 1)
})

test('SVC-11: REFUNDED at WeChat becomes UNSUPPORTED, and MISMATCH never becomes SYNCED', async () => {
  const refunded = service({}, { verify: { errcode: 0, order: { order_state: 5 } } })
  await refunded.sync.register({ settlementId: SETTLEMENT })
  await refunded.sync.tick()
  refunded.state.claimable = true
  assert.equal((await refunded.sync.tick()).unsupported, 1)
  assert.equal(refunded.state.row.lastError, 'SHIPPING_ORDER_STATE_REFUNDED')

  const mismatch = service({}, {
    verify: { errcode: 0, order: { order_state: 2, shipping: { logistics_type: 1, finish_shipping: true, shipping_list: [{ tracking_no: 'YTO9999' }] } } },
  })
  await mismatch.sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 5; i++) { mismatch.state.claimable = true; await mismatch.sync.tick() }
  assert.notEqual(mismatch.state.row.status, 'SYNCED', '别人的运单绝不能被算成我们同步成功')
  assert.equal(mismatch.state.row.lastError, 'SHIPPING_VERIFY_MISMATCH')
})

test('CON-01: the claim is a lease — a second worker cannot take a row that is already leased', async () => {
  const { sync, state } = service({}, { verify: VERIFY_SHIPPED })
  await sync.register({ settlementId: SETTLEMENT })
  // 第一次 tick 认领并释放（内存桩在每次 settle 时清 lease）；verifying 期间过期由 SQL 保证。
  assert.equal((await sync.tick()).scanned, 1)
  const claims = state.statements.length
  assert.ok(claims > 0)
  // 租约由 SQL 的 lease_until + SKIP LOCKED 保证；这里断言语句确实带上了租约与归属校验。
  const guard = state.statements.find(s => s.sql.includes('lease_owner = §'))
  assert.ok(guard, '每一次 settle 都必须带 lease_owner 归属校验（fencing）')
  for (const statement of state.statements) {
    assert.match(statement.sql, /lease_owner = §/, '缺少 fencing 的 UPDATE 一旦过期 worker 回来就会改写')
  }
})

test('SAFE-01: the sync never throws, whatever WeChat or the database does', async () => {
  // 微信整体不可达
  const down = service({}, { upload: { __transport: true }, verify: { __transport: true } })
  await down.sync.register({ settlementId: SETTLEMENT })
  const first = await down.sync.tick()
  assert.equal(first.pending, 1)
  assert.equal(down.state.row.status, 'PENDING_VERIFY')
  assert.equal(down.state.row.lastError, 'SHIPPING_UPLOAD_AMBIGUOUS')
  assert.equal(uploadCalls(down.calls).length, 1)

  // 歧义之后的下一轮必须先核实，不得直接重传
  down.state.claimable = true
  await down.sync.tick()
  assert.equal(uploadCalls(down.calls).length, 1, '歧义失败后必须先 get_order 核实')
  assert.equal(verifyCalls(down.calls).length, 1)

  // 结算行在我方消失
  const gone = service({ settlement: null })
  await assert.rejects(() => gone.sync.register({ settlementId: SETTLEMENT }), /订单不存在/)

  // 客户端直接抛异常，tick 也必须吞掉并记为 pending，绝不冒泡到商家请求
  const { state, prisma } = store()
  const exploding = createOnlineWechatShippingSync(prisma, {
    appId: APP_ID,
    shipping: {
      upload: async () => { throw new Error('EXPLODED') },
      verify: async () => { throw new Error('EXPLODED') },
    },
  })
  await exploding.register({ settlementId: SETTLEMENT })
  const summary = await exploding.tick()
  assert.equal(summary.pending, 1)
  assert.equal(state.row.status, 'PENDING_UPLOAD', '异常不得把行推进成终态')
})

test('SAFE-02: the sync only ever reads the settlement, never writes a financial fact', async () => {
  const { sync, state } = service({}, { verify: VERIFY_SHIPPED })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  state.claimable = true
  await sync.tick()
  for (const statement of state.statements) {
    assert.match(statement.sql, /UPDATE online_wechat_shipping_sync\b/, '只允许写本表')
    for (const table of ['online_settlements', 'online_tenders', 'online_refunds', 'online_fulfillment_authorizations',
      'online_logistics_traces', 'sweet_card_accounts', 'sweet_card_ledger']) {
      assert.equal(statement.sql.includes(`UPDATE ${table}`), false, `不得写 ${table}`)
    }
  }
})

test('SAFE-03: a row that reached a terminal state is never claimed again', async () => {
  for (const terminal of ['SYNCED', 'UNSUPPORTED', 'FAILED']) {
    const { sync, state } = service()
    await sync.register({ settlementId: SETTLEMENT })
    state.row.status = terminal
    assert.equal((await sync.tick()).scanned, 0, `${terminal} 行不可被 claim`)
  }
})

// ===========================================================================
// D. FIX 轮次回归（对应 Review 的 4 个问题）
// ===========================================================================

test('FIX1-01: the verify counter is advanced by real SQL, never by a bound expression string', async () => {
  const { sync, state } = service({}, { verify: { errcode: 0, order: { order_state: 1 } } })
  await sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 4; i++) { state.claimable = true; await sync.tick() }

  const settles = state.statements.filter(s => s.sql.includes("SET status = 'PENDING_VERIFY'"))
  assert.ok(settles.length >= 3, '应当发生过多次转入 PENDING_VERIFY 的结算')
  const fresh = settles.filter(s => s.sql.includes('verify_attempts = 0'))
  const increments = settles.filter(s => s.sql.includes('verify_attempts = verify_attempts + 1'))
  assert.equal(fresh.length, 1, '恰好一次「刚从上传转入核实」')
  assert.ok(increments.length >= 2, '其余都必须是自增分支')
  // 关键：没有任何一次把表达式当绑定参数
  for (const s of settles) {
    assert.equal(s.sql.includes('verify_attempts = §'), false, '不得把表达式留成绑定占位符')
    for (const v of s.values) {
      assert.equal(typeof v === 'string' && v.includes('verify_attempts'), false,
        `绑定参数里不得出现 SQL 表达式：${String(v)}`)
    }
  }
})

test('FIX2-01: toWechatReceiverContact masks a mainland mobile and is idempotent, else fails closed', async () => {
  const { toWechatReceiverContact } = await import('../server/wechat-shipping-info.js')
  assert.equal(toWechatReceiverContact('13800000000'), '138****0000', '官方示例形态：前 3 + 后 4')
  assert.equal(toWechatReceiverContact(' 18612345678 '), '186****5678')
  assert.equal(toWechatReceiverContact('138****0000'), '138****0000', '已是掩码必须幂等')
  for (const bad of ['', '   ', null, undefined, '12345', '021-12345678', '1380000000', '138000000000',
    '23800000000', '+8613800000000', '138-0000-0000', '****0000', '1380000****']) {
    assert.equal(toWechatReceiverContact(bad), '', `${String(bad)} 必须 fail closed`)
  }
})

test('FIX2-02: the raw phone never leaves the process, the masked one is what WeChat receives', async () => {
  const { sync, calls } = service({}, { verify: VERIFY_SHIPPED })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  const sent = uploadCalls(calls)[0].body
  assert.equal(sent.shipping_list[0].contact.receiver_contact, '138****0000')
  assert.equal(JSON.stringify(sent).includes('13800000000'), false)
})

test('FIX2-03: an unmaskable 顺丰 contact fails closed without ever calling WeChat', async () => {
  const { sync, state, calls } = service({ trace: { receiverPhone: '021-12345678' } })
  await sync.register({ settlementId: SETTLEMENT })
  assert.equal((await sync.tick()).failed, 1)
  assert.equal(state.row.status, 'FAILED')
  assert.equal(state.row.lastError, 'SHIPPING_CONTACT_INVALID_FORMAT')
  assert.equal(calls.length, 0)
  assert.equal(JSON.stringify(state.row).includes('021-12345678'), false, '完整号码不得进错误信息')
})

test('FIX3-01: the re-upload budget is claimed atomically and consumed at most once', async () => {
  const { sync, state, calls } = service({}, { verify: { errcode: 0, order: { order_state: 1 } } })
  await sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 12; i++) { state.claimable = true; await sync.tick() }

  const claims = state.statements.filter(s => s.kind === 'claimReupload')
  assert.ok(claims.length >= 1, '核实预算用尽后应当尝试赢取重传许可')
  for (const c of claims) {
    assert.match(c.sql, /AND reupload_count = 0/, '许可必须带 reupload_count = 0 条件')
    assert.match(c.sql, /RETURNING reupload_count/)
  }
  assert.equal(calls.filter(c => c.url.includes('upload_shipping_info')).length, 2, '首次 + 一次重传')
  assert.equal(state.row.reuploadCount, 1, '预算不可回退、不可重复消费')
})

test('FIX3-02: after the budget is spent only verification continues (no third upload)', async () => {
  const { sync, state, calls } = service({}, { verify: { errcode: 0, order: { order_state: 1 } } })
  await sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 12; i++) { state.claimable = true; await sync.tick() }
  const uploads = calls.filter(c => c.url.includes('upload_shipping_info')).length
  for (let i = 0; i < 6; i++) { state.claimable = true; await sync.tick() }
  assert.equal(calls.filter(c => c.url.includes('upload_shipping_info')).length, uploads,
    '预算用尽后 upload 次数必须冻结')
  assert.equal(state.row.reuploadCount, 1)
})

test('FIX3-03: a second worker instance over the same row cannot re-upload', async () => {
  const { state, prisma } = store()
  const { impl, calls } = stubFetch({ verify: { errcode: 0, order: { order_state: 1 } } })
  _resetMiniprogramTokenAuthority()
  const shipping = createWechatShippingInfo({ config: CONFIG, fetchImpl: impl, now: () => 1 })
  const a = createOnlineWechatShippingSync(prisma, { shipping, appId: APP_ID })
  await a.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 12; i++) { state.claimable = true; await a.tick() }
  const uploads = calls.filter(c => c.url.includes('upload_shipping_info')).length
  assert.equal(uploads, 2)

  // 「换实例」：同一张表上的全新 service
  const b = createOnlineWechatShippingSync(prisma, { shipping, appId: APP_ID })
  for (let i = 0; i < 6; i++) { state.claimable = true; await b.tick() }
  assert.equal(calls.filter(c => c.url.includes('upload_shipping_info')).length, uploads)
  assert.equal(state.row.reuploadCount, 1)
})

test('FIX3-04: a concurrent second claim of the budget is refused', async () => {
  const { sync, state, prisma } = service()
  await sync.register({ settlementId: SETTLEMENT })
  state.row.status = 'PENDING_VERIFY'
  state.row.leaseOwner = 'lease-owner-1'
  const grant = () => prisma.$queryRaw`
    UPDATE online_wechat_shipping_sync SET reupload_count = reupload_count + 1
    WHERE id = ${state.row.id} AND lease_owner = ${'lease-owner-1'}
      AND status = 'PENDING_VERIFY' AND reupload_count = 0
    RETURNING reupload_count`
  const [first, second] = await Promise.all([grant(), grant()])
  assert.equal([first, second].filter(r => r.length > 0).length, 1, '并发许可只能有一个成功')
  assert.equal(state.row.reuploadCount, 1)
})

test('FIX4-01: the merchant /fulfill registers both DELIVERY and PICKUP without gating the response', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync(new URL('../server/online-merchant-api.js', import.meta.url), 'utf8')
  // 官方支持 logistics_type=4「用户自提」，商家「确认取货」同样要录入发货信息。
  assert.equal(source.includes("receipt.method === 'DELIVERY') {\n      try {"), false,
    '不得再按 method 限制登记')
  assert.ok(source.includes('if (shippingSync) {'), '登记必须无条件进行（两种履约都登记）')
  assert.ok(source.includes('await shippingSync.register({ settlementId: s.id })'))
  // 登记必须被 try/catch 包住，绝不 gate、绝不抛出、绝不改返回
  const call = source.indexOf('await shippingSync.register(')
  const guard = source.lastIndexOf('try {', call)
  assert.ok(guard > 0 && call - guard < 60, 'register 必须紧跟在 try 内')
  assert.ok(source.indexOf('catch (error) {', call) > call)
})


// ===========================================================================
// E. 第三轮 FIX — Fix A（PENDING 必须区分 ambiguous）/ Fix B（PICKUP 接入官方自提）
// ===========================================================================

test('FIXA-01: a token that could never be obtained keeps the row on PENDING_UPLOAD', async () => {
  // 根本没拿到 access_token ⇒ 压根没调用 upload_shipping_info ⇒ 绝不是「可能已收下」
  const { sync, state, calls } = service({}, { token: { errcode: 40013, errmsg: 'invalid appid' } })
  await sync.register({ settlementId: SETTLEMENT })
  assert.equal((await sync.tick()).pending, 1)
  assert.equal(state.row.status, 'PENDING_UPLOAD', '未上传成功必须留在首次上传路径')
  assert.equal(state.row.verifyAttempts, 0, '不得增加 verify_attempts')
  assert.equal(state.row.reuploadCount, 0, '不得消耗唯一一次受控重传预算')
  assert.equal(uploadCalls(calls).length, 0, '不应调用 upload endpoint')
  assert.equal(verifyCalls(calls).length, 0, '更不应进入核实路径')
  assert.match(state.row.lastError, /SHIPPING_UPLOAD_RETRY_/)
})

test('FIXA-02: once the token recovers the FIRST upload happens and still is not a re-upload', async () => {
  let healthy = false
  const { sync, state, calls } = service({}, {
    token: () => (healthy ? { errcode: 0, access_token: 'TOK-recovered', expires_in: 7200 } : { errcode: 40013 }),
  })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  assert.equal(state.row.status, 'PENDING_UPLOAD')

  healthy = true
  state.claimable = true
  await sync.tick()
  assert.equal(uploadCalls(calls).length, 1, 'token 恢复后正常发生第一次上传')
  assert.equal(state.row.status, 'PENDING_VERIFY')
  assert.equal(state.row.reuploadCount, 0, '第一次上传不算 reupload')
  assert.equal(state.row.verifyAttempts, 0)
})

test('FIXA-03: an explicit retryable rejection stays on PENDING_UPLOAD and does not burn the budget', async () => {
  for (const code of [-1, 10060012, 10060019, 10060001]) {
    const { sync, state, calls } = service({}, { upload: { errcode: code } })
    await sync.register({ settlementId: SETTLEMENT })
    assert.equal((await sync.tick()).pending, 1)
    assert.equal(state.row.status, 'PENDING_UPLOAD', `errcode ${code} 是「未接受」，必须留在首次上传路径`)
    assert.equal(state.row.verifyAttempts, 0)
    assert.equal(state.row.reuploadCount, 0, '重试首次上传不得消耗受控重传预算')
    assert.equal(verifyCalls(calls).length, 0)
    assert.equal(state.row.lastError, `SHIPPING_UPLOAD_RETRY_${code}`)

    // 之后再试仍然按「首次上传」处理
    state.claimable = true
    await sync.tick()
    assert.equal(uploadCalls(calls).length, 2, '可以正常重试首次上传')
    assert.equal(state.row.reuploadCount, 0)
  }
})

test('FIXA-04: only a transport-ambiguous failure enters PENDING_VERIFY', async () => {
  const { sync, state, calls } = service({}, { upload: { __transport: true } })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  assert.equal(state.row.status, 'PENDING_VERIFY', '超时/重置 ⇒ 微信可能已收下 ⇒ 先核实')
  assert.equal(state.row.lastError, 'SHIPPING_UPLOAD_AMBIGUOUS')
  assert.equal(state.row.verifyAttempts, 0)
  assert.equal(state.row.reuploadCount, 0)

  // 下一轮必须先 get_order，不得直接重传
  state.claimable = true
  await sync.tick()
  assert.equal(uploadCalls(calls).length, 1)
  assert.equal(verifyCalls(calls).length, 1)
})

test('FIXA-05: the three PENDING outcomes are actually distinguishable end to end', async () => {
  const tokenGone = service({}, { token: { errcode: 40013 } })
  const retryable = service({}, { upload: { errcode: -1 } })
  const ambiguous = service({}, { upload: { __transport: true } })
  for (const s of [tokenGone, retryable, ambiguous]) {
    await s.sync.register({ settlementId: SETTLEMENT })
    await s.sync.tick()
  }
  assert.equal(tokenGone.state.row.status, 'PENDING_UPLOAD')
  assert.equal(retryable.state.row.status, 'PENDING_UPLOAD')
  assert.equal(ambiguous.state.row.status, 'PENDING_VERIFY')
})

test('FIXB-01: the PICKUP payload uses the official self-pickup mode and fabricates nothing', async () => {
  const { sync, calls } = service({
    authorization: { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null },
  })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  assert.equal(uploadCalls(calls).length, 1)
  const sent = uploadCalls(calls)[0].body
  assert.equal(sent.logistics_type, 4, '官方 4 = 用户自提')
  assert.equal(sent.delivery_mode, 1, '官方：分拆发货仅支持物流快递 ⇒ 自提只能统一发货')
  assert.equal(sent.is_all_delivered, undefined)
  assert.equal(sent.order_key.transaction_id, TRANSACTION, '真实 WECHAT tender')
  assert.equal(sent.payer.openid, 'oPENID-buyer', '真实 identity')
  assert.equal(sent.shipping_list.length, 1)
  assert.deepEqual(sent.shipping_list[0], { item_desc: '92%生巧克力*1' })
  assert.equal('tracking_no' in sent.shipping_list[0], false, '不得伪造运单号')
  assert.equal('express_company' in sent.shipping_list[0], false, '不得伪造快递公司')
  assert.equal('contact' in sent.shipping_list[0], false, '不得伪造联系方式')
  assert.equal(sent.upload_time, '2026-09-24T10:05:06.789+08:00')
})

test('FIXB-02: PICKUP never reads OnlineLogisticsTrace', async () => {
  const pickup = service({ authorization: { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null }, trace: null })
  await pickup.sync.register({ settlementId: SETTLEMENT })
  await pickup.sync.tick()
  assert.equal(pickup.state.traceLookups, 0, '自提既不需要运单也不需要收件人联系方式')

  const delivery = service({ trace: null })
  await delivery.sync.register({ settlementId: SETTLEMENT })
  await delivery.sync.tick()
  assert.equal(delivery.state.traceLookups, 1, '顺丰快递仍然需要读边缘事实')
})

test('FIXB-03: PICKUP verify confirms WeChat actually recorded self-pickup', async () => {
  const shipped = {
    errcode: 0,
    order: { transaction_id: TRANSACTION, order_state: 2,
      shipping: { logistics_type: 4, delivery_mode: 1, finish_shipping: true, shipping_list: [] } },
  }
  const ok = service({ authorization: { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null } }, { verify: shipped })
  await ok.sync.register({ settlementId: SETTLEMENT })
  await ok.sync.tick()
  ok.state.claimable = true
  assert.equal((await ok.sync.tick()).synced, 1)
  assert.equal(ok.state.row.status, 'SYNCED')

  // 微信已发货，但记成的是快递而不是自提 ⇒ 绝不 SYNCED
  const wrongMode = service({ authorization: { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null } },
    { verify: { errcode: 0, order: { order_state: 2, shipping: { logistics_type: 1, finish_shipping: true } } } })
  await wrongMode.sync.register({ settlementId: SETTLEMENT })
  await wrongMode.sync.tick()
  wrongMode.state.claimable = true
  await wrongMode.sync.tick()
  assert.notEqual(wrongMode.state.row.status, 'SYNCED')
  assert.equal(wrongMode.state.row.lastError, 'SHIPPING_VERIFY_MISMATCH')

  // 还没进入发货状态 / finish_shipping 未完成 ⇒ 继续等
  const notYet = service({ authorization: { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null } },
    { verify: { errcode: 0, order: { order_state: 1, shipping: { logistics_type: 4, finish_shipping: false } } } })
  await notYet.sync.register({ settlementId: SETTLEMENT })
  await notYet.sync.tick()
  notYet.state.claimable = true
  await notYet.sync.tick()
  assert.equal(notYet.state.row.status, 'PENDING_VERIFY')
})

test('FIXB-04: a DELIVERY payload is unaffected by the mode-aware builder', async () => {
  const { sync, calls } = service({}, { verify: VERIFY_SHIPPED })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  const sent = uploadCalls(calls)[0].body
  assert.equal(sent.logistics_type, 1)
  assert.equal(sent.delivery_mode, 1)
  assert.equal(sent.shipping_list[0].tracking_no, TRACKING)
  assert.equal(sent.shipping_list[0].express_company, 'SF')
  assert.deepEqual(sent.shipping_list[0].contact, { receiver_contact: '138****0000' })
})

test('FIXB-05: a DELIVERY verify that WeChat records as self-pickup is a MISMATCH', async () => {
  const { sync, state } = service({}, {
    verify: { errcode: 0, order: { order_state: 2, shipping: { logistics_type: 4, finish_shipping: true,
      shipping_list: [{ tracking_no: TRACKING, express_company: 'SF' }] } } },
  })
  await sync.register({ settlementId: SETTLEMENT })
  await sync.tick()
  state.claimable = true
  await sync.tick()
  assert.notEqual(state.row.status, 'SYNCED', '微信记的是自提，不是我们的快递')
  assert.equal(state.row.lastError, 'SHIPPING_VERIFY_MISMATCH')
})

test('FIXB-06: the fingerprint separates DELIVERY from PICKUP for the same settlement', async () => {
  const { state, prisma } = store()
  const { impl } = stubFetch({})
  _resetMiniprogramTokenAuthority()
  const sync = createOnlineWechatShippingSync(prisma, {
    appId: APP_ID, shipping: createWechatShippingInfo({ config: CONFIG, fetchImpl: impl, now: () => 1 }),
  })
  await sync.register({ settlementId: SETTLEMENT })
  const deliveryFingerprint = state.row.payloadFingerprint
  // 同一 settlement 上换成自提履约事实 ⇒ 指纹必须不同，且必须被拒绝覆盖
  state.authorization = { ...AUTHORIZATION, method: 'PICKUP', carrierCode: null, trackingNo: null }
  await assert.rejects(() => sync.register({ settlementId: SETTLEMENT }), /冲突/)
  assert.equal(state.row.payloadFingerprint, deliveryFingerprint, '既成指纹不得被改写')
})

// ===========================================================================
// F. 第四轮 FIX — DELIVERY verify 不得过早 SYNCED（严格终态判据 D1–D7）
// ===========================================================================

/** 一条「快递事实完全正确」的 get_order 响应；各用例只覆盖自己关心的那一个字段。 */
const ORDER_OK = (over = {}) => ({
  errcode: 0,
  order: {
    transaction_id: TRANSACTION,
    order_state: 2,
    ...over,
    shipping: { logistics_type: 1, delivery_mode: 1, finish_shipping: true,
      shipping_list: [{ tracking_no: TRACKING, express_company: 'SF' }], ...(over.shipping || {}) },
  },
})

const verifyOnce = async outcome =>
  client({ verify: outcome }).shipping.verify({ transactionId: TRANSACTION, method: 'DELIVERY',
    trackingNo: TRACKING, deliveryId: 'SF' })

test('D1: 运单已出现但 order_state 还没到发货态 ⇒ PENDING（eventual consistency）', async () => {
  assert.deepEqual(await verifyOnce(ORDER_OK({ order_state: 1 })), { status: 'PENDING', code: 0 })
})

test('D2: 已发货、运单正确，但 finish_shipping=false ⇒ PENDING', async () => {
  assert.deepEqual(await verifyOnce(ORDER_OK({ shipping: { finish_shipping: false } })),
    { status: 'PENDING', code: 0 })
  // 字段缺失同样只是「还没回全」，不得当作已完成
  const absent = ORDER_OK({ shipping: {} })
  delete absent.order.shipping.finish_shipping
  assert.deepEqual(await verifyOnce(absent), { status: 'PENDING', code: 0 })
})

test('D3: 微信把这一单记成自提，即使运单看似正确 ⇒ MISMATCH', async () => {
  assert.deepEqual(await verifyOnce(ORDER_OK({ shipping: { logistics_type: 4 } })),
    { status: 'MISMATCH', code: 0 })
})

test('D4: 运单号正确但快递公司不是我们的 ⇒ MISMATCH', async () => {
  assert.deepEqual(await verifyOnce(ORDER_OK({
    shipping: { shipping_list: [{ tracking_no: TRACKING, express_company: 'YTO' }] },
  })), { status: 'MISMATCH', code: 0 })
})

test('D5: 快递公司字段缺失 ⇒ PENDING，绝不 SYNCED', async () => {
  assert.deepEqual(await verifyOnce(ORDER_OK({
    shipping: { shipping_list: [{ tracking_no: TRACKING }] },
  })), { status: 'PENDING', code: 0 })
  assert.deepEqual(await verifyOnce(ORDER_OK({
    shipping: { shipping_list: [{ tracking_no: TRACKING, express_company: '' }] },
  })), { status: 'PENDING', code: 0 })
})

test('D6: 五条同时成立 ⇒ SHIPPED', async () => {
  assert.deepEqual(await verifyOnce(ORDER_OK()), { status: 'SHIPPED', code: 0 })
})

test('D7: 更后续的合法状态（确认收货/交易完成/资金待结算）仍可 SHIPPED', async () => {
  for (const order_state of [3, 4, 6]) {
    assert.deepEqual(await verifyOnce(ORDER_OK({ order_state })), { status: 'SHIPPED', code: 0 },
      `order_state=${order_state} 属于 post-shipment 集合`)
  }
})

test('D8/E: 已发货但没有我们的运单 ⇒ MISMATCH；连运单条目都没有 ⇒ PENDING', async () => {
  // 别人的运单占用了这笔支付单
  assert.deepEqual(await verifyOnce(ORDER_OK({
    shipping: { shipping_list: [{ tracking_no: 'YTO9999', express_company: 'YTO' }] },
  })), { status: 'MISMATCH', code: 0 })
  // 一条都没有 ⇒ 字段还没回全，继续等而不是判死
  assert.deepEqual(await verifyOnce(ORDER_OK({ shipping: { shipping_list: [] } })),
    { status: 'PENDING', code: 0 })
  const noList = ORDER_OK({ shipping: {} })
  delete noList.order.shipping.shipping_list
  assert.deepEqual(await verifyOnce(noList), { status: 'PENDING', code: 0 })
})

test('D9: 字段还没回全（没有 logistics_type）⇒ PENDING，不得因为缺失而认定成功', async () => {
  const noMode = ORDER_OK({ shipping: {} })
  delete noMode.order.shipping.logistics_type
  assert.deepEqual(await verifyOnce(noMode), { status: 'PENDING', code: 0 })
})

test('D10: 宽松匹配已彻底移除 —— 字段缺失绝不再算命中', async () => {
  const fs = await import('node:fs')
  const source = fs.readFileSync(new URL('../server/wechat-shipping-info.js', import.meta.url), 'utf8')
  assert.equal(source.includes('!entry.express_company'), false,
    '旧的宽松判断 (… || !entry.express_company || …) 必须已被删除')
  assert.ok(source.includes('entry.express_company === deliveryId'), '必须是严格相等')
  assert.ok(source.includes('shipping.finish_shipping !== true'), 'finish_shipping 必须被强制校验')
})

test('D11: 上面的判据在状态机层面同样成立 —— D1/D5 都到不了 SYNCED', async () => {
  for (const label of ['D1', 'D5']) {
    const outcome = label === 'D1'
      ? ORDER_OK({ order_state: 1 })
      : ORDER_OK({ shipping: { shipping_list: [{ tracking_no: TRACKING }] } })
    const { sync, state } = service({}, { verify: outcome })
    await sync.register({ settlementId: SETTLEMENT })
    for (let i = 0; i < 6; i++) { state.claimable = true; await sync.tick() }
    assert.notEqual(state.row.status, 'SYNCED', `${label} 不得 SYNCED`)
  }
  // 对照组：完全正确时必须真的能 SYNCED
  const ok = service({}, { verify: ORDER_OK() })
  await ok.sync.register({ settlementId: SETTLEMENT })
  for (let i = 0; i < 3; i++) { ok.state.claimable = true; await ok.sync.tick() }
  assert.equal(ok.state.row.status, 'SYNCED')
})
