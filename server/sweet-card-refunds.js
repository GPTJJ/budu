import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

export async function prepareSweetCardRefund(tx, { refund, order }) {
  // Legacy unit doubles do not expose candidate delegates; absent delegates mean a normal provider-only refund.
  if (!tx.sweetCardRedemption?.findUnique) return { providerRefundAmount: refund.refundAmount, sweetCardRefundAmount: 0n }
  const redemption = await tx.sweetCardRedemption.findUnique({ where: { orderId: order.id }, include: { items: true } })
  if (!redemption) {
    await tx.refund.update({ where: { id: refund.id }, data: { providerRefundAmount: refund.refundAmount, sweetCardRefundAmount: 0n } })
    return { providerRefundAmount: refund.refundAmount, sweetCardRefundAmount: 0n }
  }
  const byOrderItem = new Map(redemption.items.map((row) => [row.orderItemId, row]))
  const refundItems = await tx.refundItem.findMany({ where: { refundId: refund.id } })
  const allocations = []
  let sweetTotal = 0n
  for (const item of refundItems) {
    const source = byOrderItem.get(item.orderItemId)
    if (!source || source.redeemedAmountCents <= 0n) continue
    const orderItem = order.items.find((row) => row.id === item.orderItemId)
    if (!orderItem) throw httpError('退款商品快照不完整', 409)
    const [priorItems, priorSweet] = await Promise.all([
      tx.refundItem.findMany({ where: { orderItemId: item.orderItemId, refund: { status: 'completed', id: { not: refund.id } } }, select: { quantity: true } }),
      tx.sweetCardRefundItem.aggregate({ where: { redemptionItemId: source.id, sweetCardRefund: { refund: { status: 'completed' } } }, _sum: { amountCents: true } }),
    ])
    const priorQuantity = priorItems.reduce((sum, row) => sum + row.quantity, 0)
    const cumulativeQuantity = priorQuantity + item.quantity
    if (cumulativeQuantity > orderItem.quantity) throw httpError('退款数量超过原订单', 409)
    const target = cumulativeQuantity === orderItem.quantity
      ? source.redeemedAmountCents
      : source.redeemedAmountCents * BigInt(cumulativeQuantity) / BigInt(orderItem.quantity)
    const already = BigInt(priorSweet._sum.amountCents || 0)
    const amount = target - already
    if (amount < 0n) throw httpError('甜意卡退款分配冲突', 409)
    if (amount > 0n) allocations.push({ refundItemId: item.id, redemptionItemId: source.id, amountCents: amount })
    sweetTotal += amount
  }
  if (sweetTotal > refund.refundAmount) throw httpError('甜意卡退款分配超过退款总额', 409)
  const providerTotal = refund.refundAmount - sweetTotal
  if (sweetTotal > 0n) {
    await tx.sweetCardRefund.create({ data: {
      id: `scf-${crypto.randomUUID()}`, refundId: refund.id, redemptionId: redemption.id, accountId: redemption.accountId,
      amountCents: sweetTotal, requestKey: `sweet-refund:${refund.requestKey}`,
      items: { create: allocations.map((row) => ({ id: `scfi-${crypto.randomUUID()}`, ...row })) },
    } })
  }
  await tx.refund.update({ where: { id: refund.id }, data: { providerRefundAmount: providerTotal, sweetCardRefundAmount: sweetTotal } })
  return { providerRefundAmount: providerTotal, sweetCardRefundAmount: sweetTotal }
}

export async function completeSweetCardRefund(tx, refund, actorName = '') {
  if (BigInt(refund.sweetCardRefundAmount || 0) === 0n) return
  if (!tx.sweetCardRefund?.findUnique) throw httpError('甜意卡退款 delegate 不可用', 503)
  const allocation = await tx.sweetCardRefund.findUnique({ where: { refundId: refund.id } })
  if (!allocation || allocation.amountCents !== refund.sweetCardRefundAmount) throw httpError('甜意卡退款恢复事实不完整', 409)
  const ledgerKey = `sweet-refund:${refund.requestKey}`
  if (await tx.sweetCardLedger.findUnique({ where: { requestKey: ledgerKey } })) return
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked', allocation.accountId)
  const account = await tx.sweetCardAccount.findUnique({ where: { id: allocation.accountId } })
  if (!account) throw httpError('甜意卡价值账户不存在', 409)
  const balanceAfter = account.balanceCents + allocation.amountCents
  if (balanceAfter > account.initialAmountCents) throw httpError('甜意卡退款将导致余额超额', 409)
  await tx.sweetCardLedger.create({ data: {
    id: `scl-${crypto.randomUUID()}`, accountId: account.id, type: 'REFUND', amountCents: allocation.amountCents,
    balanceAfterCents: balanceAfter, orderId: refund.orderId, refundId: refund.id, requestKey: ledgerKey,
    actorName, metadata: { refundNo: refund.refundNo },
  } })
  await tx.sweetCardAccount.update({ where: { id: account.id }, data: {
    balanceCents: balanceAfter, status: account.status === 'EXHAUSTED' ? 'ACTIVE' : account.status, version: { increment: 1 },
  } })
  await tx.sweetCardAuditLog.create({ data: {
    id: `sca-${crypto.randomUUID()}`, accountId: account.id, action: 'sweet_card.refund_restored', actorName,
    metadata: { refundId: refund.id, refundNo: refund.refundNo, amountCents: allocation.amountCents.toString() },
  } })
}

export async function reverseSweetCardRedemption(tx, orderId, actor = {}) {
  if (!tx.sweetCardRedemption?.findUnique) return false
  const redemption = await tx.sweetCardRedemption.findUnique({ where: { orderId } })
  if (!redemption) return false
  const requestKey = `reverse:${orderId}`
  if (await tx.sweetCardLedger.findUnique({ where: { requestKey } })) return true
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked', redemption.accountId)
  const account = await tx.sweetCardAccount.findUnique({ where: { id: redemption.accountId } })
  const balanceAfter = account.balanceCents + redemption.amountCents
  if (balanceAfter > account.initialAmountCents) throw httpError('甜意卡撤销将导致余额超额', 409)
  await tx.sweetCardLedger.create({ data: { id: `scl-${crypto.randomUUID()}`, accountId: account.id, type: 'REVERSAL', amountCents: redemption.amountCents,
    balanceAfterCents: balanceAfter, orderId, redemptionId: redemption.id, requestKey, actorId: actor.id || '', actorName: actor.name || '', metadata: { reason: 'ORDER_CANCELLED' } } })
  await tx.sweetCardAccount.update({ where: { id: account.id }, data: { balanceCents: balanceAfter, status: account.status === 'EXHAUSTED' ? 'ACTIVE' : account.status, version: { increment: 1 } } })
  await tx.order.update({ where: { id: orderId }, data: { sweetCardAmount: 0n } })
  await tx.sweetCardAuditLog.create({ data: { id: `sca-${crypto.randomUUID()}`, accountId: account.id, action: 'sweet_card.redemption_reversed', actorId: actor.id || '', actorName: actor.name || '', metadata: { orderId, amountCents: redemption.amountCents.toString() } } })
  return true
}
