import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { createOnlineWechatEvidence } from './online-wechat-evidence.js'
import { onlineFinancialTransaction } from './online-financial-transaction.js'
import { lockSweetCardAccount } from './sweet-card-account-lock.js'

const id = prefix => `${prefix}-${crypto.randomUUID()}`
// All entry points accept raw signed provider evidence, never client success or
// a caller-supplied "verified" boolean. Query and notification use one finalizer.
export function createOnlinePaymentFinalizer(prisma, configuration) {
  const verify = createOnlineWechatEvidence(configuration)
  return async function finalize(input) {
    const fact = verify(input)
    const tender = await prisma.onlineTender.findUnique({ where: { merchantTradeNo: fact.merchantTradeNo } })
    if (!tender || tender.type !== 'WECHAT') throw httpError('支付订单不存在', 404)
    return onlineFinancialTransaction(prisma, tender.settlementId, async (tx, settlement) => {
      const wx = settlement?.tenders.find(t => t.type === 'WECHAT')
      if (!wx || wx.merchantTradeNo !== fact.merchantTradeNo || wx.amountCents !== fact.amountCents
        || settlement.currency !== fact.currency) throw httpError('支付订单核对不一致', 409)
      // Unpaid query/close orchestration is separate. NOTPAY is not proof that
      // a provider order is closed and must never release a reservation.
      if (fact.state !== 'SUCCESS') return settlement
      const identity = await tx.weChatAuthIdentity.findUnique({ where: { provider_appId_openId: {
        provider: 'WECHAT_MINIPROGRAM', appId: fact.appId, openId: fact.payerOpenId,
      } } })
      if (!identity || identity.userId !== settlement.userId) throw httpError('支付身份核对不一致', 409)
      // WeChat success_time has second precision; PG creation has milliseconds.
      if (fact.successAt.getTime() < Math.floor(settlement.createdAt.getTime() / 1000) * 1000) throw httpError('支付时间核对不一致', 409)
      if (wx.status === 'SUCCEEDED') {
        if (wx.providerTransactionId !== fact.transactionId || wx.providerSuccessAt.getTime() !== fact.successAt.getTime()) throw httpError('支付交易核对不一致', 409)
        return settlement
      }
      const now = new Date()
      let account, reservation
      let compensate = !['PENDING', 'CLOSING'].includes(settlement.status) || fact.successAt >= settlement.expiresAt
      if (settlement.accountId) {
        await lockSweetCardAccount(tx, settlement.accountId)
        account = await tx.sweetCardAccount.findUnique({ where: { id: settlement.accountId }, include: { binding: true, claim: true } })
        reservation = await tx.sweetCardReservation.findUnique({ where: { settlementId: settlement.id } })
        if (!reservation || reservation.amountCents !== settlement.sweetCardCents) throw httpError('预留金额核对不一致', 409)
        const quote = await tx.onlineCheckoutQuote.findUnique({ where: { id: settlement.quoteId } })
        const validity = quote?.snapshot?.cardValidity
        const date = value => value === null ? null : (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value) : undefined)
        const validFrom = date(validity?.validFrom), expiresAt = date(validity?.expiresAt)
        if (validFrom === undefined || expiresAt === undefined) throw httpError('原支付有效期快照缺失，需核对', 409)
        const expiredOnly = account.status === 'EXPIRED' && expiresAt && expiresAt <= now
        compensate ||= reservation.status !== 'RESERVED' || (account.status !== 'ACTIVE' && !expiredOnly)
          || account.claim?.userId !== settlement.userId
          || (account.binding && account.binding.userId !== settlement.userId)
          || (account.bindingMode === 'REQUIRED' && account.binding?.userId !== settlement.userId)
          || (validFrom && validFrom > fact.successAt)
          || (expiresAt && expiresAt <= fact.successAt)
          || account.balanceCents < settlement.sweetCardCents
      }
      await tx.onlineTender.update({ where: { id: wx.id }, data: { status: 'SUCCEEDED', providerTransactionId: fact.transactionId,
        providerSuccessAt: fact.successAt, verifiedAt: now } })
      if (compensate) {
        if (reservation?.status === 'RESERVED') await tx.sweetCardReservation.update({ where: { id: reservation.id }, data: { status: 'RELEASED', releasedAt: now } })
        if (reservation) await tx.onlineTender.update({ where: { settlementId_type: { settlementId: settlement.id, type: 'SWEET_CARD' } }, data: { status: 'CLOSED' } })
        await tx.onlinePaymentCompensation.create({ data: { id: id('opc'), settlementId: settlement.id, providerTransactionId: fact.transactionId,
          amountCents: fact.amountCents, reason: 'CAPTURE_NOT_PERMITTED', merchantRefundNo: `OC${crypto.createHash('sha256').update(settlement.id).digest('hex').slice(0,30)}` } })
        return tx.onlineSettlement.update({ where: { id: settlement.id }, data: { status: 'RECONCILIATION_REQUIRED',
          reconciliationReason: 'CAPTURE_NOT_PERMITTED', version: { increment: 1 } } })
      }
      let ledgerId = null
      if (reservation) {
        ledgerId = id('scl')
        const balance = account.balanceCents - settlement.sweetCardCents
        await tx.sweetCardLedger.create({ data: { id: ledgerId, accountId: account.id, type: 'REDEEM', amountCents: -settlement.sweetCardCents,
          balanceAfterCents: balance, requestKey: `online-capture:${settlement.id}`, actorId: settlement.userId,
          metadata: { settlementId: settlement.id, channel: 'ONLINE_ORDER' } } })
        await tx.sweetCardAccount.update({ where: { id: account.id }, data: { balanceCents: balance,
          status: balance === 0n ? 'EXHAUSTED' : account.status, version: { increment: 1 } } })
        await tx.sweetCardReservation.update({ where: { id: reservation.id }, data: { status: 'CAPTURED', capturedAt: now } })
        await tx.onlineTender.update({ where: { settlementId_type: { settlementId: settlement.id, type: 'SWEET_CARD' } }, data: { status: 'SUCCEEDED', verifiedAt: now } })
      }
      return tx.onlineSettlement.update({ where: { id: settlement.id }, data: { status: 'PAID', paidAt: now,
        capturedLedgerId: ledgerId, version: { increment: 1 } } })
    })
  }
}
