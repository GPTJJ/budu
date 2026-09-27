import crypto from 'node:crypto'
import { prisma } from './pg.js'
import { formatBeijingNotificationTime, notificationDeepLink } from './notification-center.js'
import { sendWechatMarkdownResult } from './wechat-alert.js'
import { PARTNER_REPLENISHMENT_REVIEW_STORE_KEY } from './replenishment-review-authorization.js'

export const TRANSFER_RECIPIENT_POLICY = 'WECOM_GROUP_ONLY'
export const STOCKING_GROUP_CHANNEL = 'wecom_group_robot'

const hash = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const deterministicId = (prefix, ...parts) => `${prefix}-${hash(...parts)}`
const isDuplicate = (error) => error?.code === 'P2002'

export function transferItemSummary(items) {
  const rows = (Array.isArray(items) ? items : []).map((item) => {
    const name = [String(item?.itemCode || '').trim(), String(item?.productName || '').trim()].filter(Boolean).join(' ') || '未命名货品'
    const quantities = []
    const boxes = Number(item?.boxQuantity || 0)
    const pieces = Number(item?.pieceQuantity || 0)
    if (Number.isInteger(boxes) && boxes > 0) quantities.push(`${boxes}箱`)
    if (Number.isInteger(pieces) && pieces > 0) quantities.push(`${pieces}颗`)
    if (quantities.length === 0) quantities.push(`${Number(item?.quantity || 0)}件`)
    return `${name} × ${quantities.join(' + ')}`
  })
  if (rows.length === 0) return '无商品明细'
  const visible = rows.slice(0, 8).join('\n')
  return rows.length > 8 ? `${visible}\n另 ${rows.length - 8} 项` : visible
}

export function approvedReplenishmentItemSummary(items) {
  const rows = (Array.isArray(items) ? items : [])
    .filter((item) => Number.isSafeInteger(Number(item?.approvedQuantityBase)) && Number(item.approvedQuantityBase) > 0)
    .map((item) => {
      const name = [String(item?.productCodeSnapshot || '').trim(), String(item?.productNameSnapshot || '').trim()].filter(Boolean).join(' ') || '未命名货品'
      const quantity = Number(item.approvedQuantityBase)
      const unit = String(item?.orderUnitSnapshot || '')
      const display = unit === 'KG'
        ? `${quantity / 1000} KG`
        : unit === 'PCS'
          ? `${quantity} 颗`
          : `${quantity} ${String(item?.nativeUnitSnapshot || '件').trim() || '件'}`
      return `${name} × ${display}`
    })
  if (rows.length === 0) return '无批准备货商品'
  const visible = rows.slice(0, 8).join('\n')
  return rows.length > 8 ? `${visible}\n另 ${rows.length - 8} 项` : visible
}

function stockingCopy({ businessType, orderNo, shippingStore, receiver, items, status, operator, occurredAt, detailUrl = '' }) {
  return {
    title: '【budu 备货提醒】',
    content: [
      `**业务类型：** ${businessType}`,
      `**单号：** ${orderNo}`,
      `**调出门店：** ${shippingStore}`,
      `**收货方：** ${receiver}`,
      `**商品：**\n${items}`,
      `**状态：** ${status}`,
      `**操作人：** ${operator || '未知'}`,
      `**时间：** ${formatBeijingNotificationTime(occurredAt) || '未知'}`,
      detailUrl ? `[查看 OS 详情](${detailUrl})` : '',
    ].filter(Boolean).join('\n'),
  }
}

export function transferNotificationCopy(transfer) {
  const shippingStore = String(transfer?.fromStoreName || transfer?.fromStoreKey || '未知门店')
  const receiver = String(transfer?.storeName || transfer?.toStoreName || transfer?.storeKey || transfer?.toStoreKey || '未知门店')
  return stockingCopy({
    businessType: '内部调拨',
    orderNo: String(transfer?.id || ''),
    shippingStore,
    receiver,
    items: transferItemSummary(transfer?.items),
    status: '待备货',
    operator: String(transfer?.createdBy || ''),
    occurredAt: transfer?.createdAt,
    detailUrl: notificationDeepLink('inventory-transfer', 'transfer', transfer?.id),
  })
}

export function partnerReplenishmentNotificationCopy(order, shippingStoreName) {
  const partner = String(order?.partnerNameSnapshot || '未知合作商')
  const partnerStore = String(order?.partnerStoreNameSnapshot || order?.partnerStore?.name || '').trim()
  return stockingCopy({
    businessType: 'Partner补货',
    orderNo: String(order?.orderNo || order?.id || ''),
    shippingStore: String(shippingStoreName || PARTNER_REPLENISHMENT_REVIEW_STORE_KEY),
    receiver: partnerStore ? `${partner} · ${partnerStore}` : partner,
    items: approvedReplenishmentItemSummary(order?.items),
    status: '待发货',
    operator: String(order?.reviewedByActorName || ''),
    occurredAt: order?.reviewedAt,
  })
}

async function createStockingNotification(prismaClient, { eventType, eventId, templateKey, target, refType, refId, copy }) {
  const id = deterministicId('ntf-stocking-group', eventType, eventId)
  try {
    return await prismaClient.notification.create({
      data: {
        id,
        username: 'budu',
        templateKey,
        title: copy.title,
        content: copy.content,
        priority: 'high',
        status: 'unread',
        ackStatus: 'none',
        target,
        refType,
        refId,
      },
    })
  } catch (error) {
    if (!isDuplicate(error)) throw error
    const row = await prismaClient.notification.findUnique({ where: { id } })
    if (!row) throw new Error('stocking notification row missing')
    return row
  }
}

async function deliverStockingGroup({ prismaClient, eventType, eventId, notification, sendGroup }) {
  const deliveryId = deterministicId('nld-stocking-group', eventType, eventId)
  try {
    await prismaClient.notificationDelivery.create({
      data: { id: deliveryId, notificationId: notification.id, channel: STOCKING_GROUP_CHANNEL, status: 'pending' },
    })
  } catch (error) {
    if (isDuplicate(error)) return { ok: true, status: 'duplicate' }
    throw error
  }

  const result = await sendGroup(notification.title, notification.content)
  const error = result.ok
    ? ''
    : `send failed (errcode=${result.errcode || 'UNKNOWN'}${result.errmsg ? ` ${String(result.errmsg).slice(0, 160)}` : ''})`.slice(0, 240)
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: result.ok ? 'sent' : 'failed', error, sentAt: new Date() },
  })
  return { ok: result.ok, status: result.ok ? 'sent' : 'failed', error }
}

export async function deliverTransferRequestNotification({
  prismaClient = prisma,
  transfer,
  sendGroup = sendWechatMarkdownResult,
}) {
  if (['TEST','ACCEPTANCE_TEST'].includes(transfer?.purpose)) return { ok: true, status: 'skipped', reason: 'TEST_ORDER_NO_EXTERNAL_NOTIFICATION' }
  if (!transfer?.id || !transfer?.fromStoreKey || !transfer?.createdAt) {
    return { ok: false, status: 'skipped', reason: 'INVALID_TRANSFER_EVENT' }
  }
  const copy = transferNotificationCopy(transfer)
  const notification = await createStockingNotification(prismaClient, {
    eventType: 'internal-transfer-pending',
    eventId: transfer.id,
    templateKey: 'transfer_new',
    target: 'inventory-transfer',
    refType: 'transfer',
    refId: transfer.id,
    copy,
  })
  const delivery = await deliverStockingGroup({
    prismaClient,
    eventType: 'internal-transfer-pending',
    eventId: transfer.id,
    notification,
    sendGroup,
  })
  return { ...delivery, recipientPolicy: TRANSFER_RECIPIENT_POLICY, groupCount: delivery.status === 'sent' ? 1 : 0 }
}

export async function deliverPartnerReplenishmentStockingNotification({
  prismaClient = prisma,
  order,
  sendGroup = sendWechatMarkdownResult,
}) {
  if (['TEST','ACCEPTANCE_TEST'].includes(order?.purpose)) return { ok: true, status: 'skipped', reason: 'TEST_ORDER_NO_EXTERNAL_NOTIFICATION' }
  if (!order?.id || order?.status !== 'APPROVED' || !order?.reviewedAt) {
    return { ok: false, status: 'skipped', reason: 'INVALID_PARTNER_APPROVAL_EVENT' }
  }
  const approvedItems = (order.items || []).filter((item) => Number(item?.approvedQuantityBase) > 0)
  if (approvedItems.length === 0 || (order.items || []).some((item) => item?.approvedQuantityBase == null)) {
    return { ok: false, status: 'skipped', reason: 'APPROVED_QUANTITY_NOT_FINAL' }
  }
  const store = await prismaClient.store.findUnique({
    where: { key: PARTNER_REPLENISHMENT_REVIEW_STORE_KEY },
    select: { name: true },
  })
  const copy = partnerReplenishmentNotificationCopy(order, store?.name || PARTNER_REPLENISHMENT_REVIEW_STORE_KEY)
  const notification = await createStockingNotification(prismaClient, {
    eventType: 'partner-replenishment-approved',
    eventId: order.id,
    templateKey: 'partner_replenishment_approved',
    target: 'partner-replenishment-review',
    refType: 'partner_replenishment',
    refId: order.id,
    copy,
  })
  const delivery = await deliverStockingGroup({
    prismaClient,
    eventType: 'partner-replenishment-approved',
    eventId: order.id,
    notification,
    sendGroup,
  })
  return { ...delivery, recipientPolicy: TRANSFER_RECIPIENT_POLICY, groupCount: delivery.status === 'sent' ? 1 : 0 }
}
