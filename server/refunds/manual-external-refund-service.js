import crypto from 'node:crypto'
import { httpError, parseCents } from '../pos-core.js'
import { settlementCoordinator } from '../settlements/settlement-coordinator.js'
import { allocateManualExternalRefund } from './refund-allocation.js'

const CLIENT_CONTROLLED_FIELDS = Object.freeze([
  'status', 'refundMode', 'paymentId', 'externalSettlementId', 'completedAt', 'providerRefundNo',
])

function normalizeRequestKey(value) {
  const requestKey = String(value || '').trim()
  if (requestKey.length < 8 || requestKey.length > 160 || /[\u0000-\u001f\u007f]/.test(requestKey)) {
    throw httpError('退款请求幂等键不正确')
  }
  return requestKey
}

function normalizeCompletedAt(value) {
  if (!value) throw httpError('请填写平台实际退款完成时间')
  const completedAt = new Date(value)
  if (Number.isNaN(completedAt.getTime())) throw httpError('平台实际退款完成时间不正确')
  return completedAt
}

function assertServerFields(input) {
  for (const field of CLIENT_CONTROLLED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) throw httpError(`字段 ${field} 只能由服务端退款状态机决定`)
  }
}

export class ManualExternalRefundService {
  constructor(prismaClient, coordinator = settlementCoordinator) {
    this.prisma = prismaClient
    this.coordinator = coordinator
  }

  async createCompletedRefund(input) {
    assertServerFields(input)
    const orderId = String(input.orderId || '').trim()
    const requestKey = normalizeRequestKey(input.requestKey)
    if (typeof input.refundAmount !== 'string') throw httpError('平台实际退款金额必须使用十进制分字符串')
    const refundAmount = parseCents(input.refundAmount, '平台实际退款金额')
    const externalCompletedAt = normalizeCompletedAt(input.externalCompletedAt)
    const externalRefundReference = String(input.externalRefundReference || '').trim().slice(0, 160) || null
    const reason = String(input.reason || '').trim().slice(0, 300)
    const actor = String(input.actor || '').trim().slice(0, 80)
    if (!orderId || !actor) throw httpError('外部退款订单或操作人不正确')

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.coordinator.lockOrder(tx, orderId)
        const replay = await tx.refund.findUnique({ where: { requestKey }, include: { items: true } })
        if (replay) return this.validateReplay(replay, {
          orderId, refundAmount, rawItems: input.items, externalCompletedAt, externalRefundReference, reason,
        })

        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            items: true,
            payments: true,
            externalSettlement: true,
            refunds: { include: { items: true } },
          },
        })
        if (!order) throw httpError('订单不存在', 404)
        if (order.settlementAuthority !== 'EXTERNAL' || order.payments.length !== 0) throw httpError('订单不属于 ExternalSettlement authority', 409)
        if (!['completed', 'partially_refunded'].includes(order.status)) throw httpError('当前订单状态不可记录平台退款', 409)
        const settlement = order.externalSettlement
        if (!settlement || !['CONFIRMED', 'PARTIALLY_REFUNDED'].includes(settlement.status)) {
          throw httpError('ExternalSettlement 状态不可退款', 409)
        }
        const completedTotal = order.refunds
          .filter((refund) => refund.status === 'completed')
          .reduce((sum, refund) => sum + BigInt(refund.refundAmount), 0n)
        if (completedTotal + refundAmount > order.payableAmount) throw httpError('累计退款金额超出订单结算金额', 409)

        const lines = allocateManualExternalRefund(order, input.items, refundAmount)
        const refund = await tx.refund.create({
          data: {
            id: `ref-${crypto.randomUUID()}`,
            refundNo: `RF${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
            orderId: order.id,
            paymentId: null,
            externalSettlementId: settlement.id,
            refundMode: 'MANUAL_EXTERNAL',
            refundAmount,
            reason,
            status: 'completed',
            providerRefundNo: null,
            externalCompletedAt,
            externalRefundReference,
            requestKey,
            requestedBy: actor,
            approvedBy: actor,
            completedAt: new Date(),
            items: {
              create: lines.map((line) => ({ id: `ri-${crypto.randomUUID()}`, ...line })),
            },
          },
          include: { items: true },
        })
        await this.coordinator.applyCompletedRefund(tx, { refundId: refund.id })
        return { refundId: refund.id, orderId: order.id, reused: false }
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (!['P2002', 'P2034'].includes(error?.code)) throw error
      const existing = await this.prisma.refund.findUnique({ where: { requestKey }, include: { items: true } })
      if (existing) return this.validateReplay(existing, {
        orderId, refundAmount, rawItems: input.items, externalCompletedAt, externalRefundReference, reason,
      })
      throw httpError('退款并发冲突，请刷新后重试', 409)
    }
  }

  validateReplay(refund, { orderId, refundAmount, rawItems, externalCompletedAt, externalRefundReference, reason }) {
    const requested = new Map((rawItems || []).map((row) => [String(row.orderItemId || '').trim(), Number(row.quantity)]))
    const sameItems = refund.items.length === requested.size
      && refund.items.every((item) => requested.get(item.orderItemId) === item.quantity)
    if (refund.refundMode !== 'MANUAL_EXTERNAL' || refund.orderId !== orderId
      || BigInt(refund.refundAmount) !== refundAmount || !sameItems
      || new Date(refund.externalCompletedAt).getTime() !== externalCompletedAt.getTime()
      || (refund.externalRefundReference || null) !== externalRefundReference
      || refund.reason !== reason) {
      throw httpError('退款幂等键已用于另一笔业务请求', 409)
    }
    return { refundId: refund.id, orderId: refund.orderId, reused: true }
  }
}
