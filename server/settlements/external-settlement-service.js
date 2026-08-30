import crypto from 'node:crypto'
import { buildOrderSnapshot, hashCart, httpError, normalizeCartItems, parseCents } from '../pos-core.js'
import {
  assertNoClientSettlementState,
  externalCheckoutKey,
  externalOrderDimensions,
  newExternalSettlementNo,
  normalizeExternalRequestKey,
} from './settlement-contract.js'
import { settlementCoordinator } from './settlement-coordinator.js'

export class ExternalSettlementService {
  constructor(prismaClient, coordinator = settlementCoordinator) {
    this.prisma = prismaClient
    this.coordinator = coordinator
  }

  async createExternalOrder(input) {
    assertNoClientSettlementState(input)
    const requestKey = normalizeExternalRequestKey(input.requestKey)
    const dimensions = externalOrderDimensions(input.orderSource)
    const storeId = String(input.storeId || '').trim()
    const actorId = String(input.actorId || '').trim()
    const actorName = String(input.actorName || '').trim().slice(0, 80)
    const discountPercent = Number(input.discountPercent ?? 100)
    const remark = String(input.remark || '').slice(0, 200)
    const note = String(input.note || '').slice(0, 300)
    const confirm = input.confirm === true
    if (!storeId || !actorId || !actorName) throw httpError('外部订单门店或操作人不正确')
    const normalizedItems = normalizeCartItems(input.items)
    const cartHash = hashCart({ items: normalizedItems, discountPercent, remark, orderSource: dimensions.orderSource })

    const replay = await this.prisma.externalSettlement.findUnique({ where: { requestKey }, include: { order: true } })
    if (replay) return this.replayResult(replay, { storeId, cartHash, dimensions, confirm, actorId })

    const needIds = new Set(normalizedItems.map((item) => item.productId))
    for (const item of normalizedItems) {
      if (Array.isArray(item.comboFlavorIds)) for (const id of item.comboFlavorIds) needIds.add(id)
    }
    const products = await this.prisma.inventoryItem.findMany({ where: { id: { in: [...needIds] } } })
    const snapshot = buildOrderSnapshot(products, normalizedItems, { discountPercent, remark })
    if (snapshot.payableAmount <= 0n) throw httpError('外部订单应付金额必须大于 0')
    const checkoutKey = externalCheckoutKey(requestKey)
    const now = new Date()
    const businessDate = new Date(`${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`)
    const id = `ord-${crypto.randomUUID()}`
    const orderNo = `POS${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
    const settlementId = `ext-${crypto.randomUUID()}`

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            id,
            orderNo,
            storeId,
            cashierId: actorId,
            cashierNameSnapshot: actorName,
            subtotal: snapshot.subtotal,
            discountAmount: snapshot.discountAmount,
            payableAmount: snapshot.payableAmount,
            businessDate,
            discountPercent: snapshot.discountPercent,
            remark: snapshot.remark,
            orderSource: dimensions.orderSource,
            entryMode: dimensions.entryMode,
            settlementAuthority: dimensions.settlementAuthority,
            sourceOrderRef: null,
            checkoutKey,
            cartHash,
            status: 'pending_payment',
            // paymentStatus is the legacy order-level settlement state. External
            // settlement follows the same pending -> paid transition without
            // creating or invoking a Payment/provider fact.
            paymentStatus: 'pending',
            items: { create: snapshot.lines.map((line) => ({ id: `oi-${crypto.randomUUID()}`, ...line })) },
          },
        })
        await tx.externalSettlement.create({
          data: {
            id: settlementId,
            settlementNo: newExternalSettlementNo(),
            orderId: id,
            settlementType: dimensions.settlementType,
            amountCents: snapshot.payableAmount,
            currency: 'CNY',
            status: confirm ? 'CONFIRMED' : 'PENDING',
            requestKey,
            note,
            recordedBy: actorId,
            recordedAt: now,
            confirmedBy: confirm ? actorId : '',
            confirmedAt: confirm ? now : null,
          },
        })
        if (confirm) await this.coordinator.settleExternal(tx, { settlementId, completedAt: now })
      })
    } catch (error) {
      if (error?.code !== 'P2002') throw error
      const existing = await this.prisma.externalSettlement.findUnique({ where: { requestKey }, include: { order: true } })
      if (!existing) throw httpError('外部订单请求冲突，请查询后重试', 409)
      return this.replayResult(existing, { storeId, cartHash, dimensions, confirm, actorId })
    }
    return { orderId: id, settlementId, reused: false }
  }

  async replayResult(settlement, { storeId, cartHash, dimensions, confirm, actorId }) {
    if (settlement.order.storeId !== storeId
      || settlement.order.cartHash !== cartHash
      || settlement.order.orderSource !== dimensions.orderSource
      || settlement.order.settlementAuthority !== 'EXTERNAL') {
      throw httpError('外部结算请求幂等键已用于另一笔订单', 409)
    }
    if (confirm && settlement.status === 'PENDING') {
      await this.confirmSettlement({ settlementId: settlement.id, amountCents: settlement.amountCents.toString(), actorId })
    }
    return { orderId: settlement.orderId, settlementId: settlement.id, reused: true }
  }

  async confirmSettlement(input) {
    const settlementId = String(input.settlementId || '').trim()
    const actorId = String(input.actorId || '').trim()
    if (!settlementId || !actorId) throw httpError('外部结算确认参数不正确')
    if (typeof input.amountCents !== 'string') throw httpError('确认金额必须使用十进制分字符串')
    const amountCents = parseCents(input.amountCents, '确认金额')

    await this.prisma.$transaction(async (tx) => {
      let settlement = await tx.externalSettlement.findUnique({ where: { id: settlementId }, include: { order: true } })
      if (!settlement) throw httpError('外部结算不存在', 404)
      if (settlement.amountCents !== amountCents || settlement.order.payableAmount !== amountCents) {
        throw httpError('确认金额与订单应付金额不一致', 409)
      }
      if (settlement.status === 'CONFIRMED') {
        await this.coordinator.settleExternal(tx, { settlementId, completedAt: settlement.confirmedAt || new Date() })
        return
      }
      if (settlement.status !== 'PENDING') throw httpError('当前外部结算状态不可确认', 409)
      const now = new Date()
      const won = await tx.externalSettlement.updateMany({
        where: { id: settlementId, status: 'PENDING' },
        data: { status: 'CONFIRMED', confirmedBy: actorId, confirmedAt: now },
      })
      if (won.count !== 1) {
        settlement = await tx.externalSettlement.findUnique({ where: { id: settlementId } })
        if (settlement?.status !== 'CONFIRMED') throw httpError('外部结算状态已变化，请刷新后重试', 409)
      }
      await this.coordinator.settleExternal(tx, { settlementId, completedAt: now })
    })
    return { settlementId }
  }
}
