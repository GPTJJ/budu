import crypto from 'node:crypto'
import { canManagePartnerDomain } from '../shared/accountPermissions.js'
import { storeAssetData, readAssetData } from './asset-storage.js'
import { partnerScopedWhere } from './principals.js'
import { httpError } from './pos-core.js'

export const AFTER_SALES_TYPES = Object.freeze(['DAMAGED', 'WRONG_ITEM', 'RETURN'])
export const AFTER_SALES_STATUSES = Object.freeze(['PENDING', 'PROCESSING', 'RESOLVED', 'REJECTED'])
const CREATE_KEYS = new Set(['orderId', 'shipmentItemId', 'type', 'quantityBase', 'description', 'attachments'])
const PROCESS_KEYS = new Set(['status', 'reason', 'version'])
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function fail(message, code = 'REPLENISHMENT_AFTER_SALES_INVALID', status = 400) {
  const error = httpError(message, status); error.code = code; return error
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('售后请求格式不正确')
  const unexpected = Object.keys(value).find((key) => !keys.has(key))
  if (unexpected) throw fail(`不接受客户端字段：${unexpected}`, 'REPLENISHMENT_AFTER_SALES_AUTHORITY_INPUT_REJECTED')
}

function bounded(value, label, max, required = true) {
  const text = String(value || '').trim()
  if ((required && !text) || text.length > max) throw fail(`${label}不正确`)
  return text
}

function normalizeAttachments(rows) {
  if (rows == null) return []
  if (!Array.isArray(rows) || rows.length > 3) throw fail('最多上传 3 张图片')
  return rows.map((row) => {
    exactObject(row, new Set(['name', 'fileType', 'dataUrl']))
    const name = bounded(row.name, '图片名称', 120)
    const fileType = String(row.fileType || '').trim().toLowerCase()
    const dataUrl = String(row.dataUrl || '')
    if (!IMAGE_TYPES.has(fileType) || !dataUrl.startsWith(`data:${fileType};base64,`)) throw fail('仅支持 JPG、PNG、WebP 图片')
    const encoded = dataUrl.split(',')[1] || ''
    const fileSize = Buffer.from(encoded, 'base64').length
    if (fileSize < 1 || fileSize > 5 * 1024 * 1024) throw fail('每张图片必须小于 5MB')
    return { name, fileType, dataUrl, fileSize }
  })
}

export function normalizeAfterSalesCreate(body) {
  exactObject(body, CREATE_KEYS)
  const orderId = bounded(body.orderId, '补货单', 120)
  const shipmentItemId = bounded(body.shipmentItemId, '发货商品', 120)
  const type = String(body.type || '').trim().toUpperCase()
  if (!AFTER_SALES_TYPES.includes(type)) throw fail('售后类型不正确')
  const quantityBase = Number(body.quantityBase)
  if (!Number.isSafeInteger(quantityBase) || quantityBase < 1) throw fail('售后数量必须为正整数基础单位')
  return { orderId, shipmentItemId, type, quantityBase, description: bounded(body.description, '问题描述', 1000), attachments: normalizeAttachments(body.attachments) }
}

const include = {
  attachments: { orderBy: { createdAt: 'asc' } },
  replenishmentOrder: { select: { orderNo: true } },
  replenishmentShipmentItem: { select: { productNameSnapshot: true, orderUnitSnapshot: true, nativeUnitSnapshot: true, shippedQuantityBase: true } },
}

export function afterSalesDto(row, { internal = false } = {}) {
  return {
    id: row.id,
    requestNo: row.requestNo,
    orderId: row.replenishmentOrderId,
    orderNo: row.replenishmentOrder?.orderNo || '',
    shipmentItemId: row.replenishmentShipmentItemId,
    productName: row.replenishmentShipmentItem?.productNameSnapshot || '',
    orderUnit: row.replenishmentShipmentItem?.orderUnitSnapshot || '',
    nativeUnit: row.replenishmentShipmentItem?.nativeUnitSnapshot || '',
    shippedQuantityBase: row.replenishmentShipmentItem?.shippedQuantityBase || 0,
    type: row.type,
    quantityBase: row.quantityBase,
    description: row.description,
    status: row.status,
    resultNote: row.resultNote,
    createdAt: new Date(row.createdAt).toISOString(),
    handledAt: row.handledAt ? new Date(row.handledAt).toISOString() : null,
    attachments: (row.attachments || []).map((attachment) => ({ id: attachment.id, name: attachment.name, fileType: attachment.fileType, fileSize: attachment.fileSize })),
    ...(internal ? { partnerId: row.partnerId, createdByActorName: row.createdByActorName, handledByActorName: row.handledByActorName, version: row.version } : {}),
  }
}

async function audit(tx, request, action, actor, before = null) {
  const snapshot = (row) => ({ requestNo: row.requestNo, type: row.type, quantityBase: row.quantityBase, status: row.status, resultNote: row.resultNote })
  await tx.partnerAuditLog.create({ data: { id: crypto.randomUUID(), partnerId: request.partnerId, entityType: 'REPLENISHMENT_AFTER_SALES', entityId: request.id, action, before: before ? snapshot(before) : null, after: snapshot(request), actorUserId: String(actor.id), actorUsername: String(actor.name || '') } })
}

export async function createPartnerAfterSales({ db, principal, body, storage = storeAssetData }) {
  const input = normalizeAfterSalesCreate(body)
  return db.$transaction(async (tx) => {
    const shipmentItem = await tx.replenishmentShipmentItem.findUnique({ where: { id: input.shipmentItemId }, include: { replenishmentShipment: { include: { replenishmentOrder: true } } } })
    const order = shipmentItem?.replenishmentShipment?.replenishmentOrder
    if (!shipmentItem || !order || order.id !== input.orderId || order.partnerId !== principal.partnerId) throw fail('发货商品不存在', 'REPLENISHMENT_AFTER_SALES_SCOPE_DENIED', 404)
    const claimed = await tx.replenishmentAfterSalesRequest.aggregate({ where: { replenishmentShipmentItemId: shipmentItem.id, status: { not: 'REJECTED' } }, _sum: { quantityBase: true } })
    if (Number(claimed._sum.quantityBase || 0) + input.quantityBase > shipmentItem.shippedQuantityBase) throw fail('售后数量超过该批次可申请数量', 'REPLENISHMENT_AFTER_SALES_QUANTITY_EXCEEDED', 409)
    const user = await tx.user.findUnique({ where: { id: principal.userId }, select: { username: true } })
    if (!user) throw fail('合作商账号已失效', 'REPLENISHMENT_AFTER_SALES_ACTOR_INVALID', 403)
    const requestId = `rpas-${crypto.randomUUID()}`
    const stored = []
    for (const attachment of input.attachments) {
      const id = `rpaa-${crypto.randomUUID()}`
      const object = await storage(attachment.dataUrl, `partner-after-sales/${principal.partnerId}/${requestId}/${id}`)
      stored.push({ id, partnerId: principal.partnerId, name: attachment.name, fileType: attachment.fileType, fileSize: attachment.fileSize, dataUrl: object.dataUrl, storageProvider: object.provider, storageKey: object.storageKey })
    }
    const now = new Date()
    const row = await tx.replenishmentAfterSalesRequest.create({ data: { id: requestId, requestNo: `AS-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, partnerId: principal.partnerId, replenishmentOrderId: order.id, replenishmentShipmentItemId: shipmentItem.id, type: input.type, quantityBase: input.quantityBase, description: input.description, createdByActorId: principal.userId, createdByActorName: user.username, attachments: { create: stored } }, include })
    await audit(tx, row, 'AFTER_SALES_CREATED', { id: principal.userId, name: user.username })
    return row
  }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000 })
}

export async function listPartnerAfterSales({ db, principal }) {
  return db.replenishmentAfterSalesRequest.findMany({ where: partnerScopedWhere(principal), include, orderBy: { createdAt: 'desc' }, take: 200 })
}

export async function getPartnerAfterSalesAttachment({ db, principal, requestId, attachmentId, reader = readAssetData }) {
  const row = await db.replenishmentAfterSalesAttachment.findFirst({ where: { id: attachmentId, requestId, partnerId: principal.partnerId } })
  if (!row) throw fail('售后图片不存在', 'REPLENISHMENT_AFTER_SALES_ATTACHMENT_NOT_FOUND', 404)
  return { id: row.id, name: row.name, fileType: row.fileType, fileSize: row.fileSize, dataUrl: await reader(row.storageProvider, row.storageKey, row.dataUrl) }
}

export async function getInternalAfterSalesAttachment({ db, actor, requestId, attachmentId, reader = readAssetData }) {
  const user = await db.user.findUnique({ where: { id: String(actor?.id || '') } })
  if (!canManagePartnerDomain(user)) throw fail('仅开发者或管理员可查看售后图片', 'REPLENISHMENT_AFTER_SALES_PROCESS_DENIED', 403)
  const row = await db.replenishmentAfterSalesAttachment.findFirst({ where: { id: attachmentId, requestId } })
  if (!row) throw fail('售后图片不存在', 'REPLENISHMENT_AFTER_SALES_ATTACHMENT_NOT_FOUND', 404)
  return { id: row.id, name: row.name, fileType: row.fileType, fileSize: row.fileSize, dataUrl: await reader(row.storageProvider, row.storageKey, row.dataUrl) }
}

export async function listInternalAfterSales({ db, actor }) {
  const user = await db.user.findUnique({ where: { id: String(actor?.id || '') } })
  if (!canManagePartnerDomain(user)) throw fail('仅开发者或管理员可处理售后', 'REPLENISHMENT_AFTER_SALES_PROCESS_DENIED', 403)
  return db.replenishmentAfterSalesRequest.findMany({ include: { ...include, partner: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 500 })
}

export async function processInternalAfterSales({ db, actor, requestId, body }) {
  exactObject(body, PROCESS_KEYS)
  const status = String(body.status || '').trim().toUpperCase()
  const version = Number(body.version)
  const reason = bounded(body.reason, '处理说明', 1000)
  if (!AFTER_SALES_STATUSES.includes(status) || status === 'PENDING' || !Number.isSafeInteger(version) || version < 1) throw fail('处理状态或版本不正确')
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: String(actor?.id || '') } })
    if (!canManagePartnerDomain(user)) throw fail('仅开发者或管理员可处理售后', 'REPLENISHMENT_AFTER_SALES_PROCESS_DENIED', 403)
    const before = await tx.replenishmentAfterSalesRequest.findUnique({ where: { id: requestId }, include })
    if (!before) throw fail('售后申请不存在', 'REPLENISHMENT_AFTER_SALES_NOT_FOUND', 404)
    const allowed = before.status === 'PENDING' ? ['PROCESSING', 'REJECTED'] : before.status === 'PROCESSING' ? ['RESOLVED', 'REJECTED'] : []
    if (!allowed.includes(status)) throw fail('当前售后状态不允许该处理', 'REPLENISHMENT_AFTER_SALES_STATE_INVALID', 409)
    const changed = await tx.replenishmentAfterSalesRequest.updateMany({ where: { id: before.id, status: before.status, version }, data: { status, resultNote: reason, handledByActorId: user.id, handledByActorName: user.username, handledAt: new Date(), version: { increment: 1 } } })
    if (changed.count !== 1) throw fail('售后申请已被其他人处理，请刷新', 'REPLENISHMENT_AFTER_SALES_CONFLICT', 409)
    const after = await tx.replenishmentAfterSalesRequest.findUnique({ where: { id: before.id }, include })
    await audit(tx, after, `AFTER_SALES_${status}`, { id: user.id, name: user.username }, before)
    return after
  }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 })
}
