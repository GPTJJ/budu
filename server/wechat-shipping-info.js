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

const LOGISTICS_TYPE_EXPRESS = 1
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

  function buildUpload(input) {
    const transactionId = text(input?.transactionId, 64)
    const openid = text(input?.openid, 128)
    const deliveryId = text(input?.deliveryId, 128)
    const trackingNo = text(input?.trackingNo, 128)
    const itemDesc = text(input?.itemDesc, 120)
    const uploadTime = toWechatUploadTime(input?.uploadTime)
    const receiverContact = text(input?.receiverContact, 1024)

    // Every one of these is a WeChat-mandatory field. Refusing locally is better
    // than letting WeChat reject the shipment and burn the one re-ship chance.
    if (!transactionId || !openid || !deliveryId || !trackingNo || !itemDesc || !uploadTime) return null

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
    async verify({ transactionId, trackingNo, deliveryId }) {
      const txn = text(transactionId, 64)
      const waybill = text(trackingNo, 128)
      if (!txn || !waybill) return { status: 'FAILED', code: 0 }
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
      const list = order.shipping?.shipping_list
      const ours = Array.isArray(list)
        ? list.find(entry => entry && entry.tracking_no === waybill
          && (!deliveryId || !entry.express_company || entry.express_company === deliveryId))
        : null
      if (ours) return { status: 'SHIPPED', code: 0 }
      const state = Number(order.order_state)
      if (state === ORDER_STATE_REFUNDED) return { status: 'REFUNDED', code: 0 }
      // WeChat shows a shipped order that is not ours. Someone else's waybill (or
      // a manual后台 entry) owns this payment order — never claim it as synced.
      if (ORDER_STATE_SHIPPED.has(state)) return { status: 'MISMATCH', code: 0 }
      return { status: 'PENDING', code: 0 }
    },
  }
}
