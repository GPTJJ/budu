/**
 * WeChat 物流服务「传运单」(trace_waybill) client.
 *
 * This is the only place that talks to WeChat's logistics API. It exists so the
 * merchant-facing shipment path never depends on WeChat being reachable: the
 * caller records the shipment first (online_fulfillment_authorizations) and only
 * then asks this client to report the waybill.
 *
 * Hard rules encoded here:
 *  - The MiniProgram access_token comes from server/wechat-access-token.js. There
 *    is no token cache in this file; a second cache for the same appid would let
 *    WeChat invalidate the token the other consumer is holding.
 *  - The token is never returned, logged, or placed in an error message.
 *  - `openid` / `receiver_phone` / `trans_id` are caller-supplied authoritative
 *    facts. This module never derives, guesses or synthesises them — in
 *    particular it never invents a trans_id, and it refuses to call at all when
 *    one is missing (Sweet Card-only orders have no WeChat payment transaction).
 *  - WeChat's response is the only source of a waybill_token. If WeChat does not
 *    return one, the caller gets no token; there is no local fallback.
 */
import { miniprogramAccessToken, invalidateMiniprogramToken } from './wechat-access-token.js'

const ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/express/delivery/open_msg/trace_waybill'
// WeChat documents -1 as "system busy, retry later". Token failures are handled
// separately below by refreshing once. Everything else here is a permanent
// rejection for this waybill: retrying it unchanged would only burn quota.
const RETRYABLE_CODES = new Set([-1, 9300559])
const TOKEN_CODES = new Set([40001, 40014, 42001])

function text(value, max) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : ''
}

/**
 * @param {object}   options.config   `{ appId, appSecret }` for the MiniProgram
 * @param {Function} options.fetchImpl  injectable for tests
 * @param {Function} options.now        injectable clock
 */
export function createWechatLogistics({ config, fetchImpl = fetch, now = Date.now } = {}) {
  async function call(accessToken, payload) {
    const response = await fetchImpl(`${ENDPOINT}?access_token=${encodeURIComponent(accessToken)}`, {
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

  function build(input) {
    const openid = text(input?.openid, 128)
    const receiverPhone = text(input?.receiverPhone, 40)
    const waybillId = text(input?.waybillId, 80)
    const transId = text(input?.transId, 40)
    const orderDetailPath = text(input?.orderDetailPath, 256)
    const goodsName = text(input?.goodsName, 120)
    const goodsImgUrl = text(input?.goodsImgUrl, 512)
    const deliveryId = text(input?.deliveryId, 40)
    // trans_id is mandatory and must be the real WeChat payment transaction id.
    // A caller without one is a Sweet Card-only order: report "unsupported"
    // rather than fabricate a value WeChat would reject or, worse, mis-attribute.
    if (!openid || !receiverPhone || !waybillId || !transId || !orderDetailPath || !goodsName || !goodsImgUrl) {
      return { unsupported: true }
    }
    const payload = {
      openid,
      receiver_phone: receiverPhone,
      waybill_id: waybillId,
      trans_id: transId,
      order_detail_path: orderDetailPath,
      goods_info: { detail_list: [{ goods_name: goodsName, goods_img_url: goodsImgUrl }] },
    }
    // Optional, but it raises waybill recognition accuracy for smaller carriers.
    if (deliveryId) payload.delivery_id = deliveryId
    return { payload }
  }

  return {
    /**
     * Report one waybill to WeChat.
     *
     * @returns {Promise<{status:'SYNCED',waybillToken:string}
     *                 | {status:'UNSUPPORTED'}
     *                 | {status:'PENDING'|'FAILED',code:number}>}
     *   Never throws: the shipment already happened and must not be undone by a
     *   logistics problem. `PENDING` means "retry later", `FAILED` means WeChat
     *   permanently rejected this waybill.
     */
    async reportWaybill(input) {
      const prepared = build(input)
      if (prepared.unsupported) return { status: 'UNSUPPORTED' }
      const payload = prepared.payload

      let accessToken = await miniprogramAccessToken({ config, fetchImpl, now })
      if (!accessToken) return { status: 'PENDING', code: 0 }

      for (let attempt = 0; attempt < 2; attempt++) {
        let outcome
        try {
          outcome = await call(accessToken, payload)
        } catch {
          // Transport/deadline failure: WeChat may or may not have accepted the
          // waybill, so this stays retryable.
          return { status: 'PENDING', code: 0 }
        }
        if (outcome.transport) return { status: 'PENDING', code: 0 }

        const body = outcome.body || {}
        const errcode = Number(body.errcode)
        if (errcode === 0) {
          const waybillToken = text(body.waybill_token, 512)
          // WeChat answered success without a token. Treat it as a retryable
          // protocol surprise rather than inventing a local token.
          return waybillToken ? { status: 'SYNCED', waybillToken } : { status: 'PENDING', code: 0 }
        }
        if (TOKEN_CODES.has(errcode) && attempt === 0) {
          invalidateMiniprogramToken(config)
          const refreshed = await miniprogramAccessToken({ config, fetchImpl, now, forceRefresh: true })
          if (!refreshed) return { status: 'PENDING', code: errcode }
          accessToken = refreshed
          continue
        }
        return { status: RETRYABLE_CODES.has(errcode) ? 'PENDING' : 'FAILED', code: Number.isFinite(errcode) ? errcode : 0 }
      }
      return { status: 'PENDING', code: 0 }
    },
  }
}
