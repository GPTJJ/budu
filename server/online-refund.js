import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { onlineFinancialTransaction } from './online-financial-transaction.js'
import { allocateOnlineRefund, refundMerchandiseByQuantity, cents } from './online-checkout-policy.js'
import { lockSweetCardAccount } from './sweet-card-account-lock.js'

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = row => JSON.stringify([row.productId, row.skuId])

// Internal approval service. The required authorization callback executes with
// the locked settlement; customer intent alone can never authorize a refund.
export function createOnlineRefund(prisma, { authorize } = {}) {
  if (typeof authorize !== 'function') throw Error('ONLINE_REFUND_AUTHORITY_REQUIRED')
  return async function approve({ settlementId, requestKey, items, shippingCents = '0', actor, reason = null }) {
    if(reason!==null && (typeof reason!=='string' || !reason.trim() || reason.length>500 || /[\x00-\x1f]/.test(reason)))throw httpError('退款原因无效',400)
    if (typeof requestKey !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(requestKey)
      || !Array.isArray(items) || items.length > 100) throw httpError('退款请求无效', 400)
    const requested = items.map(row => {
      if (!row || typeof row.productId !== 'string' || !row.productId || typeof row.skuId !== 'string' || !row.skuId
        || !Number.isSafeInteger(row.quantity) || row.quantity < 1) throw httpError('退款商品无效', 400)
      return { productId: row.productId, skuId: row.skuId, quantity: row.quantity }
    }).sort((a, b) => key(a).localeCompare(key(b)))
    if (new Set(requested.map(key)).size !== requested.length) throw httpError('退款商品重复', 400)
    const shipping = cents(shippingCents)
    const fingerprint = hash([requested, String(shipping), reason])
    return onlineFinancialTransaction(prisma, settlementId, async (tx, settlement) => {
      if (!settlement) throw httpError('订单不存在', 404)
      const actorId = await authorize(tx, settlement, actor)
      if (typeof actorId !== 'string' || !actorId) throw httpError('无退款权限', 403)
      const existing = settlement.refunds.find(row => row.requestKey === requestKey)
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw httpError('原退款请求内容不一致', 409)
        return existing
      }
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(settlement.status)) throw httpError('当前订单不可退款', 409)
      const quote = await tx.onlineCheckoutQuote.findUnique({ where: { id: settlement.quoteId } })
      const quantities = new Map()
      const occupied = { eligibleCents: 0n, ineligibleCents: 0n, shippingCents: 0n, sweetCardCents: 0n, wechatCents: 0n }
      for (const refund of settlement.refunds) {
        for (const field of Object.keys(occupied)) occupied[field] += refund[field]
        for (const item of refund.items) {
          const previous = quantities.get(key(item))
          quantities.set(key(item), { productId: item.productId, skuId: item.skuId, quantity: (previous?.quantity || 0) + item.quantity })
        }
      }
      const merchandise = requested.length ? refundMerchandiseByQuantity({ lines: quote?.snapshot?.lines,
        occupied: [...quantities.values()], requested }) : { items: [], eligibleCents: '0', ineligibleCents: '0' }
      const allocation = allocateOnlineRefund({ original: settlement, occupied, requested: { ...merchandise, shippingCents: shipping } })
      const refundId = `orf-${hash([settlementId, requestKey])}`
      const data = { id: refundId, settlementId, requestKey, requestFingerprint: fingerprint,
        sequence: settlement.refunds.length + 1, items: merchandise.items, createdById: actorId, approvalReason: reason,
        merchantRefundNo: BigInt(allocation.wechatCents) > 0n ? `OR${hash(refundId).slice(0, 30)}` : null }
      for (const field of ['eligibleCents', 'ineligibleCents', 'shippingCents', 'totalCents', 'sweetCardCents', 'wechatCents', 'cumulativeEligibleCents']) data[field] = BigInt(allocation[field])
      data.cumulativeCardCents = BigInt(allocation.cumulativeSweetCardCents)
      const refund = await tx.onlineRefund.create({ data })
      if (refund.wechatCents === 0n) return settleOnlineRefund(tx, settlement, refund)
      await tx.onlineSettlement.update({ where: { id: settlementId }, data: { version: { increment: 1 } } })
      return refund
    })
  }
}

// DB-only helper used after provider evidence has been verified and matched by
// the refund finalizer, or directly for a zero-WeChat allocation above.
export async function settleOnlineRefund(tx, settlement, refund, provider = {}) {
  const now = new Date()
  let creditedLedgerId = null
  if (refund.sweetCardCents > 0n) {
    await lockSweetCardAccount(tx, settlement.accountId)
    const account = await tx.sweetCardAccount.findUnique({ where: { id: settlement.accountId } })
    if (!account) throw httpError('原甜意卡账户不存在', 409)
    const balance = account.balanceCents + refund.sweetCardCents
    creditedLedgerId = `scl-${hash(['online-refund', refund.id])}`
    await tx.sweetCardLedger.create({ data: { id: creditedLedgerId, accountId: account.id, type: 'REFUND',
      amountCents: refund.sweetCardCents, balanceAfterCents: balance, requestKey: `online-refund:${refund.id}`,
      actorId: refund.createdById, metadata: { settlementId: settlement.id, onlineRefundId: refund.id, channel: 'ONLINE_ORDER' } } })
    await tx.sweetCardAccount.update({ where: { id: account.id }, data: { balanceCents: balance,
      status: account.status === 'EXHAUSTED' ? 'ACTIVE' : account.status, version: { increment: 1 } } })
  }
  const result = await tx.onlineRefund.update({ where: { id: refund.id }, data: { ...provider, creditedLedgerId, status: 'SETTLED', settledAt: now } })
  const total = settlement.refunds.filter(row => row.status === 'SETTLED').reduce((sum, row) => sum + row.totalCents, 0n) + refund.totalCents
  await tx.onlineSettlement.update({ where: { id: settlement.id }, data: { status: total === settlement.totalCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED', version: { increment: 1 } } })
  return result
}
