import crypto from 'node:crypto'
import { isTestOrderPurpose } from '../shared/orderPurpose.js'
import { prisma } from './pg.js'
import {
  developerWecomRecipientBinding,
  formatBeijingNotificationTime,
  notificationDeepLink,
  sendWechatPersonal,
  wechatPersonalConfig,
} from './notification-center.js'

export const PARTNER_REVIEW_REQUIRED_EVENT = 'PARTNER_REPLENISHMENT_REVIEW_REQUIRED'

const hash = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const isDuplicate = (error) => error?.code === 'P2002'

function formatCny(cents) {
  const value = BigInt(cents)
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  return `${sign}¥${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

export function partnerReviewRequiredCopy(order) {
  const itemCount = Array.isArray(order?.items) ? order.items.length : 0
  return {
    title: '【Partner 补货待审核】',
    content: [
      `合作商：${String(order?.partnerNameSnapshot || '未知合作商')}`,
      `补货单号：${String(order?.orderNo || order?.id || '')}`,
      `收货门店：${String(order?.partnerStoreNameSnapshot || '未知门店')}`,
      `商品：${itemCount} 项`,
      `申请金额：${formatCny(order?.requestedTotalAmountCents || 0)}`,
      '状态：待审核',
      `提交时间：${formatBeijingNotificationTime(order?.submittedAt) || '未知'}`,
      '',
      '请及时进入 budu OS 审核。',
    ].join('\n'),
  }
}

async function createReviewRequiredNotification(prismaClient, order, copy, username) {
  const id = `ntf-partner-review-required-${hash(order.id)}`
  try {
    return await prismaClient.notification.create({
      data: {
        id,
        username,
        templateKey: 'partner_replenishment_review_required',
        title: copy.title,
        content: copy.content,
        priority: 'high',
        status: 'unread',
        ackStatus: 'none',
        target: 'partner-replenishment-review',
        refType: 'partner_replenishment',
        refId: order.id,
      },
    })
  } catch (error) {
    if (!isDuplicate(error)) throw error
    const row = await prismaClient.notification.findUnique({ where: { id } })
    if (!row) throw new Error('Partner review-required notification row missing')
    return row
  }
}

export async function deliverPartnerReplenishmentReviewRequired({
  prismaClient = prisma,
  order,
  recipientBinding = developerWecomRecipientBinding(),
  personalConfig = wechatPersonalConfig(),
  sendPersonal = sendWechatPersonal,
}) {
  if (isTestOrderPurpose(order?.purpose)) return { ok: true, status: 'skipped', reason: 'TEST_ORDER_NO_EXTERNAL_NOTIFICATION' }
  if (!order?.id || order?.status !== 'SUBMITTED' || !order?.submittedAt) {
    return { ok: false, status: 'skipped', reason: 'INVALID_PARTNER_SUBMITTED_EVENT' }
  }
  const username = recipientBinding?.username || 'budu'
  const notification = await createReviewRequiredNotification(
    prismaClient,
    order,
    partnerReviewRequiredCopy(order),
    username,
  )
  const deliveryId = `nld-partner-review-required-${hash(order.id, username, recipientBinding?.userId || 'missing')}`
  try {
    await prismaClient.notificationDelivery.create({
      data: {
        id: deliveryId,
        notificationId: notification.id,
        channel: 'wecom',
        status: 'pending',
      },
    })
  } catch (error) {
    if (isDuplicate(error)) return { ok: true, status: 'duplicate' }
    throw error
  }

  if (!recipientBinding?.userId || !personalConfig || personalConfig.channel !== 'wecom') {
    const reason = !recipientBinding?.userId
      ? 'developer wecom recipient not configured'
      : 'wecom app channel not configured'
    await prismaClient.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'skipped', error: reason, sentAt: new Date() },
    }).catch(() => {})
    return { ok: false, status: 'skipped', reason }
  }

  const result = await sendPersonal(
    personalConfig,
    { openId: recipientBinding.userId },
    {
      title: notification.title,
      content: notification.content,
      target: notification.target,
      url: notificationDeepLink(notification.target, notification.refType, notification.refId),
    },
  )
  const error = result.ok
    ? ''
    : `send failed (errcode=${result.errcode || 'UNKNOWN'}${result.errmsg ? ` ${String(result.errmsg).slice(0, 160)}` : ''})`.slice(0, 240)
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: result.ok ? 'sent' : 'failed', error, sentAt: new Date() },
  }).catch(() => {})
  return {
    ok: result.ok,
    status: result.ok ? 'sent' : 'failed',
    event: PARTNER_REVIEW_REQUIRED_EVENT,
    recipientCount: 1,
    retried: Boolean(result.retried),
  }
}
