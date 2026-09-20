import { isRetryableTransactionConflict } from './transaction-conflict.js'
import crypto from 'node:crypto'
import { assertPartnerCanCreateBusiness, assertPartnerStoreCanCreateBusiness } from './partner-domain-policy.js'
import { isCatalogueEligible, partnerBasePriceCents, partnerCatalogueSelect } from './partner-replenishment-catalogue.js'
import { calculatePartnerAmountCents, normalizePositiveSafeInteger, PARTNER_ORDER_UNITS } from './partner-replenishment-pricing.js'
import { partnerScopedWhere } from './principals.js'
import { httpError } from './pos-core.js'
import { appendPurposeAudit, assertPurposeActor, cleanReason } from './order-purpose-service.js'
import { isTestOrderPurpose } from '../shared/orderPurpose.js'

export const REPLENISHMENT_ORDER_STATUSES = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  CANCELLED: 'CANCELLED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PARTIALLY_SHIPPED: 'PARTIALLY_SHIPPED',
  SHIPPED: 'SHIPPED',
})
export const REPLENISHMENT_CREATED_BY_TYPES = Object.freeze({ PARTNER: 'PARTNER', INTERNAL: 'INTERNAL' })
const OPERATION = 'REPLENISHMENT_ORDER_CREATE'
const MAX_ITEMS = 100
const MAX_ORDER_TOTAL_CENTS = 99_999_999_999n

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
const orderProductSelect = Object.freeze({ ...partnerCatalogueSelect, transferCode: true })
const topLevelKeys = Object.freeze({
  PARTNER: new Set(['partnerStoreId', 'items']),
  INTERNAL: new Set(['partnerId', 'partnerStoreId', 'items']),
})
const itemKeys = new Set(['inventoryItemId', 'quantity', 'orderUnit'])

function orderError(message, code = 'REPLENISHMENT_ORDER_INVALID', status = 400) {
  const error = httpError(message, status)
  error.code = code
  return error
}

function assertExactKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw orderError('补货申请格式不正确', code)
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw orderError(`不接受客户端字段：${unexpected}`, 'REPLENISHMENT_AUTHORITY_INPUT_REJECTED')
}

export function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw orderError('Idempotency-Key 必须为 8-100 位安全字符', 'REPLENISHMENT_IDEMPOTENCY_KEY_INVALID')
  return key
}

export function normalizeReplenishmentSubmission(body, createdByType) {
  const allowed = topLevelKeys[createdByType]
  if (!allowed) throw orderError('创建来源不正确', 'REPLENISHMENT_SOURCE_INVALID')
  assertExactKeys(body, allowed, 'REPLENISHMENT_SUBMISSION_INVALID')
  const partnerId = createdByType === REPLENISHMENT_CREATED_BY_TYPES.INTERNAL ? String(body.partnerId || '').trim() : ''
  const partnerStoreId = String(body.partnerStoreId || '').trim()
  if (createdByType === REPLENISHMENT_CREATED_BY_TYPES.INTERNAL && (!partnerId || partnerId.length > 120)) throw orderError('合作商 ID 不正确')
  if (!partnerStoreId || partnerStoreId.length > 120) throw orderError('合作门店 ID 不正确')
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ITEMS) throw orderError(`补货申请必须包含 1-${MAX_ITEMS} 个商品`)
  const seen = new Set()
  const items = body.items.map((item) => {
    assertExactKeys(item, itemKeys, 'REPLENISHMENT_ITEM_INVALID')
    const inventoryItemId = String(item.inventoryItemId || '').trim()
    if (!inventoryItemId || inventoryItemId.length > 120) throw orderError('商品 ID 不正确')
    if (seen.has(inventoryItemId)) throw orderError('同一商品不能重复提交', 'REPLENISHMENT_DUPLICATE_ITEM', 409)
    seen.add(inventoryItemId)
    const requestedUnit = item.orderUnit == null || item.orderUnit === '' ? '' : String(item.orderUnit).trim().toUpperCase()
    if (requestedUnit && !Object.values(PARTNER_ORDER_UNITS).includes(requestedUnit)) throw orderError('补货单位不正确', 'REPLENISHMENT_UNIT_INVALID')
    return { inventoryItemId, quantity: normalizePositiveSafeInteger(item.quantity), requestedUnit }
  }).sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))
  return { partnerId, partnerStoreId, items }
}

export function replenishmentPayloadDigest({ partnerId, partnerStoreId, items }) {
  return crypto.createHash('sha256').update(JSON.stringify({ partnerId, partnerStoreId, items })).digest('hex')
}

function idempotencyScope({ createdByType, actorId, partnerId }) {
  return `${createdByType}:${actorId}:${partnerId}:${OPERATION}`
}

function orderNumber(now = new Date()) {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  return `RPL-${date}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`
}

function auditSnapshot(order) {
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status,
    partnerStoreId: order.partnerStoreId,
    createdByType: order.createdByType,
    requestedTotalAmountCents: order.requestedTotalAmountCents.toString(),
    cancelledAt: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
  }
}

async function appendOrderAudit(tx, { order, action, actor, before = null }) {
  await tx.partnerAuditLog.create({
    data: {
      id: crypto.randomUUID(),
      partnerId: order.partnerId,
      entityType: 'REPLENISHMENT_ORDER',
      entityId: order.id,
      action,
      before: before ? auditSnapshot(before) : null,
      after: auditSnapshot(order),
      actorUserId: String(actor.id),
      actorUsername: String(actor.name || ''),
    },
  })
}

async function actorWithName(tx, actor) {
  if (actor.name) return actor
  const user = await tx.user.findUnique({ where: { id: actor.id }, select: { username: true } })
  if (!user) throw orderError('创建人身份已失效', 'REPLENISHMENT_ACTOR_INVALID', 403)
  return { ...actor, name: String(user.username || '') }
}

function buildItemSnapshots(products, normalizedItems, discountBps) {
  const byId = new Map(products.map((product) => [product.id, product]))
  let total = 0n
  const rows = normalizedItems.map((input) => {
    const product = byId.get(input.inventoryItemId)
    if (!isCatalogueEligible(product)) throw orderError('商品当前不可补货，请刷新 Catalogue', 'REPLENISHMENT_PRODUCT_UNAVAILABLE', 409)
    if (input.requestedUnit && input.requestedUnit !== product.partnerOrderUnit) throw orderError('请求单位与商品补货单位不一致', 'REPLENISHMENT_UNIT_MISMATCH', 409)
    const quantity = normalizePositiveSafeInteger(input.quantity)
    const basePrice = partnerBasePriceCents(product)
    const lineAmount = calculatePartnerAmountCents({ orderUnit: product.partnerOrderUnit, quantityBase: quantity, basePriceCents: basePrice, discountBps })
    if (lineAmount <= 0n) throw orderError('补货商品行金额无效', 'REPLENISHMENT_LINE_AMOUNT_INVALID', 409)
    total += lineAmount
    if (total > MAX_ORDER_TOTAL_CENTS) throw orderError('补货申请金额超出允许范围', 'REPLENISHMENT_TOTAL_OVERFLOW', 409)
    return {
      id: `rpli-${crypto.randomUUID()}`,
      inventoryItemId: product.id,
      productNameSnapshot: product.name,
      skuSnapshot: product.sku || '',
      productCodeSnapshot: product.transferCode || product.sku || '',
      orderUnitSnapshot: product.partnerOrderUnit,
      nativeUnitSnapshot: product.partnerOrderUnit === PARTNER_ORDER_UNITS.NATIVE ? String(product.unit || '').trim() : '',
      requestedQuantityBase: quantity,
      basePriceSnapshotCents: basePrice,
      discountBpsSnapshot: discountBps,
      requestedLineAmountCents: lineAmount,
      minimumOrderBaseQtySnapshot: 1,
      orderStepBaseQtySnapshot: 1,
    }
  })
  return { rows, total }
}

async function findByIdempotency(db, scope, key) {
  return db.replenishmentOrder.findUnique({
    where: { idempotencyScope_idempotencyKey: { idempotencyScope: scope, idempotencyKey: key } },
    include: orderInclude,
  })
}

function replay(existing, digest) {
  if (existing.idempotencyPayloadDigest !== digest) throw orderError('相同 Idempotency-Key 的请求内容不一致', 'REPLENISHMENT_IDEMPOTENCY_MISMATCH', 409)
  return { order: existing, reused: true }
}

function uniqueConstraintError(error) {
  return error?.code === 'P2002' || error?.code === '23505'
}

export async function createReplenishmentOrder({ db, createdByType, actor, principalPartnerId = '', body, idempotencyKey, testPurpose = null, testReason = '' }) {
  if (testPurpose && (!isTestOrderPurpose(testPurpose) || createdByType !== 'INTERNAL')) throw orderError('测试用途入口无效', 'TEST_ORDER_CREATE_FORBIDDEN', 403)
  if (testPurpose) cleanReason(testReason)
  const normalized = normalizeReplenishmentSubmission(body, createdByType)
  const partnerId = createdByType === REPLENISHMENT_CREATED_BY_TYPES.PARTNER ? String(principalPartnerId || '') : normalized.partnerId
  if (!partnerId) throw orderError('合作商身份不正确', 'REPLENISHMENT_PARTNER_INVALID')
  const by = { id: String(actor?.id || ''), name: String(actor?.name || '') }
  if (!by.id) throw orderError('创建人身份不正确', 'REPLENISHMENT_ACTOR_INVALID', 403)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const ordinaryDigest = replenishmentPayloadDigest({ ...normalized, partnerId })
  const digest = testPurpose ? crypto.createHash('sha256').update(`${testPurpose}\0${ordinaryDigest}`).digest('hex') : ordinaryDigest
  const scope = idempotencyScope({ createdByType, actorId: by.id, partnerId }) + (testPurpose ? ':TEST_ENTRY' : '')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const testActor = testPurpose ? await assertPurposeActor(tx, by.id) : null
        const replayHash = crypto.createHash('sha256').update(`${scope}\0${key}`).digest('hex')
        if (await tx.orderPurposeAudit.findFirst({ where: { orderType: 'partner', action: 'DELETE_TEST', snapshot: { path: ['creationReplayHash'], equals: replayHash } } })) {
          throw orderError('该请求对应的测试订单已删除', 'ORDER_NOT_FOUND_OR_DELETED', 410)
        }
        const existing = await findByIdempotency(tx, scope, key)
        if (existing) return replay(existing, digest)
        const partner = await tx.partner.findUnique({ where: { id: partnerId } })
        if (!partner) throw orderError('合作商不存在', 'REPLENISHMENT_PARTNER_NOT_FOUND', 404)
        assertPartnerCanCreateBusiness(partner)
        const store = await tx.partnerStore.findFirst({ where: { id: normalized.partnerStoreId, partnerId } })
        if (!store) throw orderError('合作门店不存在', 'REPLENISHMENT_STORE_NOT_FOUND', 404)
        assertPartnerStoreCanCreateBusiness(store)
        const products = await tx.inventoryItem.findMany({
          where: { id: { in: normalized.items.map((item) => item.inventoryItemId) } },
          select: orderProductSelect,
        })
        if (products.length !== normalized.items.length) throw orderError('商品当前不可补货，请刷新 Catalogue', 'REPLENISHMENT_PRODUCT_UNAVAILABLE', 409)
        const snapshot = buildItemSnapshots(products, normalized.items, partner.defaultDiscountBps)
        const actualActor = await actorWithName(tx, by)
        const submittedAt = new Date()
        const order = await tx.replenishmentOrder.create({
          data: {
            id: `rpl-${crypto.randomUUID()}`,
            purpose: testPurpose || 'REAL',
            orderNo: orderNumber(submittedAt),
            partnerId,
            partnerStoreId: store.id,
            partnerNameSnapshot: partner.name,
            partnerStoreNameSnapshot: store.name,
            contactNameSnapshot: store.contactName || '',
            phoneSnapshot: store.phone || '',
            provinceSnapshot: store.province || '',
            citySnapshot: store.city || '',
            districtSnapshot: store.district || '',
            addressLineSnapshot: store.addressLine || '',
            status: REPLENISHMENT_ORDER_STATUSES.SUBMITTED,
            createdByType,
            createdByActorId: actualActor.id,
            createdByActorName: actualActor.name,
            submittedAt,
            requestedTotalAmountCents: snapshot.total,
            idempotencyScope: scope,
            idempotencyKey: key,
            idempotencyPayloadDigest: digest,
            items: { create: snapshot.rows },
          },
          include: orderInclude,
        })
        await appendOrderAudit(tx, { order, action: 'REPLENISHMENT_ORDER_CREATED', actor: actualActor })
        if (testActor) await appendPurposeAudit(tx, { actor: testActor, type: 'partner', order, action: 'CREATE_TEST', reason: testReason, afterPurpose: testPurpose })
        return { order, reused: false }
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 })
    } catch (error) {
      if (isRetryableTransactionConflict(error)) continue
      if (uniqueConstraintError(error)) {
        const existing = await findByIdempotency(db, scope, key)
        if (existing) return replay(existing, digest)
        continue
      }
      throw error
    }
  }
  const existing = await findByIdempotency(db, scope, key)
  if (existing) return replay(existing, digest)
  throw orderError('补货申请并发冲突，请重试', 'REPLENISHMENT_CONCURRENCY_CONFLICT', 409)
}

export function serializeReplenishmentOrder(order, { internal = false } = {}) {
  const shippedByItem = new Map()
  for (const shipment of order.shipments || []) {
    for (const item of shipment.items || []) {
      shippedByItem.set(item.replenishmentOrderItemId, (shippedByItem.get(item.replenishmentOrderItemId) || 0) + Number(item.shippedQuantityBase || 0))
    }
  }
  const dto = {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    purpose: order.purpose,
    createdByType: order.createdByType,
    partnerStore: {
      id: order.partnerStoreId,
      name: order.partnerStoreNameSnapshot,
      contactName: order.contactNameSnapshot,
      phone: order.phoneSnapshot,
      province: order.provinceSnapshot,
      city: order.citySnapshot,
      district: order.districtSnapshot,
      addressLine: order.addressLineSnapshot,
    },
    requestedTotalAmountCents: order.requestedTotalAmountCents.toString(),
    approvedTotalAmountCents: order.approvedTotalAmountCents == null ? null : order.approvedTotalAmountCents.toString(),
    submittedAt: new Date(order.submittedAt).toISOString(),
    cancelledAt: order.cancelledAt ? new Date(order.cancelledAt).toISOString() : null,
    reviewedAt: order.reviewedAt ? new Date(order.reviewedAt).toISOString() : null,
    reviewReason: order.reviewReason || '',
    items: (order.items || []).map((item) => {
      const shippedQuantityBase = shippedByItem.get(item.id) || (item.shipmentItems || []).reduce((sum, row) => sum + Number(row.shippedQuantityBase || 0), 0)
      const remainingQuantityBase = item.approvedQuantityBase == null ? null : Math.max(0, item.approvedQuantityBase - shippedQuantityBase)
      return {
        inventoryItemId: item.inventoryItemId,
        productNameSnapshot: item.productNameSnapshot,
        skuSnapshot: item.skuSnapshot,
        productCodeSnapshot: item.productCodeSnapshot,
        orderUnitSnapshot: item.orderUnitSnapshot,
        nativeUnitSnapshot: item.nativeUnitSnapshot || '',
        requestedQuantityBase: item.requestedQuantityBase,
        basePriceSnapshotCents: item.basePriceSnapshotCents.toString(),
        discountBpsSnapshot: item.discountBpsSnapshot,
        requestedLineAmountCents: item.requestedLineAmountCents.toString(),
        minimumOrderBaseQtySnapshot: item.minimumOrderBaseQtySnapshot,
        orderStepBaseQtySnapshot: item.orderStepBaseQtySnapshot,
        approvedQuantityBase: item.approvedQuantityBase == null ? null : item.approvedQuantityBase,
        approvedLineAmountCents: item.approvedLineAmountCents == null ? null : item.approvedLineAmountCents.toString(),
        reviewReason: item.reviewReason || '',
        shippedQuantityBase,
        remainingQuantityBase,
      }
    }),
    shipments: (order.shipments || []).map((shipment) => ({
      id: shipment.id,
      shipmentNo: shipment.shipmentNo,
      fulfillmentStoreKey: shipment.fulfillmentStoreKey,
      fulfillmentStoreName: shipment.fulfillmentStoreSnapshot,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      freightType: shipment.freightType,
      shippedAt: new Date(shipment.shippedAt).toISOString(),
      items: (shipment.items || []).map((item) => ({
        id: item.id,
        orderItemId: item.replenishmentOrderItemId,
        productNameSnapshot: item.productNameSnapshot,
        orderUnitSnapshot: item.orderUnitSnapshot,
        nativeUnitSnapshot: item.nativeUnitSnapshot || '',
        shippedQuantityBase: item.shippedQuantityBase,
      })),
    })),
  }
  if (internal) Object.assign(dto, {
    version: order.version,
    partnerId: order.partnerId,
    partnerNameSnapshot: order.partnerNameSnapshot,
    partnerStoreId: order.partnerStoreId,
    createdByActorId: order.createdByActorId,
    createdByActorName: order.createdByActorName,
    cancelledByType: order.cancelledByType,
    cancelledByActorId: order.cancelledByActorId,
    cancelledByActorName: order.cancelledByActorName,
    reviewedByActorId: order.reviewedByActorId,
    reviewedByActorName: order.reviewedByActorName,
  })
  if (internal) dto.items = dto.items.map((item, index) => ({ id: order.items[index].id, ...item }))
  if (internal) dto.shipments = dto.shipments.map((shipment, index) => ({
    ...shipment,
    createdByActorId: order.shipments[index].createdByActorId,
    createdByActorName: order.shipments[index].createdByActorName,
  }))
  return dto
}

export async function listPartnerReplenishmentOrders({ db, principal }) {
  return db.replenishmentOrder.findMany({
    where: partnerScopedWhere(principal),
    include: orderInclude,
    orderBy: { submittedAt: 'desc' },
    take: 200,
  })
}

export async function getPartnerReplenishmentOrder({ db, principal, orderId }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw orderError('补货申请 ID 不正确')
  return db.replenishmentOrder.findFirst({ where: partnerScopedWhere(principal, { id }), include: orderInclude })
}

export async function cancelPartnerReplenishmentOrder({ db, principal, orderId }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw orderError('补货申请 ID 不正确')
  const actor = { id: principal.userId, name: '' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const existing = await tx.replenishmentOrder.findFirst({ where: partnerScopedWhere(principal, { id }), include: orderInclude })
        if (!existing) throw orderError('补货申请不存在', 'REPLENISHMENT_ORDER_NOT_FOUND', 404)
        if (existing.status === REPLENISHMENT_ORDER_STATUSES.CANCELLED) return { order: existing, reused: true }
        if (existing.status !== REPLENISHMENT_ORDER_STATUSES.SUBMITTED) throw orderError('当前状态不允许合作商取消', 'REPLENISHMENT_CANCEL_DENIED', 409)
        const actualActor = await actorWithName(tx, actor)
        const cancelledAt = new Date()
        const changed = await tx.replenishmentOrder.updateMany({
          where: { id: existing.id, partnerId: principal.partnerId, status: REPLENISHMENT_ORDER_STATUSES.SUBMITTED, version: existing.version },
          data: {
            status: REPLENISHMENT_ORDER_STATUSES.CANCELLED,
            cancelledAt,
            cancelledByType: REPLENISHMENT_CREATED_BY_TYPES.PARTNER,
            cancelledByActorId: actualActor.id,
            cancelledByActorName: actualActor.name,
            version: { increment: 1 },
          },
        })
        if (changed.count !== 1) throw orderError('补货申请已被更新，请刷新后重试', 'REPLENISHMENT_CANCEL_CONFLICT', 409)
        const order = await tx.replenishmentOrder.findUnique({ where: { id: existing.id }, include: orderInclude })
        await appendOrderAudit(tx, { order, action: 'REPLENISHMENT_ORDER_CANCELLED', actor: actualActor, before: existing })
        return { order, reused: false }
      }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 })
    } catch (error) {
      if (isRetryableTransactionConflict(error)) continue
      throw error
    }
  }
  const latest = await db.replenishmentOrder.findFirst({ where: partnerScopedWhere(principal, { id }), include: orderInclude })
  if (latest?.status === REPLENISHMENT_ORDER_STATUSES.CANCELLED) return { order: latest, reused: true }
  throw orderError('补货申请并发冲突，请重试', 'REPLENISHMENT_CANCEL_CONFLICT', 409)
}

export async function listInternalReplenishmentOrders({ db }) {
  return db.replenishmentOrder.findMany({ include: orderInclude, orderBy: { submittedAt: 'desc' }, take: 500 })
}

export async function getInternalReplenishmentOrder({ db, orderId }) {
  const id = String(orderId || '').trim()
  if (!id || id.length > 120) throw orderError('补货申请 ID 不正确')
  return db.replenishmentOrder.findUnique({ where: { id }, include: orderInclude })
}
