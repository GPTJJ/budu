import { Router } from 'express'
import { prisma } from './pg.js'
import { assertPurposeActor, changeOrderPurpose, deleteTestOrder, inspectPurposeOrder, safeOrderSnapshot, scanOrderEffects, purposeError } from './order-purpose-service.js'
import { createReplenishmentOrder, serializeReplenishmentOrder } from './replenishment-order-service.js'
import { isTestOrderPurpose } from '../shared/orderPurpose.js'
import { isRetryableTransactionConflict } from './transaction-conflict.js'

export const orderPurposeRouter = Router()
const wrap = fn => async (req, res) => {
  try { await assertPurposeActor(prisma, req.user?.id); await fn(req, res) } catch (error) {
    const conflict = isRetryableTransactionConflict(error)
    const status = conflict ? 409 : error.status || 500
    if (status >= 500) console.error('[order-purpose]', error.code || 'UNKNOWN')
    res.status(status).json({ error: conflict ? 'ORDER_CONCURRENT_CHANGE' : error.code || 'ORDER_PURPOSE_FAILED', message: status >= 500 ? '操作失败，未提交任何更改' : conflict ? '订单并发变化，请刷新后重试' : error.message })
  }
}
orderPurposeRouter.get('/order-purpose/orders', wrap(async (req, res) => {
  const rows = []
  for (const [type, delegate] of [['partner','replenishmentOrder'],['transfer','transferRequest']]) {
    const orders = await prisma[delegate].findMany({ include: { items: true }, orderBy: { createdAt: 'desc' }, take: 500 })
    for (const order of orders) rows.push({ ...safeOrderSnapshot(type, order), safety: await scanOrderEffects(prisma, type, order) })
  }
  const audits = await prisma.orderPurposeAudit.findMany({ orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, action: true, orderId: true, orderNo: true, orderType: true, actorId: true, actorRole: true, reason: true, beforePurpose: true, afterPurpose: true, createdAt: true, deletedCounts: true } })
  res.json({ rows, audits })
}))
orderPurposeRouter.get('/order-purpose/:type/:id', wrap(async (req, res) => {
  res.json(await inspectPurposeOrder({ db: prisma, actorId: req.user.id, ...req.params }))
}))
for (const [path, correction] of [['classify',false],['correct-purpose',true]]) {
  orderPurposeRouter.post(`/order-purpose/:type/:id/${path}`, wrap(async (req,res) => {
    res.json(await changeOrderPurpose({ db: prisma, actorId: req.user.id, ...req.params, body: req.body, correction }))
  }))
}
orderPurposeRouter.post('/order-purpose/:type/:id/delete-test', wrap(async (req,res) => {
  res.json(await deleteTestOrder({ db: prisma, actorId: req.user.id, ...req.params, body: req.body }))
}))
// Explicit acceptance entrance: reuse a chosen order's product/store selection,
// then the normal submission service takes fresh product/price snapshots.
orderPurposeRouter.post('/order-purpose/test-partner', wrap(async (req,res) => {
  if (!isTestOrderPurpose(req.body?.purpose)) throw purposeError('TEST_PURPOSE_REQUIRED', '请选择开发测试或验收测试', 400)
  const source = await prisma.replenishmentOrder.findUnique({ where: { id: String(req.body.sourceId || '') }, include: { items: true } })
  if (!source) throw purposeError('ORDER_NOT_FOUND_OR_DELETED', '模板订单不存在', 404)
  const result = await createReplenishmentOrder({ db: prisma, createdByType: 'INTERNAL', actor: { id: req.user.id },
    body: { partnerId: source.partnerId, partnerStoreId: source.partnerStoreId, items: source.items.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: i.requestedQuantityBase, orderUnit: i.orderUnitSnapshot })) },
    idempotencyKey: req.get('Idempotency-Key'), testPurpose: req.body.purpose, testReason: req.body.reason })
  res.status(result.reused ? 200 : 201).json({ order: serializeReplenishmentOrder(result.order, { internal: true }), reused: result.reused })
}))
