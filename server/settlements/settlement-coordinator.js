import { assertOrderPaymentTransition, assertOrderTransition } from '../order-state.js'
import { httpError } from '../pos-core.js'

const PAYMENT_PROOF_STATUSES = Object.freeze(['success', 'partially_refunded', 'refunded'])

export class SettlementCoordinator {
  async lockOrder(tx, orderId) {
    if (typeof tx.$queryRawUnsafe === 'function') {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked', orderId)
    }
  }

  async settlePayment(tx, { paymentId, completedAt = new Date() }) {
    const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { order: true } })
    if (!payment) throw httpError('支付结算事实不存在', 404)
    if (!PAYMENT_PROOF_STATUSES.includes(payment.status)) throw httpError('支付尚未形成有效结算事实', 409)
    if (payment.order.settlementAuthority !== 'PAYMENT') throw httpError('订单结算权威与 Payment 不匹配', 409)
    if (payment.amount !== payment.order.payableAmount) throw httpError('支付金额与订单应付金额不一致', 409)
    const externalCount = typeof tx.externalSettlement?.count === 'function'
      ? await tx.externalSettlement.count({ where: { orderId: payment.orderId } })
      : 0
    if (externalCount !== 0) throw httpError('Payment 订单存在外部结算事实', 409)
    return this.completeOrder(tx, payment.order, {
      paymentMethod: payment.channel,
      paymentMode: payment.provider,
      completedAt,
    })
  }

  async settleExternal(tx, { settlementId, completedAt = new Date() }) {
    const settlement = await tx.externalSettlement.findUnique({ where: { id: settlementId }, include: { order: true } })
    if (!settlement) throw httpError('外部结算事实不存在', 404)
    if (settlement.status !== 'CONFIRMED') throw httpError('外部结算尚未确认', 409)
    if (settlement.order.settlementAuthority !== 'EXTERNAL') throw httpError('订单结算权威与 ExternalSettlement 不匹配', 409)
    if (settlement.amountCents !== settlement.order.payableAmount) throw httpError('外部结算金额与订单应付金额不一致', 409)
    const paymentCount = await tx.payment.count({ where: { orderId: settlement.orderId } })
    if (paymentCount !== 0) throw httpError('ExternalSettlement 订单存在 Payment', 409)
    return this.completeOrder(tx, settlement.order, {
      paymentMethod: settlement.settlementType.toLowerCase(),
      paymentMode: 'external',
      completedAt,
    })
  }

  async completeOrder(tx, order, { paymentMethod, paymentMode, completedAt }) {
    if (order.status === 'completed' && order.paymentStatus === 'paid' && order.completedAt) return order
    if (!['pending_payment', 'paid'].includes(order.status)) throw httpError('当前订单状态不可完成结算', 409)

    let paymentStatus = order.paymentStatus
    if (paymentStatus !== 'paid') {
      assertOrderPaymentTransition(paymentStatus, 'paid')
      if (order.status === 'pending_payment') assertOrderTransition('pending_payment', 'paid')
      const paid = await tx.order.updateMany({
        where: { id: order.id, status: order.status, paymentStatus },
        data: {
          status: 'paid',
          paymentStatus: 'paid',
          paymentMethod,
          paymentMode,
          version: { increment: 1 },
        },
      })
      if (paid.count !== 1) throw httpError('订单状态已变化，请刷新后重试', 409)
      order = { ...order, status: 'paid', paymentStatus: 'paid', paymentMethod, paymentMode }
      paymentStatus = 'paid'
    }

    if (order.status === 'paid') {
      assertOrderTransition('paid', 'completed')
      const completed = await tx.order.updateMany({
        where: { id: order.id, status: 'paid', paymentStatus },
        data: { status: 'completed', completedAt, version: { increment: 1 } },
      })
      if (completed.count !== 1) throw httpError('订单状态已变化，请刷新后重试', 409)
    }
    return tx.order.findUnique({ where: { id: order.id } })
  }

  async applyCompletedRefund(tx, { refundId }) {
    const refund = await tx.refund.findUnique({ where: { id: refundId } })
    if (!refund) throw httpError('退款事实不存在', 404)
    if (refund.status !== 'completed') throw httpError('退款尚未完成', 409)
    await this.lockOrder(tx, refund.orderId)

    const order = await tx.order.findUnique({ where: { id: refund.orderId } })
    if (!order) throw httpError('退款订单不存在', 404)
    const completedRefunds = await tx.refund.findMany({ where: { orderId: order.id, status: 'completed' } })
    const completedTotal = completedRefunds.reduce((sum, row) => sum + BigInt(row.refundAmount), 0n)
    if (completedTotal <= 0n || completedTotal > order.payableAmount) throw httpError('累计退款金额超出订单可退金额', 409)

    const fullyRefunded = completedTotal === order.payableAmount
    const nextOrderStatus = fullyRefunded ? 'refunded' : 'partially_refunded'
    if (refund.refundMode === 'PAYMENT') {
      if (order.settlementAuthority !== 'PAYMENT' || !refund.paymentId || refund.externalSettlementId) {
        throw httpError('PAYMENT 退款权威不匹配', 409)
      }
      const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } })
      if (!payment || payment.orderId !== order.id) throw httpError('退款 Payment 与订单不匹配', 409)
      const changed = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: ['success', 'partially_refunded', nextOrderStatus] } },
        data: { status: nextOrderStatus },
      })
      if (changed.count !== 1) throw httpError('Payment 退款状态已变化，请核对', 409)
    } else if (refund.refundMode === 'MANUAL_EXTERNAL') {
      if (order.settlementAuthority !== 'EXTERNAL' || refund.paymentId || !refund.externalSettlementId) {
        throw httpError('MANUAL_EXTERNAL 退款权威不匹配', 409)
      }
      const settlement = await tx.externalSettlement.findUnique({ where: { id: refund.externalSettlementId } })
      if (!settlement || settlement.orderId !== order.id) throw httpError('退款 ExternalSettlement 与订单不匹配', 409)
      const nextSettlementStatus = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      const changed = await tx.externalSettlement.updateMany({
        where: { id: settlement.id, status: { in: ['CONFIRMED', 'PARTIALLY_REFUNDED', nextSettlementStatus] } },
        data: { status: nextSettlementStatus },
      })
      if (changed.count !== 1) throw httpError('ExternalSettlement 退款状态已变化，请核对', 409)
    } else {
      throw httpError('退款模式不正确', 409)
    }

    if (order.status !== nextOrderStatus || order.paymentStatus !== nextOrderStatus) {
      assertOrderTransition(order.status, nextOrderStatus)
      assertOrderPaymentTransition(order.paymentStatus, nextOrderStatus)
      const changed = await tx.order.updateMany({
        where: { id: order.id, status: order.status, paymentStatus: order.paymentStatus },
        data: { status: nextOrderStatus, paymentStatus: nextOrderStatus, version: { increment: 1 } },
      })
      if (changed.count !== 1) throw httpError('订单退款状态已变化，请刷新后重试', 409)
    }
    return {
      completedTotal,
      orderBefore: order,
      order: await tx.order.findUnique({ where: { id: order.id } }),
    }
  }
}

export const settlementCoordinator = new SettlementCoordinator()
