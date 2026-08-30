const TRANSFER_NOTIFICATION_TEMPLATE = 'transfer_new'
const PERSONAL_CHANNELS = new Set(['wechat', 'wecom_individual'])
const PUSH_CHANNELS = [...PERSONAL_CHANNELS, 'wecom_group_robot']

export const EMPTY_TRANSFER_DELIVERY_SUMMARY = Object.freeze({
  source: 'notification_delivery',
  successful: [],
  undelivered: [],
})

function deliveryReason(delivery) {
  const error = String(delivery?.error || '').toLowerCase()
  if (error.includes('no binding')) return 'NO_WECOM_BINDING'
  if (error.includes('not configured') || error.includes('config_missing') || error.includes('no_channel')) {
    return 'CHANNEL_NOT_CONFIGURED'
  }
  return delivery?.status === 'skipped' ? 'NOT_DELIVERED' : 'DELIVERY_FAILED'
}

function recipientFor(notification, delivery, fallbackNotificationIds) {
  if (delivery.channel === 'wecom_group_robot') {
    return { key: 'group_robot', type: 'group', label: '企业微信群机器人' }
  }
  const fallback = fallbackNotificationIds.has(notification.id)
  return fallback
    ? { key: 'developer', type: 'developer', label: '开发者' }
    : { key: `user:${notification.username}`, type: 'individual', label: notification.username }
}

function preferDelivery(current, next) {
  if (!current || next.status === 'sent') return next
  return current
}

function recipientOrder(left, right) {
  const order = { group: 0, developer: 1, individual: 2 }
  return (order[left.type] ?? 9) - (order[right.type] ?? 9)
    || left.label.localeCompare(right.label, 'zh-CN')
}

/**
 * 把已落库的 transfer_new 投递事实整理成 UI 读模型。
 * 不查 Schedule / Employee，不根据当前人员关系反推历史收件人。
 */
export function summarizeTransferDeliveries(notifications, deliveries) {
  const transferNotifications = (notifications || []).filter((row) => (
    row?.refType === 'transfer' && row?.refId && row?.templateKey === TRANSFER_NOTIFICATION_TEMPLATE
  ))
  const notificationById = new Map(transferNotifications.map((row) => [row.id, row]))
  const relevant = (deliveries || []).filter((row) => notificationById.has(row?.notificationId) && PUSH_CHANNELS.includes(row?.channel))
  const fallbackNotificationIds = new Set(relevant.filter((row) => row.channel === 'wecom_group_robot').map((row) => row.notificationId))
  const byTransfer = new Map()

  for (const delivery of relevant) {
    const notification = notificationById.get(delivery.notificationId)
    const recipient = recipientFor(notification, delivery, fallbackNotificationIds)
    const row = {
      ...recipient,
      channel: delivery.channel,
      status: delivery.status,
      ...(delivery.status === 'sent' ? {} : { reason: deliveryReason(delivery) }),
    }
    const transfer = byTransfer.get(notification.refId) || new Map()
    transfer.set(recipient.key, preferDelivery(transfer.get(recipient.key), row))
    byTransfer.set(notification.refId, transfer)
  }

  return new Map([...byTransfer].map(([transferId, recipients]) => {
    const rows = [...recipients.values()]
    return [transferId, {
      source: 'notification_delivery',
      successful: rows.filter((row) => row.status === 'sent').sort(recipientOrder),
      undelivered: rows.filter((row) => row.status !== 'sent').sort(recipientOrder),
    }]
  }))
}

export async function loadTransferDeliverySummaries(prismaClient, transferIds) {
  const ids = [...new Set((transferIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (ids.length === 0) return new Map()
  const notifications = await prismaClient.notification.findMany({
    where: { refType: 'transfer', refId: { in: ids }, templateKey: TRANSFER_NOTIFICATION_TEMPLATE },
    select: { id: true, refType: true, refId: true, templateKey: true, username: true },
  })
  if (notifications.length === 0) return new Map()
  const deliveries = await prismaClient.notificationDelivery.findMany({
    where: { notificationId: { in: notifications.map((row) => row.id) }, channel: { in: PUSH_CHANNELS } },
    select: { notificationId: true, channel: true, status: true, error: true },
  })
  return summarizeTransferDeliveries(notifications, deliveries)
}
