/**
 * WeChat 小程序「发货信息管理」client: upload_shipping_info + get_order.
 *
 * This is the ONLY place that talks to WeChat's 交易管理 (wxa/sec/order) API. It
 * is deliberately separate from server/wechat-logistics.js: that module reports
 * a 运单 for 物流轨迹 (trace_waybill), this one records 发货信息 so the payment
 * can settle. Same shipment, two independent WeChat capabilities, two
 * independent states (see online-wechat-shipping-sync.js).
 *
 * Hard rules encoded here:
 *  - The MiniProgram access_token comes from server/wechat-access-token.js.
 *    There is no token cache in this file; a second cache for the same appid
 *    would let WeChat invalidate the token the other consumers are holding.
 *  - The token and the AppSecret are never returned, logged, or placed in an
 *    error message.
 *  - Every fact in the payload (transaction id, openid, delivery id, waybill,
 *    item description, shipment time) is caller-supplied and authoritative.
 *    This module never derives, guesses or synthesises any of them.
 *  - The response is the only source of truth for acceptance. A transport
 *    failure is reported as ambiguous, never as success and never as rejection.
 *
 * Contract source (verified 2026-09-24, read from developers.weixin.qq.com):
 *   POST /wxa/sec/order/upload_shipping_info
 *   POST /wxa/sec/order/get_order
 */
import { miniprogramAccessToken, invalidateMiniprogramToken } from './wechat-access-token.js'
import { shippingCarrierRequiresContact } from './wechat-delivery-codes.js'

/**
 * 微信官方 `logistics_type` 枚举（upload_shipping_info 文档原文）：
 *   1、实体物流配送采用快递公司进行实体物流配送形式
 *   2、同城配送
 *   3、虚拟商品，例如话费充值、点卡等，无实体配送形式
 *   4、用户自提
 *
 * 我们只用 1 与 4；2/3 不在 BUDU 的业务里。这是该枚举的**唯一**权威定义处。
 */
export const LOGISTICS_TYPE_EXPRESS = 1
export const LOGISTICS_TYPE_SELF_PICKUP = 4

const UPLOAD_ENDPOINT = 'https://api.weixin.qq.com/wxa/sec/order/upload_shipping_info'
const GET_ORDER_ENDPOINT = 'https://api.weixin.qq.com/wxa/sec/order/get_order'

const TOKEN_CODES = new Set([40001, 40014, 42001])
// WeChat documents -1 as "系统繁忙，此时请开发者稍候再试"; 10060012/10060019 are
// documented the same way. 10060001 (支付单不存在) is also transient in practice:
// WeChat ingests the payment asynchronously, so a freshly paid order can be
// missing for a short while — retrying is correct, giving up is not.
const RETRYABLE_CODES = new Set([-1, 10060012, 10060019, 10060001])
// WeChat already holds this shipment (it was accepted earlier, or the identical
// payload is a documented no-op). These prove WeChat has the information, so the
// caller must verify rather than re-upload — and must never treat them as
// failures, which would lose a shipment WeChat already recorded.
const ALREADY_ACCEPTED_CODES = new Set([10060002, 10060003, 10060023])

// order_state enum: 1 待发货 2 已发货 3 确认收货 4 交易完成 5 已退款 6 资金待结算
const ORDER_STATE_SHIPPED = new Set([2, 3, 4, 6])
const ORDER_STATE_REFUNDED = 5

const DELIVERY_MODE_UNIFIED = 1

function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return ''
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return ''
  }
  return trimmed
}

/**
 * WeChat requires RFC 3339 with milliseconds and an explicit ±HH:mm offset.
 * BUDU is a Beijing business and China has no DST, so the offset is always
 * +08:00 — written explicitly rather than taken from the process timezone,
 * which is UTC inside the container.
 *
 * Returns '' for anything that is not an explicit, positive instant. Notably ''
 * and null must NOT coerce to 0: `new Date(0)` would silently ship a 1970
 * upload_time, which WeChat would accept as a valid RFC 3339 string.
 */
export function toWechatUploadTime(value) {
  let ms
  if (value instanceof Date) {
    ms = value.getTime()
  } else if (typeof value === 'number') {
    ms = value
  } else if (typeof value === 'string' && value.trim()) {
    ms = Number(value)
  } else {
    return ''
  }
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const shifted = new Date(ms + 8 * 3600 * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`
    + `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
    + `.${p(shifted.getUTCMilliseconds(), 3)}+08:00`
}

/**
 * 微信要求 contact 走**掩码传输**，且「最后 4 位数字不能打掩码」。
 *
 * 官方原文（upload_shipping_info，2026-05-09 版）：
 *   receiver_contact「收件人联系方式，采用掩码传输，最后4位数字不能打掩码」
 *   示例值：`189****1234, 021-****1234, ****1234, 0**2-***1234, 0**2-******23-10, ****123-8008`
 *   值限制：0 ≤ value ≤ 1024
 *   contact 为「否（选填）」，但「当发货的物流公司为顺丰时，联系方式为必填」
 *
 * 因此这里只接受两种输入，其余一律 fail closed（返回 ''）：
 *   1. 中国大陆手机号 11 位 `1[3-9]xxxxxxxxx` → 官方主示例形态 `1XX****XXXX`
 *      （保留前 3 位与后 4 位，中间 4 位打星号）
 *   2. 已经是该掩码形态 → 幂等原样返回
 *
 * 刻意**不**处理器号码（如 `021-****1234`）与其它形态：官方示例里它们存在，但各自的
 * 区号/分机规则没有明确文档，自行发明掩码规则正是本任务禁止的「猜」。遇到这类值一律
 * fail closed 并留下明确错误码，由上层的运维补数据，而不是编一个可能被微信静默接受的串。
 *
 * 纯函数：数据库里的 receiverPhone 保持原值，只在发给微信的 payload 构建阶段调用。
 *
 * @returns {string} 可发送的掩码值；'' 表示缺失、不可掩码或非法 ⇒ 调用方必须 fail closed
 */
export function toWechatReceiverContact(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  // 1) 完整大陆手机号 → 掩码
  if (/^1[3-9]\d{9}$/.test(trimmed)) return `${trimmed.slice(0, 3)}****${trimmed.slice(7)}`
  // 2) 已是本函数产出的掩码形态（前 3 位是 1[3-9]，中间恰好 4 个星号，后 4 位数字）→ 幂等
  if (/^1[3-9]\d\*{4}\d{4}$/.test(trimmed)) return trimmed
  return ''
}

/**
 * @param {object}   options.config    `{ appId, appSecret }` for the MiniProgram
 * @param {Function} options.fetchImpl injectable for tests
 * @param {Function} options.now       injectable clock
 */
export function createWechatShippingInfo({ config, fetchImpl = fetch, now = Date.now } = {}) {
  async function call(endpoint, accessToken, payload) {
    const response = await fetchImpl(`${endpoint}?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    if (!response || !response.ok) return { transport: true }
    try {
      return { body: await response.json() }
    } catch {
      return { transport: true }
    }
  }

  /**
   * Run one WeChat call with the shared token authority, refreshing exactly once
   * when WeChat says the token is stale.
   *
   * @returns {Promise<{kind:'body',body:object}|{kind:'transport'}|{kind:'unavailable',code:number}>}
   */
  async function authenticated(endpoint, payload) {
    let accessToken = await miniprogramAccessToken({ config, fetchImpl, now })
    if (!accessToken) return { kind: 'unavailable', code: 0 }
    for (let attempt = 0; attempt < 2; attempt++) {
      let outcome
      try {
        outcome = await call(endpoint, accessToken, payload)
      } catch {
        return { kind: 'transport' }
      }
      if (outcome.transport) return { kind: 'transport' }
      const errcode = Number(outcome.body?.errcode)
      if (TOKEN_CODES.has(errcode) && attempt === 0) {
        invalidateMiniprogramToken(config)
        const refreshed = await miniprogramAccessToken({ config, fetchImpl, now, forceRefresh: true })
        if (!refreshed) return { kind: 'unavailable', code: errcode }
        accessToken = refreshed
        continue
      }
      return { kind: 'body', body: outcome.body || {} }
    }
    return { kind: 'transport' }
  }

  /**
   * 按微信官方契约组装 upload_shipping_info 的 payload。
   *
   * 两种履约的字段需求**不对称**，所以必须分别构造，绝不用 sentinel 填空：
   *
   *   DELIVERY（logistics_type=1）
   *     shipping_list[0] 需要 tracking_no + express_company（官方：「物流快递发货时必填」），
   *     顺丰还需要掩码后的 contact。
   *
   *   PICKUP（logistics_type=4 用户自提）
   *     tracking_no / express_company / contact 一律**省略** —— 官方对这三者都标注
   *     「物流快递发货时必填」，自提既没有承运商也没有运单号，伪造任何一个都是在
   *     往微信写假物流事实。
   *     item_desc 仍然是必填（官方标「是」，且 10060008/10060020 都会因此拒绝）。
   *     delivery_mode 只能是 1：官方注意事项 5 明确「分拆发货仅支持使用物流快递发货」。
   */
  function buildUpload(input) {
    const method = input?.method === 'PICKUP' ? 'PICKUP' : 'DELIVERY'
    const transactionId = text(input?.transactionId, 64)
    const openid = text(input?.openid, 128)
    const itemDesc = text(input?.itemDesc, 120)
    const uploadTime = toWechatUploadTime(input?.uploadTime)

    // Every one of these is a WeChat-mandatory field for BOTH modes. Refusing locally
    // is better than letting WeChat reject the shipment and burn the one re-ship chance.
    if (!transactionId || !openid || !itemDesc || !uploadTime) return null

    if (method === 'PICKUP') {
      return {
        order_key: { order_number_type: 2, transaction_id: transactionId },
        logistics_type: LOGISTICS_TYPE_SELF_PICKUP,
        delivery_mode: DELIVERY_MODE_UNIFIED,
        // 自提也必须有 shipping_list（官方：必填，多重性 [1,15]），但条目里只有商品描述。
        shipping_list: [{ item_desc: itemDesc }],
        upload_time: uploadTime,
        payer: { openid },
      }
    }

    const deliveryId = text(input?.deliveryId, 128)
    const trackingNo = text(input?.trackingNo, 128)
    // 快递缺承运商编码或运单号就本地拒绝（官方 268485226/268485227）。
    if (!deliveryId || !trackingNo) return null
    // 只接受本模块能证明是官方掩码形态的值；原值不做任何形式的拼接或补位。
    const receiverContact = toWechatReceiverContact(input?.receiverContact)
    // 顺丰必填 contact（官方原文），缺失或不可掩码时本地拒绝，绝不上传半成品。
    if (shippingCarrierRequiresContact(deliveryId) && !receiverContact) return null

    const shipping = { tracking_no: trackingNo, express_company: deliveryId, item_desc: itemDesc }
    if (receiverContact) shipping.contact = { receiver_contact: receiverContact }
    return {
      order_key: { order_number_type: 2, transaction_id: transactionId },
      logistics_type: LOGISTICS_TYPE_EXPRESS,
      delivery_mode: DELIVERY_MODE_UNIFIED,
      shipping_list: [shipping],
      upload_time: uploadTime,
      payer: { openid },
    }
  }

  return {
    /** Local pre-flight: what, if anything, would stop this upload. Test-visible. */
    missingUploadFields(input) {
      return buildUpload(input) ? [] : ['UPLOAD_INPUT_INCOMPLETE']
    },

    /**
     * Record (or, per WeChat, no-op) one shipment.
     *
     * @returns {Promise<
     *   {status:'ACCEPTED',code:number}
     * | {status:'ALREADY_ACCEPTED',code:number}
     * | {status:'PENDING',code:number,ambiguous:boolean}
     * | {status:'FAILED',code:number}
     * | {status:'UNSUPPORTED'}>}
     *   Never throws: the shipment already happened and must not be undone by a
     *   WeChat problem. `PENDING` means "try again"; `ambiguous` means WeChat may
     *   already hold the shipment, so the caller must verify before re-uploading.
     */
    async upload(input) {
      const payload = buildUpload(input)
      if (!payload) return { status: 'UNSUPPORTED' }
      const result = await authenticated(UPLOAD_ENDPOINT, payload)
      if (result.kind === 'transport') return { status: 'PENDING', code: 0, ambiguous: true }
      if (result.kind === 'unavailable') return { status: 'PENDING', code: result.code, ambiguous: false }
      const errcode = Number(result.body.errcode)
      if (!Number.isFinite(errcode)) return { status: 'PENDING', code: 0, ambiguous: true }
      if (errcode === 0) return { status: 'ACCEPTED', code: 0 }
      if (ALREADY_ACCEPTED_CODES.has(errcode)) return { status: 'ALREADY_ACCEPTED', code: errcode }
      if (RETRYABLE_CODES.has(errcode)) return { status: 'PENDING', code: errcode, ambiguous: false }
      return { status: 'FAILED', code: errcode }
    },

    /**
     * Ask WeChat whether this payment order is really shipped, and whether OUR
     * waybill is the one on record.
     *
     * @returns {Promise<
     *   {status:'SHIPPED',code:0}
     * | {status:'REFUNDED',code:0}
     * | {status:'PENDING',code:number}
     * | {status:'MISMATCH',code:0}
     * | {status:'FAILED',code:number}>}
     *   `SHIPPED` is the only value that may drive the sync to SYNCED: it means
     *   WeChat itself lists this tracking number for this order.
     */
    async verify({ transactionId, method, trackingNo, deliveryId }) {
      const txn = text(transactionId, 64)
      const mode = method === 'PICKUP' ? 'PICKUP' : 'DELIVERY'
      const waybill = mode === 'DELIVERY' ? text(trackingNo, 128) : ''
      // 快递没有运单号就谈不上核实；自提不看运单号。
      if (!txn) return { status: 'FAILED', code: 0 }
      if (mode === 'DELIVERY' && !waybill) return { status: 'FAILED', code: 0 }

      const result = await authenticated(GET_ORDER_ENDPOINT, { transaction_id: txn })
      if (result.kind === 'transport') return { status: 'PENDING', code: 0 }
      if (result.kind === 'unavailable') return { status: 'PENDING', code: result.code }
      const errcode = Number(result.body.errcode)
      if (!Number.isFinite(errcode)) return { status: 'PENDING', code: 0 }
      if (errcode !== 0) {
        if (RETRYABLE_CODES.has(errcode)) return { status: 'PENDING', code: errcode }
        return { status: 'FAILED', code: errcode }
      }

      const order = result.body.order || {}
      // 官方按 transaction_id 查询；响应带该字段时必须就是这一笔，否则绝不认领。
      if (order.transaction_id && order.transaction_id !== txn) return { status: 'MISMATCH', code: 0 }
      const state = Number(order.order_state)
      if (state === ORDER_STATE_REFUNDED) return { status: 'REFUNDED', code: 0 }
      const shipping = order.shipping || {}
      const logisticsType = Number(shipping.logistics_type)
      const list = Array.isArray(shipping.shipping_list) ? shipping.shipping_list : []

      if (mode === 'PICKUP') {
        // 自提无法用运单号判断，只能按官方 get_order 契约确认：
        //   1. 微信记录的 logistics_type 确实 = 4（用户自提）
        //   2. order_state 已进入发货后的合法状态
        //   3. 官方 finish_shipping（是否已完成全部发货）为 true
        if (logisticsType !== LOGISTICS_TYPE_SELF_PICKUP) {
          // 微信已发货，但不是「用户自提」—— 绝不声称 SYNCED。
          return ORDER_STATE_SHIPPED.has(state) ? { status: 'MISMATCH', code: 0 } : { status: 'PENDING', code: 0 }
        }
        if (!ORDER_STATE_SHIPPED.has(state)) return { status: 'PENDING', code: 0 }
        if (shipping.finish_shipping !== true) return { status: 'PENDING', code: 0 }
        return { status: 'SHIPPED', code: 0 }
      }

      // ---- DELIVERY：严格终态判据 ----
      //
      // 上层把 `SHIPPED` 当作「微信已确认这笔订单处于正确的已发货状态」，不是
      // 「get_order 此刻能查到一条运单」。两者差别是真实存在的：微信是最终一致的，
      // 运单条目可能先出现、`order_state` 还没推进；`finish_shipping` 也可能还没置位。
      // 因此下面五条必须**同时**成立才返回 SHIPPED：
      //   1. transaction_id 属于我们（上面已判）
      //   2. shipping.logistics_type === 1（快递；字段还没回全则继续等）
      //   3. shipping_list 中明确命中 tracking_no === 我们的运单
      //      且 express_company === 我们的 deliveryId（严格相等，不接受字段缺失）
      //   4. order_state 已进入 post-shipment 合法状态
      //   5. shipping.finish_shipping === true（官方「是否已完成全部发货」）
      //
      // 任何一条不满足都不得 SYNCED；区分 PENDING（还会好转，继续等）与
      // MISMATCH（微信记的是别人的事实，绝不可能变成我们的）。

      // 字段还没回全 ⇒ 继续等，不要因为「缺字段」提前认定成功。
      if (!deliveryId) return { status: 'FAILED', code: 0 }
      if (!Number.isFinite(logisticsType)) return { status: 'PENDING', code: 0 }
      if (logisticsType !== LOGISTICS_TYPE_EXPRESS) {
        // 微信把这一单记成了非快递模式：已发货就是别人的事实，否则只是状态未到。
        return ORDER_STATE_SHIPPED.has(state) ? { status: 'MISMATCH', code: 0 } : { status: 'PENDING', code: 0 }
      }
      // 案例 A：运单可能先于发货态出现 ⇒ 状态没到就继续等（eventual consistency）。
      if (!ORDER_STATE_SHIPPED.has(state)) return { status: 'PENDING', code: 0 }
      // 案例 B：官方「是否已完成全部发货」必须为 true。
      if (shipping.finish_shipping !== true) return { status: 'PENDING', code: 0 }

      const entries = list.filter(entry => entry && typeof entry === 'object')
      const sameWaybill = entries.filter(entry => entry.tracking_no === waybill)
      // 案例 D / D7：运单号与快递公司都明确等于我们上报的那一份。
      if (sameWaybill.some(entry => entry.express_company === deliveryId)) {
        return { status: 'SHIPPED', code: 0 }
      }
      if (!sameWaybill.length) {
        // 一条运单条目都没有 ⇒ 只是字段还没回全，别急着判死。
        if (!entries.length) return { status: 'PENDING', code: 0 }
        // 案例 E：有运单，但不是我们的 ⇒ 这笔支付单被别人占用，不可能变成我们的。
        return { status: 'MISMATCH', code: 0 }
      }
      // 运单是我们的，但快递公司字段：缺失（案例 D5）⇒ 继续等；
      // 明确返回了别的快递公司（案例 D4）⇒ MISMATCH。
      const carrierReturned = sameWaybill.some(
        entry => typeof entry.express_company === 'string' && entry.express_company)
      return carrierReturned ? { status: 'MISMATCH', code: 0 } : { status: 'PENDING', code: 0 }
    },
  }
}
