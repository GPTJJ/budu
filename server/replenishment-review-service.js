import { isRetryableTransactionConflict } from './transaction-conflict.js'
import crypto from 'node:crypto'
import { authorizeReplenishmentReviewer } from './replenishment-review-authorization.js'
import {
  REPLENISHMENT_ORDER_STATUSES,
  normalizeIdempotencyKey,
} from './replenishment-order-service.js'
import {
  MAX_PARTNER_AMOUNT_CENTS,
  MAX_PARTNER_BASE_QUANTITY,
  calculatePartnerAmountCents,
  normalizePositiveSafeInteger,
} from './partner-replenishment-pricing.js'

export const REPLENISHMENT_REVIEW_ACTIONS = Object.freeze({ APPROVE: 'APPROVE', REJECT: 'REJECT' })
const orderInclude = Object.freeze({
  items: {
    include: { shipmentItems: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  shipments: {
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ shippedAt: 'asc' }, { id: 'asc' }],
  },
})
const APPROVE_KEYS = new Set(['version', 'items', 'reason'])
const REJECT_KEYS = new Set(['version', 'reason'])
const DECISION_KEYS = new Set(['itemId', 'approvedQuantityBase', 'reason'])
const REVIEW_OPERATION = 'REPLENISHMENT_ORDER_REVIEW'

function reviewError(message, code = 'REPLENISHMENT_REVIEW_INVALID', status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw reviewError('审核请求格式不正确')
  const extra = Object.keys(value).find((key) => !keys.has(key))
  if (extra) throw reviewError(`不接受客户端字段：${extra}`, 'REPLENISHMENT_REVIEW_AUTHORITY_INPUT_REJECTED')
}

function text(value, { label, max, required = false }) {
  const result = String(value || '').trim()
  if ((required && !result) || result.length > max) throw reviewError(`${label}${required ? `必须填写且不超过 ${max} 字` : `不能超过 ${max} 字`}`)
  return result
}

function version(value) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1) throw reviewError('订单版本不正确，请刷新后重试', 'REPLENISHMENT_REVIEW_VERSION_INVALID')
  return result
}

function approvedQuantity(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw reviewError('确认数量必须是非负整数')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_PARTNER_BASE_QUANTITY) {
    throw reviewError(`确认数量必须是 0-${MAX_PARTNER_BASE_QUANTITY} 的安全整数`)
  }
  return result
}

export function normalizeApproval(body) {
  exactObject(body, APPROVE_KEYS)
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) throw reviewError('审核必须包含全部原申请商品')
  const seen = new Set()
  const items = body.items.map((item) => {
    exactObject(item, DECISION_KEYS)
    const itemId = String(item.itemId || '').trim()
    if (!itemId || itemId.length > 120) throw reviewError('审核商品行 ID 不正确')
    if (seen.has(itemId)) throw reviewError('审核商品行不能重复', 'REPLENISHMENT_REVIEW_DUPLICATE_ITEM', 409)
    seen.add(itemId)
    return {
      itemId,
      approvedQuantityBase: approvedQuantity(item.approvedQuantityBase),
      reason: text(item.reason, { label: '商品调整说明', max: 300 }),
    }
  }).sort((left, right) => left.itemId.localeCompare(right.itemId))
  return { version: version(body.version), reason: text(body.reason, { label: '审核说明', max: 500 }), items }
}

export function normalizeRejection(body) {
  exactObject(body, REJECT_KEYS)
  return {
    version: version(body.version),
    reason: text(body.reason, { label: '驳回原因', max: 500, required: true }),
  }
}

function reviewScope(actorId) {
  return `${actorId}:${REVIEW_OPERATION}`
}

function digest(action, orderId, normalized) {
  return crypto.createHash('sha256').update(JSON.stringify({ action, orderId, ...normalized })).digest('hex')
}

function buildApprovedDecisions(order, normalized) {
  if (normalized.items.length !== order.items.length) throw reviewError('审核必须逐项提交原申请全部商品，不得新增或遗漏', 'REPLENISHMENT_REVIEW_ITEM_SET_MISMATCH', 409)
  const existingById = new Map(order.items.map((item) => [item.id, item]))
  let total = 0n
  const decisions = normalized.items.map((input) => {
    const item = existingById.get(input.itemId)
    if (!item) throw reviewError('审核包含非原申请商品行', 'REPLENISHMENT_REVIEW_ITEM_SET_MISMATCH', 409)
    if (input.approvedQuantityBase !== item.requestedQuantityBase && !input.reason) {
      throw reviewError('调整或移除商品时必须填写该行说明', 'REPLENISHMENT_REVIEW_REASON_REQUIRED')
    }
    if (input.approvedQuantityBase > 0) {
      normalizePositiveSafeInteger(input.approvedQuantityBase)
    }
    const amount = input.approvedQuantityBase === 0
      ? 0n
      : calculatePartnerAmountCents({
        orderUnit: item.orderUnitSnapshot,
        quantityBase: input.approvedQuantityBase,
        basePriceCents: item.basePriceSnapshotCents,
        discountBps: item.discountBpsSnapshot,
      })
    total += amount
    if (total > MAX_PARTNER_AMOUNT_CENTS) throw reviewError('审核确认总金额超出允许范围', 'REPLENISHMENT_REVIEW_TOTAL_OVERFLOW', 409)
    return { item, approvedQuantityBase: input.approvedQuantityBase, approvedLineAmountCents: amount, reason: input.reason }
  })
  if (total <= 0n) throw reviewError('所有商品均不批准时必须整单驳回', 'REPLENISHMENT_REVIEW_EMPTY_APPROVAL', 409)
  return { decisions, total }
}

function auditValue(order, decisions = [], reviewer = null) {
  const value = {
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status,
    version: order.version,
    requestedTotalAmountCents: order.requestedTotalAmountCents.toString(),
    approvedTotalAmountCents: order.approvedTotalAmountCents == null ? null : order.approvedTotalAmountCents.toString(),
    reviewAction: order.reviewAction,
    reviewReason: order.reviewReason,
    reviewedAt: order.reviewedAt ? new Date(order.reviewedAt).toISOString() : null,
    decisions: decisions.map((decision) => ({
      itemId: decision.item.id,
      requestedQuantityBase: decision.item.requestedQuantityBase,
      approvedQuantityBase: decision.approvedQuantityBase,
      approvedLineAmountCents: decision.approvedLineAmountCents.toString(),
      reason: decision.reason,
    })),
  }
  if (reviewer) value.reviewerEmployeeId = reviewer.employeeId || null
  return value
}

async function writeReviewAudit(tx, { before, after, decisions, reviewer }) {
  await tx.partnerAuditLog.create({
    data: {
      id: crypto.randomUUID(),
      partnerId: after.partnerId,
      entityType: 'REPLENISHMENT_ORDER',
      entityId: after.id,
      action: after.reviewAction === REPLENISHMENT_REVIEW_ACTIONS.APPROVE ? 'REPLENISHMENT_ORDER_APPROVED' : 'REPLENISHMENT_ORDER_REJECTED',
      before: auditValue(before),
      after: auditValue(after, decisions, reviewer),
      actorUserId: reviewer.id,
      actorUsername: reviewer.name,
    },
  })
}

async function findReviewByKey(db, scope, key) {
  return db.replenishmentOrder.findUnique({
    where: { reviewIdempotencyScope_reviewIdempotencyKey: { reviewIdempotencyScope: scope, reviewIdempotencyKey: key } },
    include: orderInclude,
  })
}

function replay(existing, { orderId, payloadDigest }) {
  if (existing.id !== orderId || existing.reviewPayloadDigest !== payloadDigest) {
    throw reviewError('相同 Idempotency-Key 的审核内容不一致', 'REPLENISHMENT_REVIEW_IDEMPOTENCY_MISMATCH', 409)
  }
  return { order: existing, reused: true }
}

function uniqueConflict(error) {
  return error?.code === 'P2002' || error?.code === '23505'
}

export async function previewReplenishmentApproval({ db, actor, orderId, body, now = new Date() }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw reviewError('补货申请 ID 不正确')
  const normalized = normalizeApproval(body)
  await authorizeReplenishmentReviewer({ db, actor, now })
  const order = await db.replenishmentOrder.findUnique({ where: { id }, include: orderInclude })
  if (!order) throw reviewError('补货申请不存在', 'REPLENISHMENT_ORDER_NOT_FOUND', 404)
  if (order.status !== REPLENISHMENT_ORDER_STATUSES.SUBMITTED || order.version !== normalized.version) {
    throw reviewError('订单已被处理，请刷新后重试', 'REPLENISHMENT_REVIEW_STALE', 409)
  }
  const approved = buildApprovedDecisions(order, normalized)
  return {
    approvedTotalAmountCents: approved.total.toString(),
    items: approved.decisions.map((decision) => ({
      itemId: decision.item.id,
      approvedQuantityBase: decision.approvedQuantityBase,
      approvedLineAmountCents: decision.approvedLineAmountCents.toString(),
    })),
  }
}

export async function reviewReplenishmentOrder({ db, actor, orderId, action, body, idempotencyKey, now = new Date() }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw reviewError('补货申请 ID 不正确')
  if (!Object.values(REPLENISHMENT_REVIEW_ACTIONS).includes(action)) throw reviewError('审核动作不正确')
  const normalized = action === REPLENISHMENT_REVIEW_ACTIONS.APPROVE ? normalizeApproval(body) : normalizeRejection(body)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const actorId = String(actor?.id || '').trim()
  if (!actorId) throw reviewError('审核人身份不正确', 'REPLENISHMENT_REVIEW_ACTOR_INVALID', 403)
  const scope = reviewScope(actorId)
  const payloadDigest = digest(action, id, normalized)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const prior = await findReviewByKey(tx, scope, key)
        if (prior) return replay(prior, { orderId: id, payloadDigest })
        const authorization = await authorizeReplenishmentReviewer({ db: tx, actor: { id: actorId }, now })
        const before = await tx.replenishmentOrder.findUnique({ where: { id }, include: orderInclude })
        if (!before) throw reviewError('补货申请不存在', 'REPLENISHMENT_ORDER_NOT_FOUND', 404)
        if (before.status !== REPLENISHMENT_ORDER_STATUSES.SUBMITTED || before.version !== normalized.version) {
          throw reviewError('订单已被其他审核人处理，请刷新', 'REPLENISHMENT_REVIEW_STALE', 409)
        }

        const reviewedAt = new Date(now)
        let approved = { decisions: [], total: null }
        if (action === REPLENISHMENT_REVIEW_ACTIONS.APPROVE) {
          approved = buildApprovedDecisions(before, normalized)
          for (const decision of approved.decisions) {
            const changed = await tx.replenishmentOrderItem.updateMany({
              where: { id: decision.item.id, replenishmentOrderId: before.id, approvedQuantityBase: null },
              data: {
                approvedQuantityBase: decision.approvedQuantityBase,
                approvedLineAmountCents: decision.approvedLineAmountCents,
                reviewReason: decision.reason,
              },
            })
            if (changed.count !== 1) throw reviewError('审核商品行已被处理，请刷新', 'REPLENISHMENT_REVIEW_STALE', 409)
          }
        }

        const nextStatus = action === REPLENISHMENT_REVIEW_ACTIONS.APPROVE
          ? REPLENISHMENT_ORDER_STATUSES.APPROVED
          : REPLENISHMENT_ORDER_STATUSES.REJECTED
        const changed = await tx.replenishmentOrder.updateMany({
          where: { id: before.id, status: REPLENISHMENT_ORDER_STATUSES.SUBMITTED, version: normalized.version, reviewAction: null },
          data: {
            status: nextStatus,
            approvedTotalAmountCents: approved.total,
            reviewAction: action,
            reviewReason: normalized.reason,
            reviewedAt,
            reviewedByActorId: authorization.actor.id,
            reviewedByActorName: authorization.actor.name,
            reviewIdempotencyScope: scope,
            reviewIdempotencyKey: key,
            reviewPayloadDigest: payloadDigest,
            version: { increment: 1 },
          },
        })
        if (changed.count !== 1) throw reviewError('订单已被其他审核人处理，请刷新', 'REPLENISHMENT_REVIEW_STALE', 409)
        const after = await tx.replenishmentOrder.findUnique({ where: { id: before.id }, include: orderInclude })
        await writeReviewAudit(tx, { before, after, decisions: approved.decisions, reviewer: authorization.actor })
        return { order: after, reused: false }
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 })
    } catch (error) {
      if (isRetryableTransactionConflict(error)) continue
      if (uniqueConflict(error)) {
        const prior = await findReviewByKey(db, scope, key)
        if (prior) return replay(prior, { orderId: id, payloadDigest })
        continue
      }
      throw error
    }
  }
  const prior = await findReviewByKey(db, scope, key)
  if (prior) return replay(prior, { orderId: id, payloadDigest })
  throw reviewError('审核发生并发冲突，请刷新', 'REPLENISHMENT_REVIEW_CONFLICT', 409)
}

export async function listReplenishmentReviewOrders({ db, actor, status = '', now = new Date() }) {
  const authorization = await authorizeReplenishmentReviewer({ db, actor, now })
  const normalizedStatus = String(status || '').trim().toUpperCase()
  if (normalizedStatus && !Object.values(REPLENISHMENT_ORDER_STATUSES).includes(normalizedStatus)) throw reviewError('订单状态筛选不正确')
  const rows = await db.replenishmentOrder.findMany({
    where: normalizedStatus ? { status: normalizedStatus } : {},
    include: orderInclude,
    orderBy: { submittedAt: 'desc' },
    take: 500,
  })
  return { authorization, rows }
}

export async function getReplenishmentReviewOrder({ db, actor, orderId, now = new Date() }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw reviewError('补货申请 ID 不正确')
  const authorization = await authorizeReplenishmentReviewer({ db, actor, now })
  const order = await db.replenishmentOrder.findUnique({ where: { id }, include: orderInclude })
  if (!order) throw reviewError('补货申请不存在', 'REPLENISHMENT_ORDER_NOT_FOUND', 404)
  return { authorization, order }
}
