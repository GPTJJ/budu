import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { onlinePaymentAllowed } from './online-checkout-policy.js'
import { onlineFinancialTransaction } from './online-financial-transaction.js'
import { createOnlineWechatTransport } from './online-wechat-transport.js'
import { createOnlineWechatEvidence, createOnlineWechatMessageVerifier } from './online-wechat-evidence.js'
import { createOnlinePaymentFinalizer } from './online-payment-finalizer.js'
import { createOnlinePaymentCancellation } from './online-payment-cancellation.js'

const publicState = s => ({ settlementId: s.id, status: s.status })
const unknown = () => httpError('支付结果正在核对，请稍后重试原订单', 503)
export function createOnlinePaymentService(prisma, configuration, { request = createOnlineWechatTransport(configuration), env = process.env } = {}) {
  const verifyMessage = createOnlineWechatMessageVerifier(configuration), verifyPayment = createOnlineWechatEvidence(configuration)
  const finalize = createOnlinePaymentFinalizer(prisma, configuration), cancellation = createOnlinePaymentCancellation(prisma, configuration)
  const privateKey = crypto.createPrivateKey(configuration.merchantPrivateKey)
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength < 2048) throw Error('ONLINE_WECHAT_KEY_INVALID')
  let notify
  try { notify = new URL(configuration.notifyUrl) } catch { throw Error('ONLINE_NOTIFY_URL_REQUIRED') }
  if (notify.protocol !== 'https:' || notify.username || notify.password || notify.hash || notify.search || notify.port
    || notify.pathname !== '/api/online-checkout/wechat/notify' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(notify.hostname)
    || /(^|\.)(example\.(com|org|net)|localhost|test|invalid)$/i.test(notify.hostname)) throw Error('ONLINE_NOTIFY_URL_INVALID')
  async function read(id, userId) {
    const s = await prisma.onlineSettlement.findUnique({ where: { id }, include: { quote: true, tenders: true } })
    if (!s || (userId != null && s.userId !== userId)) throw httpError('订单不存在', 404)
    const wx = s.tenders.find(t => t.type === 'WECHAT')
    if (!wx) return { s, wx: null }
    const p = s.quote.snapshot.paymentIdentity
    if (p?.appId !== configuration.appId || p?.mchId !== configuration.mchId) throw httpError('原支付商户配置需核对', 409)
    const identity = await prisma.weChatAuthIdentity.findUnique({ where: { id: p.identityId } })
    if (!identity || identity.userId !== s.userId || identity.appId !== p.appId || identity.provider !== 'WECHAT_MINIPROGRAM') throw httpError('原支付身份需核对', 409)
    return { s, wx, identity }
  }
  async function query(context) {
    const { s, wx } = context
    const reply = await request('GET', `/v3/pay/transactions/out-trade-no/${wx.merchantTradeNo}?mchid=${configuration.mchId}`)
    verifyMessage(reply)
    if (reply.statusCode === 404) {
      let error
      try { error = JSON.parse(reply.rawBody.toString('utf8')) } catch { throw unknown() }
      if (error.code === 'ORDER_NOT_EXIST') return { absent: true }
    }
    const input = { ...reply, source: 'QUERY' }, fact = verifyPayment(input)
    if (fact.merchantTradeNo !== wx.merchantTradeNo || fact.amountCents !== s.wechatCents) throw httpError('原支付订单核对不一致', 409)
    if (fact.state === 'SUCCESS') return { settled: await finalize(input) }
    if (fact.state === 'CLOSED') {
      if (s.status === 'PENDING') await cancellation.request(s.id, s.userId)
      return { settled: await cancellation.confirm(input) }
    }
    return { fact }
  }
  function parameters(prepayId) {
    const timeStamp = String(Math.floor(Date.now() / 1000)), nonceStr = crypto.randomBytes(24).toString('hex'), pkg = `prepay_id=${prepayId}`
    return { timeStamp, nonceStr, package: pkg, signType: 'RSA',
      paySign: crypto.sign('RSA-SHA256', Buffer.from(`${configuration.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`), privateKey).toString('base64') }
  }
  const service = {
    async prepare(settlementId, userId) {
      if (!userId) throw httpError('请重新登录', 401)
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user || user.status !== 'active') throw httpError('请重新登录', 401)
      let context = await read(settlementId, userId)
      if (!context.wx || context.s.status !== 'PENDING') return publicState(context.s)
      if (context.s.expiresAt <= new Date()) return service.recover(settlementId)
      if (!onlinePaymentAllowed(userId, env)) throw httpError('线上支付暂未开放', 403)
      const observed = await query(context)
      if (observed.settled) return publicState(observed.settled)
      if (!observed.absent && observed.fact.state !== 'NOTPAY') return publicState(context.s)
      // Every attempt is marked durably BEFORE dispatch, under cancellation's
      // lock. A missing prepay response must never be mistaken for no attempt.
      const canSend = await onlineFinancialTransaction(prisma, settlementId, async (tx, s) => {
        if (s.status !== 'PENDING' || s.expiresAt <= new Date() || !onlinePaymentAllowed(userId, env)) return false
        const wx = s.tenders.find(t => t.type === 'WECHAT')
        if (!wx.prepayRequestedAt) await tx.onlineTender.update({ where: { id: wx.id }, data: { prepayRequestedAt: new Date() } })
        return true
      })
      if (!canSend) return publicState((await read(settlementId, userId)).s)
      context = await read(settlementId, userId)
      if (context.s.status !== 'PENDING') return publicState(context.s)
      let prepayId = context.wx.prepayId
      if (!prepayId) {
        const reply = await request('POST', '/v3/pay/transactions/jsapi', {
          appid: configuration.appId, mchid: configuration.mchId, description: 'budu 小程序订单',
          out_trade_no: context.wx.merchantTradeNo, time_expire: context.s.expiresAt.toISOString(), notify_url: notify.toString(),
          amount: { total: Number(context.s.wechatCents), currency: 'CNY' }, payer: { openid: context.identity.openId },
        })
        verifyMessage(reply)
        let result
        try { result = JSON.parse(reply.rawBody.toString('utf8')) } catch { throw unknown() }
        if (reply.statusCode !== 200 || typeof result.prepay_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.prepay_id)) throw unknown()
        prepayId = result.prepay_id
        await onlineFinancialTransaction(prisma, settlementId, async (tx, s) => {
          const wx = s.tenders.find(t => t.type === 'WECHAT')
          if (wx.prepayId && wx.prepayId !== prepayId) throw httpError('原支付凭证需核对', 409)
          if (!wx.prepayId) await tx.onlineTender.update({ where: { id: wx.id }, data: { prepayId } })
        })
      }
      const current = (await read(settlementId, userId)).s
      if (current.status !== 'PENDING' || current.expiresAt <= new Date()) return publicState(current)
      return { ...publicState(current), paymentParameters: parameters(prepayId) }
    },
    async cancel(settlementId, userId) {
      await cancellation.request(settlementId, userId)
      return service.recover(settlementId)
    },
    async recover(settlementId) {
      // Internal worker API; no new-purchase feature check. Existing holds and
      // payment facts must recover while the rollout switch is OFF.
      await cancellation.expire(settlementId)
      let context = await read(settlementId)
      if (!context.wx || !['PENDING', 'CLOSING'].includes(context.s.status)) return publicState(context.s)
      if (context.s.status === 'CLOSING') {
        await cancellation.resolveUndispatched(settlementId)
        context = await read(settlementId)
        if (context.s.status !== 'CLOSING') return publicState(context.s)
      }
      const observed = await query(context)
      if (observed.settled) return publicState(observed.settled)
      // An attempted request + ORDER_NOT_EXIST is still ambiguous; retain hold.
      if (observed.absent || context.s.status !== 'CLOSING' || observed.fact.state !== 'NOTPAY') return publicState(context.s)
      const reply = await request('POST', `/v3/pay/transactions/out-trade-no/${context.wx.merchantTradeNo}/close`, { mchid: configuration.mchId })
      verifyMessage(reply)
      if (reply.statusCode !== 204) throw unknown()
      const after = await query(await read(settlementId))
      return publicState(after.settled || (await read(settlementId)).s)
    },
  }
  return service
}
