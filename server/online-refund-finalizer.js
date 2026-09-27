import { httpError } from './pos-core.js'
import { onlineFinancialTransaction } from './online-financial-transaction.js'
import { settleOnlineRefund } from './online-refund.js'
import { createOnlineRefundEvidence, createOnlineRefundReferenceReader } from './online-refund-evidence.js'

export async function onlineRefundContext(prisma, merchantRefundNo, configuration) {
  const refund = await prisma.onlineRefund.findUnique({ where: { merchantRefundNo } })
  const compensation = refund ? null : await prisma.onlinePaymentCompensation.findUnique({ where: { merchantRefundNo } })
  const row = refund || compensation
  if (!row) throw httpError('退款记录不存在', 404)
  const settlement = await prisma.onlineSettlement.findUnique({ where: { id: row.settlementId }, include: { tenders: true, quote: true } })
  const wx = settlement?.tenders.find(t => t.type === 'WECHAT')
  const identity = settlement?.quote.snapshot.paymentIdentity
  if (!wx || wx.status !== 'SUCCEEDED' || !wx.verifiedAt || !wx.providerTransactionId
    || identity?.appId !== configuration.appId || identity?.mchId !== configuration.mchId) throw httpError('原支付身份需核对', 409)
  return { row, compensation: !!compensation, settlement, expected: {
    appId: identity.appId, mchId: identity.mchId, currency: settlement.currency,
    merchantTradeNo: wx.merchantTradeNo, transactionId: wx.providerTransactionId,
    merchantRefundNo, totalCents: wx.amountCents,
    refundCents: compensation ? row.amountCents : row.wechatCents,
    ...(row.providerRefundId ? { providerRefundId: row.providerRefundId } : {}),
  } }
}

export function createOnlineRefundFinalizer(prisma, configuration) {
  const reference = createOnlineRefundReferenceReader(configuration)
  const verify = createOnlineRefundEvidence(configuration)
  return async input => {
    const merchantRefundNo = reference(input)
    const context = await onlineRefundContext(prisma, merchantRefundNo, configuration)
    const fact = verify(input, context.expected)
    return onlineFinancialTransaction(prisma, context.row.settlementId, async (tx, settlement) => {
      const model = context.compensation ? tx.onlinePaymentCompensation : tx.onlineRefund
      const row = await model.findUnique({ where: { id: context.row.id } })
      if (row.providerRefundId && row.providerRefundId !== fact.providerRefundId) throw httpError('退款交易标识不一致', 409)
      if (row.status === 'SETTLED') return row
      // PROCESSING/ABNORMAL/CLOSED cannot remove the immutable allocation or
      // credit the card. Operators/recovery continue using the same refund no.
      if (fact.state !== 'SUCCESS') {
        return model.update({ where: { id: row.id }, data: { providerRefundId: fact.providerRefundId, providerStatus: fact.state } })
      }
      if (fact.successAt < new Date(Math.floor(row.createdAt.getTime() / 1000) * 1000)) throw httpError('退款时间需核对', 409)
      const provider = { providerRefundId: fact.providerRefundId, providerStatus: 'SUCCESS', verifiedAt: new Date() }
      if (!context.compensation) return settleOnlineRefund(tx, settlement, row, provider)
      const result = await model.update({ where: { id: row.id }, data: { ...provider, status: 'SETTLED', settledAt: new Date() } })
      await tx.onlineSettlement.update({ where: { id: settlement.id }, data: {
        status: settlement.cancelledAt ? 'CANCELLED' : 'EXPIRED', version: { increment: 1 },
      } })
      return result
    }).catch(error => {
      if (error?.code === 'P2002') throw httpError('退款交易标识冲突，需核对原退款', 409)
      throw error
    })
  }
}
