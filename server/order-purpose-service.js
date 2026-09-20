import crypto from 'node:crypto'
import { canManageOrderPurpose, isTestOrderPurpose, ORDER_PURPOSES } from '../shared/orderPurpose.js'

export const purposeError = (code, message, status = 409) => Object.assign(new Error(message), { code, status })
const TYPES = { partner: { table: 'ReplenishmentOrder', delegate: 'replenishmentOrder', ref: 'partner_replenishment' }, transfer: { table: 'TransferRequest', delegate: 'transferRequest', ref: 'transfer' } }
export const purposeType = (type) => Object.hasOwn(TYPES, type) ? TYPES[type] : (() => { throw purposeError('ORDER_TYPE_INVALID', '订单类型不正确', 400) })()
export const cleanReason = (value) => {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason || reason.length > 500) throw purposeError('REASON_REQUIRED', '请填写 1–500 字的操作原因', 400)
  return reason
}
export async function assertPurposeActor(db, actorId) {
  const actor = await db.user.findUnique({ where: { id: String(actorId || '') } })
  if (!canManageOrderPurpose(actor)) throw purposeError('ORDER_PURPOSE_FORBIDDEN', '仅开发者和超级管理员可操作', 403)
  return actor
}
const json = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
export function safeOrderSnapshot(type, order) {
  return json({ id: order.id, orderNo: order.orderNo || order.id, type, purpose: order.purpose, status: order.status,
    createdAt: order.createdAt, createdBy: order.createdByActorName || order.createdBy,
    partner: order.partnerNameSnapshot, partnerId: order.partnerId, partnerStore: order.partnerStoreNameSnapshot,
    fromStoreKey: order.fromStoreKey, toStoreKey: order.toStoreKey,
    requestedTotalAmountCents: order.requestedTotalAmountCents, approvedTotalAmountCents: order.approvedTotalAmountCents,
    creationReplayHash: order.idempotencyScope ? crypto.createHash('sha256').update(`${order.idempotencyScope}\0${order.idempotencyKey}`).digest('hex') : undefined,
    items: (order.items || []).map(i => ({ id: i.id, productId: i.inventoryItemId || i.itemId,
      name: i.productNameSnapshot || i.itemNameSnapshot, requestedQuantity: i.requestedQuantityBase ?? i.quantity,
      approvedQuantity: i.approvedQuantityBase, shippedQuantity: i.shippedQuantity,
      unit: i.orderUnitSnapshot || i.quantityUnit })) })
}
export async function appendPurposeAudit(tx, { actor, type, order, action, reason, afterPurpose = null, safety = {}, deletedCounts = {}, operationKey }) {
  return tx.orderPurposeAudit.create({ data: {
    id: crypto.randomUUID(), operationKey: operationKey || crypto.randomUUID(), action, orderType: type,
    orderId: order.id, orderNo: order.orderNo || order.id, actorId: actor.id, actorRole: actor.role,
    reason: cleanReason(reason), beforePurpose: action === 'CREATE_TEST' ? null : order.purpose,
    afterPurpose, snapshot: safeOrderSnapshot(type, order), safety: json(safety), deletedCounts,
  } })
}

// No payment, payroll or financial writer links to these order domains. Still
// reject exact-ID economic references, stock facts, all fulfillment facts and
// notification obligations. Missing proof of test-only delivery fails closed.
export async function scanOrderEffects(tx, type, order) {
  const config = purposeType(type)
  const ids = [order.id, order.orderNo].filter(Boolean)
  const counts = {
    payments: await tx.payment.count({ where: { orderId: { in: ids } } }),
    refunds: await tx.refund.count({ where: { orderId: { in: ids } } }),
    sweetCardLedger: await tx.sweetCardLedger.count({ where: { orderId: { in: ids } } }),
    externalSettlement: await tx.externalSettlement.count({ where: { orderId: { in: ids } } }),
    salesOrderReferences: await tx.order.count({ where: { OR: [{ id: { in: ids } }, { sourceOrderRef: { in: ids } }] } }),
    stockLedger: await tx.stockLedger.count({ where: { refId: { in: ids } } }),
    notificationObligations: await tx.notification.count({ where: { refType: config.ref, refId: order.id } }),
    shipments: type === 'partner' ? await tx.replenishmentShipment.count({ where: { replenishmentOrderId: order.id } }) : (order.shippedAt || ['shipped','done','completed','received'].includes(order.status) || order.items.some(i => i.shippedQuantity != null) ? 1 : 0),
    afterSales: type === 'partner' ? await tx.replenishmentAfterSalesRequest.count({ where: { replenishmentOrderId: order.id } }) : 0,
  }
  if (type === 'partner' && ['PARTIALLY_SHIPPED','SHIPPED'].includes(order.status)) counts.shipments = Math.max(1, counts.shipments)
  return { safe: Object.values(counts).every(count => count === 0), counts,
    blockers: Object.entries(counts).filter(([,count]) => count > 0).map(([name]) => name),
    payrollAuthority: 'NO_ORDER_REFERENCE_OR_WRITER_IN_THIS_DOMAIN', policy: 'NO_UNPROVEN_FULFILLMENT_OR_NOTIFICATION_DELETION' }
}
async function lockedOrder(tx, type, id) {
  const config = purposeType(type)
  // Whitelisted table identifier only, ID is always bound.
  await tx.$queryRawUnsafe(`SELECT id FROM "${config.table}" WHERE id=$1 FOR UPDATE`, id)
  const order = await tx[config.delegate].findUnique({ where: { id }, include: { items: true } })
  if (!order) throw purposeError('ORDER_NOT_FOUND_OR_DELETED', '订单不存在或已删除', 404)
  return order
}
export async function inspectPurposeOrder({ db, actorId, type, id }) {
  await assertPurposeActor(db, actorId)
  return db.$transaction(async tx => {
    const order = await lockedOrder(tx, type, id)
    const safety = await scanOrderEffects(tx, type, order)
    const audits = await tx.orderPurposeAudit.findMany({ where: { orderType: type, orderId: id }, orderBy: { createdAt: 'asc' } })
    return { order: safeOrderSnapshot(type, order), safety, audits: json(audits) }
  }, { isolationLevel: 'Serializable' })
}
export async function changeOrderPurpose({ db, actorId, type, id, body, correction = false }) {
  const reason = cleanReason(body?.reason)
  if (!ORDER_PURPOSES.includes(body?.purpose) || body.purpose === 'LEGACY_UNCLASSIFIED') throw purposeError('ORDER_PURPOSE_INVALID', '请选择明确用途', 400)
  return db.$transaction(async tx => {
    const actor = await assertPurposeActor(tx, actorId)
    const order = await lockedOrder(tx, type, id)
    if (body.expectedPurpose !== order.purpose) throw purposeError('ORDER_PURPOSE_STALE', '订单用途已变化，请刷新')
    if (!correction && order.purpose !== 'LEGACY_UNCLASSIFIED') throw purposeError('CLASSIFICATION_REQUIRES_LEGACY', '已分类订单必须通过用途更正操作')
    if (order.purpose === body.purpose) throw purposeError('ORDER_PURPOSE_UNCHANGED', '用途未改变')
    const safety = await scanOrderEffects(tx, type, order)
    // Both directions involving a test purpose require no real effects.
    if ((isTestOrderPurpose(body.purpose) || isTestOrderPurpose(order.purpose)) && !safety.safe) {
      throw purposeError(order.purpose === 'LEGACY_UNCLASSIFIED' ? 'LEGACY_ORDER_HAS_REAL_SIDE_EFFECTS' : 'TEST_ORDER_HAS_REAL_SIDE_EFFECTS', '存在业务副作用或待处理通知，不能改为测试用途或改写测试历史')
    }
    await appendPurposeAudit(tx, { actor, type, order, action: correction ? 'CORRECT' : 'CLASSIFY', reason, afterPurpose: body.purpose, safety })
    const result = await tx[purposeType(type).delegate].update({ where: { id }, data: { purpose: body.purpose }, include: { items: true } })
    return { order: safeOrderSnapshot(type, result) }
  }, { isolationLevel: 'Serializable', timeout: 15000 })
}
export async function deleteTestOrder({ db, actorId, type, id, body }) {
  const reason = cleanReason(body?.reason)
  return db.$transaction(async tx => {
    const actor = await assertPurposeActor(tx, actorId)
    const order = await lockedOrder(tx, type, id)
    if (!isTestOrderPurpose(order.purpose)) throw purposeError('TEST_ORDER_PURPOSE_REQUIRED', '仅已明确分类的测试订单可永久删除')
    if (body.expectedPurpose !== order.purpose) throw purposeError('ORDER_PURPOSE_STALE', '订单用途已变化，请刷新')
    const safety = await scanOrderEffects(tx, type, order)
    if (!safety.safe) throw purposeError('TEST_ORDER_HAS_REAL_SIDE_EFFECTS', '订单存在真实或无法证明安全的业务副作用，不允许永久删除')
    const deletedCounts = { orders: 1, items: order.items.length, notifications: 0, shipments: 0 }
    const audit = await appendPurposeAudit(tx, { actor, type, order, action: 'DELETE_TEST', reason, safety, deletedCounts })
    // Parent is locked. Child delete guards require this transaction's exact
    // audit; shared PartnerAuditLog and permanent purpose audits are preserved.
    await tx[type === 'partner' ? 'replenishmentOrderItem' : 'transferItem'].deleteMany({ where: type === 'partner' ? { replenishmentOrderId: id } : { requestId: id } })
    await tx[purposeType(type).delegate].delete({ where: { id } })
    return { ok: true, operationId: audit.id, deletedCounts }
  }, { isolationLevel: 'Serializable', timeout: 15000 })
}
