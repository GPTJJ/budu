/**
 * Legacy (CloudBase payOrder-chain) waybill registration.
 *
 * Same trust boundary as the online merchant gateway: the request must arrive
 * signed by the CloudBase merchant function, and the actor must be a
 * WeChat-linked active user. No settlement is involved — order facts (buyer
 * openid, WeChat payment transaction id, recipient phone, waybill number) are
 * supplied by the merchant function, which reads them from the order document
 * it already guards. This endpoint never derives, guesses, or stores them.
 *
 * Idempotency lives at the CloudBase edge: the merchant function only calls
 * here when the order still lacks a waybillToken, and WeChat itself treats a
 * repeated identical trans_id+waybill_id report as the same waybill. This
 * handler is therefore deliberately stateless — nothing is written to the
 * production database, and a retried call changes no financial or commerce
 * fact.
 */
import { httpError } from './pos-core.js'
import { verifyProductionGatewayRequest } from './production-cloudbase-gateway.js'

function hasControlChars(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const text = (value, max) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max && !hasControlChars(trimmed) ? trimmed : ''
}

// WeChat delivery_id values used by the merchant page picker. Kept explicit so
// an unknown carrier is rejected at the edge instead of being mis-attributed.
const CARRIER_CODES = new Set(['SF', 'ZTO', 'YTO', 'YUNDA', 'STO', 'JD', 'EMS'])

export function createLegacyWaybillRegister({ db, gatewayConfig, wechatLogistics }) {
  if (typeof wechatLogistics?.reportWaybill !== 'function') throw Error('LEGACY_WAYBILL_CLIENT_REQUIRED')
  return async function legacyWaybillRegister(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    try {
      verifyProductionGatewayRequest(req, gatewayConfig)
      const body = req.body || {}
      const actorOpenId = text(body.actorOpenId, 128)
      if (!actorOpenId) throw httpError('商家身份无效', 403)
      const identity = await db.weChatAuthIdentity.findUnique({
        where: { provider_appId_openId: { provider: 'WECHAT_MINIPROGRAM', appId: gatewayConfig.appId, openId: actorOpenId } },
        include: { user: true },
      })
      if (!identity?.user || identity.user.status !== 'active') throw httpError('商家身份尚未关联', 403)

      const payNo = text(body.payNo, 64)
      const openid = text(body.openid, 128)
      const carrierCode = text(body.carrierCode, 40)
      const trackingNo = text(body.trackingNo, 80)
      const receiverPhone = text(body.receiverPhone, 40)
      const goodsName = text(body.goodsName, 120)
      const goodsImgUrl = text(body.goodsImgUrl, 512)
      const orderDetailPath = text(body.orderDetailPath, 256)
      const transId = text(body.transId, 40)
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(payNo)) throw httpError('订单号无效', 400)
      if (!CARRIER_CODES.has(carrierCode)) throw httpError('快递公司无效', 400)
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(trackingNo)) throw httpError('运单号无效', 400)
      if (!openid || !receiverPhone || !goodsName || !goodsImgUrl || !orderDetailPath) {
        throw httpError('物流上报参数不完整', 400)
      }
      // A legacy order without a WeChat payment transaction can never receive an
      // official track; say so honestly instead of letting WeChat reject a
      // fabricated trans_id. The customer still sees carrier + waybill number.
      if (!transId) {
        return res.json({ ok: true, result: { status: 'UNSUPPORTED', waybillToken: null } })
      }

      const outcome = await wechatLogistics.reportWaybill({
        openid,
        receiverPhone,
        waybillId: trackingNo,
        transId,
        orderDetailPath,
        goodsName,
        goodsImgUrl,
        deliveryId: carrierCode,
      })
      return res.json({
        ok: true,
        result: {
          status: outcome && outcome.status === 'SYNCED' ? 'SYNCED' : (outcome && outcome.status) || 'PENDING',
          waybillToken: outcome && outcome.status === 'SYNCED' ? outcome.waybillToken : null,
        },
      })
    } catch (error) {
      return res
        .status([400, 401, 403, 404, 409, 429].includes(error?.status) ? error.status : 503)
        .json({ ok: false, error: 'LEGACY_WAYBILL_REQUEST_FAILED' })
    }
  }
}
