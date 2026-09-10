import { httpError } from './pos-core.js'
import { createOnlineWechatEvidence } from './online-wechat-evidence.js'
import { createOnlinePaymentFinalizer } from './online-payment-finalizer.js'
import { onlineFinancialTransaction } from './online-financial-transaction.js'
import { lockSweetCardAccount } from './sweet-card-account-lock.js'

// Durable close intent precedes provider I/O. The provider adapter must stop
// prepay creation in CLOSING and close/query the ORIGINAL merchant trade number.
// Time, client cancellation and a successful close HTTP response cannot release
// money. Only a signed CLOSED query or verified SUCCESS resolves this intent.
export function createOnlinePaymentCancellation(prisma, configuration) {
  const verify = createOnlineWechatEvidence(configuration)
  const finalize = createOnlinePaymentFinalizer(prisma, configuration)
  async function release(tx, s) {
    const now = new Date(), expired = s.reconciliationReason === 'EXPIRY_REQUEST'
    if (s.accountId) {
      await lockSweetCardAccount(tx, s.accountId)
      await tx.sweetCardReservation.update({ where: { settlementId: s.id }, data: {
        status: expired ? 'EXPIRED' : 'RELEASED', releasedAt: now,
      } })
    }
    await tx.onlineTender.updateMany({ where: { settlementId: s.id, status: 'PENDING' }, data: { status: 'CLOSED' } })
    return tx.onlineSettlement.update({ where: { id: s.id }, data: { status: expired ? 'EXPIRED' : 'CANCELLED',
      cancelledAt: now, version: { increment: 1 } } })
  }
  return {
    resolveUndispatched(settlementId) {
      // Internal only. Every prepay attempt MUST durably mark requestedAt under
      // this same settlement lock before external I/O. Missing prepayId alone
      // is never proof of no attempt (crash/timeout may have lost its response).
      return onlineFinancialTransaction(prisma, settlementId, async (tx, s) => {
        const wx = s?.tenders.find(t => t.type === 'WECHAT')
        if (!s || s.status !== 'CLOSING' || !wx || wx.status !== 'PENDING'
          || wx.prepayRequestedAt || wx.prepayId || wx.providerTransactionId) return s
        return release(tx, s)
      })
    },
    request(settlementId, userId) {
      return onlineFinancialTransaction(prisma, settlementId, async (tx, s) => {
        if (!s || !userId || s.userId !== userId) throw httpError('订单不存在', 404)
        if (s.status !== 'PENDING') return s
        return tx.onlineSettlement.update({ where: { id: s.id }, data: {
          status: 'CLOSING', reconciliationReason: 'CANCEL_REQUEST', version: { increment: 1 },
        } })
      })
    },
    expire(settlementId) {
      // Internal recovery worker only; no public route for this method.
      return onlineFinancialTransaction(prisma, settlementId, async (tx, s) => {
        if (!s) throw httpError('订单不存在', 404)
        if (s.status !== 'PENDING' || s.expiresAt > new Date()) return s
        return tx.onlineSettlement.update({ where: { id: s.id }, data: {
          status: 'CLOSING', reconciliationReason: 'EXPIRY_REQUEST', version: { increment: 1 },
        } })
      })
    },
    async confirm(input) {
      if (input?.source !== 'QUERY') throw httpError('必须查询原支付订单状态', 400)
      const fact = verify(input)
      if (fact.state === 'SUCCESS') return finalize(input)
      const tender = await prisma.onlineTender.findUnique({ where: { merchantTradeNo: fact.merchantTradeNo } })
      if (!tender || tender.type !== 'WECHAT') throw httpError('支付订单不存在', 404)
      return onlineFinancialTransaction(prisma, tender.settlementId, async (tx, s) => {
        const wx = s?.tenders.find(t => t.type === 'WECHAT')
        if (!wx || wx.merchantTradeNo !== fact.merchantTradeNo || wx.amountCents !== fact.amountCents
          || s.currency !== fact.currency) throw httpError('支付订单核对不一致', 409)
        const quote = await tx.onlineCheckoutQuote.findUnique({ where: { id: s.quoteId } })
        if (quote?.snapshot?.paymentIdentity?.appId !== fact.appId || quote?.snapshot?.paymentIdentity?.mchId !== fact.mchId) throw httpError('原支付商户核对不一致', 409)
        if (s.status !== 'CLOSING' || fact.state !== 'CLOSED') return s
        return release(tx, s)
      })
    },
  }
}
