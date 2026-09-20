import { isRetryableTransactionConflict } from './transaction-conflict.js'
import crypto from 'node:crypto'
import { normalizeIdempotencyKey, REPLENISHMENT_ORDER_STATUSES } from './replenishment-order-service.js'
import { MAX_PARTNER_BASE_QUANTITY } from './partner-replenishment-pricing.js'
import { authorizeReplenishmentShipper, PARTNER_REPLENISHMENT_REVIEW_STORE_KEY } from './replenishment-review-authorization.js'

export const REPLENISHMENT_FREIGHT_TYPES = Object.freeze({ PREPAID: 'PREPAID', COLLECT: 'COLLECT' })
const ALLOWED_ORDER_STATES = new Set([
  REPLENISHMENT_ORDER_STATUSES.APPROVED,
  REPLENISHMENT_ORDER_STATUSES.PARTIALLY_SHIPPED,
])
const SHIPMENT_KEYS = new Set(['fulfillmentStoreKey', 'carrier', 'trackingNumber', 'freightType', 'items'])
const ITEM_KEYS = new Set(['orderItemId', 'shippedQuantityBase'])
const SHIPMENT_OPERATION = 'REPLENISHMENT_SHIPMENT_CREATE'
const MAX_ITEMS = 100

const shipmentInclude = Object.freeze({
  items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
})

function shipmentError(message, code = 'REPLENISHMENT_SHIPMENT_INVALID', status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function exactObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw shipmentError('发货请求格式不正确')
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra) throw shipmentError(`不接受客户端字段：${extra}`, 'REPLENISHMENT_SHIPMENT_AUTHORITY_INPUT_REJECTED')
}

function boundedText(value, label, max) {
  const result = String(value || '').trim()
  if (!result || result.length > max) throw shipmentError(`${label}必须填写且不超过 ${max} 字`)
  return result
}

function positiveQuantity(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw shipmentError('发货数量必须是正整数')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_PARTNER_BASE_QUANTITY) {
    throw shipmentError(`发货数量必须是 1-${MAX_PARTNER_BASE_QUANTITY} 的安全整数`)
  }
  return result
}

export function normalizeShipment(body) {
  exactObject(body, SHIPMENT_KEYS)
  const fulfillmentStoreKey = String(body.fulfillmentStoreKey || PARTNER_REPLENISHMENT_REVIEW_STORE_KEY).trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(fulfillmentStoreKey)) throw shipmentError('发货门店 key 不正确')
  const freightType = String(body.freightType || '').trim().toUpperCase()
  if (!Object.values(REPLENISHMENT_FREIGHT_TYPES).includes(freightType)) throw shipmentError('运费方式必须为寄付或到付')
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ITEMS) {
    throw shipmentError(`每批发货必须包含 1-${MAX_ITEMS} 个商品`)
  }
  const seen = new Set()
  const items = body.items.map((item) => {
    exactObject(item, ITEM_KEYS)
    const orderItemId = String(item.orderItemId || '').trim()
    if (!orderItemId || orderItemId.length > 120) throw shipmentError('发货商品行 ID 不正确')
    if (seen.has(orderItemId)) throw shipmentError('同一批次不能重复发货同一商品', 'REPLENISHMENT_SHIPMENT_DUPLICATE_ITEM', 409)
    seen.add(orderItemId)
    return { orderItemId, shippedQuantityBase: positiveQuantity(item.shippedQuantityBase) }
  }).sort((left, right) => left.orderItemId.localeCompare(right.orderItemId))
  return {
    fulfillmentStoreKey,
    carrier: boundedText(body.carrier, '快递公司', 80),
    trackingNumber: boundedText(body.trackingNumber, '快递单号', 120),
    freightType,
    items,
  }
}

function shipmentScope(actorId, orderId) {
  return `${actorId}:${orderId}:${SHIPMENT_OPERATION}`
}

function payloadDigest(orderId, normalized) {
  return crypto.createHash('sha256').update(JSON.stringify({ orderId, ...normalized })).digest('hex')
}

function shipmentNumber(now = new Date()) {
  return `RPS-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`
}

async function findByKey(db, scope, key) {
  return db.replenishmentShipment.findUnique({
    where: { idempotencyScope_idempotencyKey: { idempotencyScope: scope, idempotencyKey: key } },
    include: shipmentInclude,
  })
}

function replay(shipment, orderId, digest) {
  if (shipment.replenishmentOrderId !== orderId || shipment.idempotencyPayloadDigest !== digest) {
    throw shipmentError('相同 Idempotency-Key 的发货内容不一致', 'REPLENISHMENT_SHIPMENT_IDEMPOTENCY_MISMATCH', 409)
  }
  return { shipment, reused: true }
}

function uniqueConflict(error) {
  return error?.code === 'P2002' || error?.code === '23505'
}

async function lockOrder(tx, orderId) {
  if (typeof tx.$queryRawUnsafe !== 'function') return
  await tx.$queryRawUnsafe('SELECT "id" FROM "ReplenishmentOrder" WHERE "id" = $1 FOR UPDATE', orderId)
}

async function lockItems(tx, itemIds) {
  if (typeof tx.$queryRawUnsafe !== 'function') return
  for (const itemId of [...itemIds].sort()) {
    await tx.$queryRawUnsafe('SELECT "id" FROM "ReplenishmentOrderItem" WHERE "id" = $1 FOR UPDATE', itemId)
  }
}

function shippedSoFar(item) {
  return (item.shipmentItems || []).reduce((sum, row) => sum + Number(row.shippedQuantityBase || 0), 0)
}

function shipmentAuditValue(shipment) {
  return {
    shipmentId: shipment.id,
    shipmentNo: shipment.shipmentNo,
    orderId: shipment.replenishmentOrderId,
    fulfillmentStoreKey: shipment.fulfillmentStoreKey,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    freightType: shipment.freightType,
    shippedAt: new Date(shipment.shippedAt).toISOString(),
    items: (shipment.items || []).map((item) => ({
      orderItemId: item.replenishmentOrderItemId,
      orderUnit: item.orderUnitSnapshot,
      shippedQuantityBase: item.shippedQuantityBase,
    })),
  }
}

export async function createReplenishmentShipment({ db, actor, orderId, body, idempotencyKey, now = new Date() }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw shipmentError('补货订单 ID 不正确')
  const actorId = String(actor?.id || '').trim()
  if (!actorId) throw shipmentError('发货人身份不正确', 'REPLENISHMENT_SHIPMENT_ACTOR_INVALID', 403)
  const normalized = normalizeShipment(body)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const scope = shipmentScope(actorId, id)
  const digest = payloadDigest(id, normalized)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const authorization = await authorizeReplenishmentShipper({ db: tx, actor: { id: actorId }, now })
        const prior = await findByKey(tx, scope, key)
        if (prior) return replay(prior, id, digest)

        await lockOrder(tx, id)
        await lockItems(tx, normalized.items.map((item) => item.orderItemId))
        const order = await tx.replenishmentOrder.findUnique({
          where: { id },
          include: { items: { include: { shipmentItems: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        })
        if (!order) throw shipmentError('补货订单不存在', 'REPLENISHMENT_ORDER_NOT_FOUND', 404)
        if (!ALLOWED_ORDER_STATES.has(order.status)) {
          throw shipmentError('只有待发货或部分发货订单可以创建物流批次', 'REPLENISHMENT_SHIPMENT_ORDER_STATE_INVALID', 409)
        }

        const store = await tx.store.findUnique({ where: { key: normalized.fulfillmentStoreKey }, select: { key: true, name: true, active: true } })
        if (!store?.active) throw shipmentError('发货门店不存在或已停用', 'REPLENISHMENT_SHIPMENT_STORE_INVALID', 409)

        const byId = new Map(order.items.map((item) => [item.id, item]))
        const rows = normalized.items.map((input) => {
          const item = byId.get(input.orderItemId)
          if (!item) throw shipmentError('发货商品不属于该订单', 'REPLENISHMENT_SHIPMENT_ITEM_MISMATCH', 409)
          if (!Number.isSafeInteger(item.approvedQuantityBase) || item.approvedQuantityBase <= 0) {
            throw shipmentError('本次不发商品不能进入 Shipment', 'REPLENISHMENT_SHIPMENT_ITEM_NOT_APPROVED', 409)
          }
          const remaining = item.approvedQuantityBase - shippedSoFar(item)
          if (input.shippedQuantityBase > remaining) {
            throw shipmentError('发货数量超过剩余确认数量', 'REPLENISHMENT_SHIPMENT_OVER_SHIP', 409)
          }
          return {
            id: `rpsi-${crypto.randomUUID()}`,
            replenishmentOrderItemId: item.id,
            productNameSnapshot: item.productNameSnapshot,
            orderUnitSnapshot: item.orderUnitSnapshot,
            nativeUnitSnapshot: item.nativeUnitSnapshot || '',
            shippedQuantityBase: input.shippedQuantityBase,
          }
        })

        const shippedAt = new Date(now)
        const shipment = await tx.replenishmentShipment.create({
          data: {
            id: `rps-${crypto.randomUUID()}`,
            shipmentNo: shipmentNumber(shippedAt),
            replenishmentOrderId: order.id,
            fulfillmentStoreKey: store.key,
            fulfillmentStoreSnapshot: store.name,
            carrier: normalized.carrier,
            trackingNumber: normalized.trackingNumber,
            freightType: normalized.freightType,
            shippedAt,
            createdByActorId: authorization.actor.id,
            createdByActorName: authorization.actor.name,
            idempotencyScope: scope,
            idempotencyKey: key,
            idempotencyPayloadDigest: digest,
            items: { create: rows },
          },
          include: shipmentInclude,
        })
        await tx.partnerAuditLog.create({
          data: {
            id: crypto.randomUUID(),
            partnerId: order.partnerId,
            entityType: 'REPLENISHMENT_SHIPMENT',
            entityId: shipment.id,
            action: 'REPLENISHMENT_SHIPMENT_CREATED',
            before: null,
            after: shipmentAuditValue(shipment),
            actorUserId: authorization.actor.id,
            actorUsername: authorization.actor.name,
          },
        })
        return { shipment, reused: false }
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 })
    } catch (error) {
      if (isRetryableTransactionConflict(error, { allowDirectDeadlock: true })) continue
      if (uniqueConflict(error)) {
        const prior = await findByKey(db, scope, key)
        if (prior) return replay(prior, id, digest)
        continue
      }
      throw error
    }
  }
  const prior = await findByKey(db, scope, key)
  if (prior) return replay(prior, id, digest)
  throw shipmentError('发货发生并发冲突，请刷新后重试', 'REPLENISHMENT_SHIPMENT_CONFLICT', 409)
}

export async function listFulfillmentStores({ db, actor, now = new Date() }) {
  const authorization = await authorizeReplenishmentShipper({ db, actor, now })
  const rows = await db.store.findMany({
    where: { active: true },
    select: { key: true, name: true },
    orderBy: [{ name: 'asc' }, { key: 'asc' }],
  })
  return { authorization, rows }
}
