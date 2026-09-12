import express from 'express'
import { verifyProductionGatewayRequest } from './production-cloudbase-gateway.js'
import { createOnlineRefund } from './online-refund.js'
import { createOnlineFulfillment } from './online-fulfillment.js'
import { onlineFinancialEnvelope } from './online-financial-transaction.js'
import { httpError } from './pos-core.js'

// Dedicated merchant-function key, never the customer gateway key. The
// CloudBase merchant function authenticates its runtime OPENID against its
// canonical merchant allowlist before it signs this narrowly scoped request.
export function createOnlineMerchantRouter({ db, gatewayConfig }) {
  const router = express.Router()
  async function activeActor(tx, actor){
    if(!actor?.id)throw httpError('商家身份已停用',403)
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR SHARE`
    const current=actor?.id && await tx.user.findUnique({where:{id:actor.id}})
    if(!current || current.status!=='active')throw httpError('商家身份已停用',403)
    return current.id
  }
  const refund = createOnlineRefund(db, { authorize: async (tx, settlement, actor) => activeActor(tx,actor) })
  const fulfillment = createOnlineFulfillment(db, { authorize: async (tx, { actor }) => ({ actorId: await activeActor(tx,actor) }) })
  const handle = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      verifyProductionGatewayRequest(req, gatewayConfig)
      const openId = req.body?.actorOpenId
      if (typeof openId !== 'string' || !openId || openId.length > 128) throw httpError('商家身份无效', 403)
      const identity = await db.weChatAuthIdentity.findUnique({ where: { provider_appId_openId: {
        provider: 'WECHAT_MINIPROGRAM', appId: gatewayConfig.appId, openId,
      } }, include: { user: true } })
      if (!identity?.user || identity.user.status !== 'active') throw httpError('商家身份尚未关联', 403)
      const settlementId = req.body.settlementId
      if (typeof settlementId !== 'string' || settlementId.length > 160) throw httpError('订单无效', 400)
      const s = await db.onlineSettlement.findUnique({ where: { id: settlementId }, include: { tenders: true, refunds: true, compensations: true } })
      if (!s || s.namespace !== 'cloudbase-miniprogram') throw httpError('订单不存在', 404)
      res.json({ ok: true, result: await fn(req.body, identity.user, s) })
    } catch (error) {
      res.status([400,401,403,404,409,429].includes(error?.status) ? error.status : 503)
        .json({ ok: false, error: 'ONLINE_MERCHANT_REQUEST_FAILED' })
    }
  }
  router.post('/status', handle(async (body, actor, s) => onlineFinancialEnvelope(s)))
  router.post('/refund', handle(async (body, actor, s) => {
    if (typeof body.refundShipping !== 'boolean') throw httpError('退款运费意向无效', 400)
    if(typeof body.reason!=='string' || !body.reason.trim())throw httpError('请填写退款原因',400)
    const r = await refund({ settlementId: s.id, actor, requestKey: body.requestKey,
      items: body.items, reason: body.reason, shippingCents: body.refundShipping ? String(s.shippingCents) : '0' })
    return { refundId: r.id, settlementId: s.id, status: r.status,
      totalCents: String(r.totalCents), sweetCardCents: String(r.sweetCardCents), wechatCents: String(r.wechatCents) }
  }))
  router.post('/fulfill', handle(async (body, actor, s) => {
    const receipt = await fulfillment.authorize({ settlementId: s.id, actor, requestKey: body.requestKey,
      method: body.method, carrierCode: body.carrierCode, trackingNo: body.trackingNo })
    return { authorizationId: receipt.id, settlementId: s.id, requestKey: receipt.requestKey,
      status: receipt.method === 'DELIVERY' ? 'SHIPPED' : 'PICKED_UP', carrier: receipt.carrierCode,
      trackingNo: receipt.trackingNo, shippedAt: receipt.authorizedAt.toISOString() }
  }))
  return router
}
