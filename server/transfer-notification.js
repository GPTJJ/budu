import crypto from 'node:crypto'
import { prisma } from './pg.js'
import {
  developerWecomRecipientBinding,
  notificationDeepLink,
  sendWechatPersonal,
  wechatPersonalConfig,
} from './notification-center.js'
import { sendWechatMarkdownResult } from './wechat-alert.js'

export const TRANSFER_RECIPIENT_POLICY = 'ALL_SCHEDULED_STAFF_OF_SHIPPING_STORE_FOR_BUSINESS_DATE'
export const TRANSFER_FALLBACK_REASONS = Object.freeze({
  NO_SCHEDULED_STAFF: 'NO_SCHEDULED_STAFF',
  NO_REACHABLE_SCHEDULED_STAFF: 'NO_REACHABLE_SCHEDULED_STAFF',
  SCHEDULE_RESOLUTION_FAILED: 'SCHEDULE_RESOLUTION_FAILED',
})

const hash = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const deterministicId = (prefix, ...parts) => `${prefix}-${hash(...parts)}`
const isDuplicate = (error) => error?.code === 'P2002'

export function transferBusinessDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('transfer createdAt is invalid')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function transferItemSummary(items) {
  const rows = (Array.isArray(items) ? items : []).map((item) => {
    const name = [String(item?.itemCode || '').trim(), String(item?.productName || '').trim()].filter(Boolean).join(' ') || '未命名货品'
    const quantities = []
    const boxes = Number(item?.boxQuantity || 0)
    const pieces = Number(item?.pieceQuantity || 0)
    if (Number.isInteger(boxes) && boxes > 0) quantities.push(`${boxes}箱`)
    if (Number.isInteger(pieces) && pieces > 0) quantities.push(`${pieces}颗`)
    if (quantities.length === 0) quantities.push(`${Number(item?.quantity || 0)}件`)
    return `${name} ${quantities.join(' + ')}`
  })
  if (rows.length === 0) return '无商品明细'
  const visible = rows.slice(0, 8).join('；')
  return rows.length > 8 ? `${visible}；另 ${rows.length - 8} 项` : visible
}

export function transferNotificationCopy(transfer) {
  const fromStore = String(transfer?.fromStoreName || transfer?.fromStoreKey || '未知门店')
  const toStore = String(transfer?.storeName || transfer?.toStoreName || transfer?.storeKey || transfer?.toStoreKey || '未知门店')
  return {
    title: `新调拨待备货：${fromStore} → ${toStore}`,
    content: [
      `调拨单号：${String(transfer?.id || '')}`,
      `发货门店：${fromStore}`,
      `收货门店：${toStore}`,
      `申请人：${String(transfer?.createdBy || '未知')}`,
      `商品：${transferItemSummary(transfer?.items)}`,
      `当前状态：${transfer?.status === 'pending' ? '待备货' : String(transfer?.status || '未知')}`,
    ].join('\n'),
  }
}

export async function resolveTransferScheduledRecipients({ prismaClient = prisma, storeKey, businessDate, personalConfig = wechatPersonalConfig() }) {
  try {
    const schedules = await prismaClient.schedule.findMany({
      where: { storeKey, date: businessDate },
      select: { id: true, shifts: true },
      take: 2,
    })
    if (schedules.length > 1) {
      return { ok: false, reason: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED, detail: 'duplicate schedule authority rows' }
    }
    const shifts = schedules[0]?.shifts
    if (!Array.isArray(shifts) || shifts.length === 0) {
      return { ok: false, reason: TRANSFER_FALLBACK_REASONS.NO_SCHEDULED_STAFF, scheduledEmployeeIds: [] }
    }
    const employeeIds = []
    const seen = new Set()
    for (const shift of shifts) {
      const employeeId = String(shift?.employeeId || '').trim()
      if (!employeeId) {
        return { ok: false, reason: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED, detail: 'legacy schedule row lacks employeeId' }
      }
      if (!seen.has(employeeId)) {
        seen.add(employeeId)
        employeeIds.push(employeeId)
      }
    }
    const employees = await prismaClient.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, name: true },
    })
    if (employees.length !== employeeIds.length) {
      return { ok: false, reason: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED, detail: 'scheduled employeeId is missing' }
    }
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
    const users = await prismaClient.user.findMany({
      where: { employeeId: { in: employeeIds }, status: 'active' },
      select: { id: true, username: true, employeeId: true },
    })
    const usersByEmployeeId = new Map()
    for (const user of users) {
      const rows = usersByEmployeeId.get(user.employeeId) || []
      rows.push(user)
      usersByEmployeeId.set(user.employeeId, rows)
    }
    if ([...usersByEmployeeId.values()].some((rows) => rows.length > 1)) {
      return { ok: false, reason: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED, detail: 'employeeId has multiple active user accounts' }
    }
    const usernames = users.map((user) => user.username)
    const bindings = personalConfig && usernames.length > 0
      ? await prismaClient.wechatBinding.findMany({
        where: { username: { in: usernames }, channel: personalConfig.channel, status: 'active' },
        select: { username: true, openId: true, channel: true },
      })
      : []
    const bindingByUsername = new Map(bindings.map((binding) => [binding.username, binding]))
    const recipients = employeeIds.map((employeeId) => {
      const user = (usersByEmployeeId.get(employeeId) || [])[0] || null
      return {
        employeeId,
        employeeName: employeeById.get(employeeId)?.name || '',
        user,
        binding: user ? bindingByUsername.get(user.username) || null : null,
      }
    })
    const reachableCount = recipients.filter((recipient) => recipient.user && recipient.binding && personalConfig).length
    if (reachableCount === 0) {
      return {
        ok: false,
        reason: TRANSFER_FALLBACK_REASONS.NO_REACHABLE_SCHEDULED_STAFF,
        scheduledEmployeeIds: employeeIds,
        recipients,
      }
    }
    return { ok: true, scheduledEmployeeIds: employeeIds, recipients, reachableCount, personalConfig }
  } catch (error) {
    return {
      ok: false,
      reason: TRANSFER_FALLBACK_REASONS.SCHEDULE_RESOLUTION_FAILED,
      detail: String(error?.message || 'schedule resolution failed').slice(0, 200),
    }
  }
}

async function createTransferNotification(prismaClient, transfer, username, copy) {
  const id = deterministicId('ntf-transfer', transfer.id, username)
  let row
  let duplicate = false
  try {
    row = await prismaClient.notification.create({
      data: {
        id,
        username,
        templateKey: 'transfer_new',
        title: copy.title,
        content: copy.content,
        priority: 'high',
        status: 'unread',
        ackStatus: 'none',
        target: 'inventory-transfer',
        refType: 'transfer',
        refId: transfer.id,
      },
    })
  } catch (error) {
    if (!isDuplicate(error)) throw error
    duplicate = true
    row = await prismaClient.notification.findUnique({ where: { id } })
  }
  if (!row) throw new Error('transfer notification row missing')
  try {
    await prismaClient.notificationDelivery.create({
      data: {
        id: deterministicId('nld-transfer-inapp', transfer.id, username),
        notificationId: row.id,
        channel: 'inapp',
        status: 'sent',
      },
    })
  } catch (error) {
    if (!isDuplicate(error)) throw error
  }
  return { row, duplicate }
}

async function recordSkippedPersonal(prismaClient, notification, transferId, employeeId, reason) {
  try {
    await prismaClient.notificationDelivery.create({
      data: {
        id: deterministicId('nld-transfer-wecom', transferId, employeeId),
        notificationId: notification.id,
        channel: 'wecom_individual',
        status: 'skipped',
        error: String(reason || 'no binding').slice(0, 240),
      },
    })
  } catch (error) {
    if (!isDuplicate(error)) throw error
  }
  return { status: 'skipped' }
}

async function deliverPersonal({ prismaClient, notification, transfer, employeeId, binding, personalConfig, sendPersonal }) {
  const deliveryId = deterministicId('nld-transfer-wecom', transfer.id, employeeId)
  try {
    await prismaClient.notificationDelivery.create({
      data: { id: deliveryId, notificationId: notification.id, channel: 'wecom_individual', status: 'pending' },
    })
  } catch (error) {
    if (isDuplicate(error)) return { status: 'duplicate' }
    throw error
  }
  const url = notificationDeepLink('inventory-transfer', 'transfer', transfer.id)
  const result = await sendPersonal(personalConfig, binding, {
    title: notification.title,
    content: notification.content,
    target: 'inventory-transfer',
    url,
  })
  const error = result.ok ? '' : `send failed (errcode=${result.errcode || 'UNKNOWN'}${result.errmsg ? ` ${String(result.errmsg).slice(0, 160)}` : ''})`.slice(0, 240)
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: result.ok ? 'sent' : 'failed', error, sentAt: new Date() },
  })
  return { status: result.ok ? 'sent' : 'failed' }
}

async function deliverGroupFallback({ prismaClient, notification, transfer, reason, sendGroup }) {
  const deliveryId = deterministicId('nld-transfer-group', transfer.id, reason)
  try {
    await prismaClient.notificationDelivery.create({
      data: { id: deliveryId, notificationId: notification.id, channel: 'wecom_group_robot', status: 'pending' },
    })
  } catch (error) {
    if (isDuplicate(error)) return { status: 'duplicate' }
    throw error
  }
  const result = await sendGroup(notification.title, `${notification.content}\n通知路由：${reason}`)
  const error = result.ok ? '' : `send failed (errcode=${result.errcode || 'UNKNOWN'}${result.errmsg ? ` ${String(result.errmsg).slice(0, 160)}` : ''})`.slice(0, 240)
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: result.ok ? 'sent' : 'failed', error, sentAt: new Date() },
  })
  return { status: result.ok ? 'sent' : 'failed' }
}

async function deliverDeveloperFallback({ prismaClient, notification, transfer, developerBinding, personalConfig, sendPersonal }) {
  if (!developerBinding || !personalConfig || personalConfig.channel !== 'wecom') {
    return recordSkippedPersonal(prismaClient, notification, transfer.id, 'developer', 'developer wecom binding not configured')
  }
  return deliverPersonal({
    prismaClient,
    notification,
    transfer,
    employeeId: 'developer',
    binding: { openId: developerBinding.userId },
    personalConfig,
    sendPersonal,
  })
}

export async function deliverTransferRequestNotification({
  prismaClient = prisma,
  transfer,
  personalConfig = wechatPersonalConfig(),
  developerBinding = developerWecomRecipientBinding(),
  sendPersonal = sendWechatPersonal,
  sendGroup = sendWechatMarkdownResult,
}) {
  if (!transfer?.id || !transfer?.fromStoreKey || !transfer?.createdAt) {
    return { ok: false, status: 'skipped', reason: 'INVALID_TRANSFER_EVENT' }
  }
  const businessDate = transferBusinessDate(transfer.createdAt)
  const copy = transferNotificationCopy(transfer)
  const resolution = await resolveTransferScheduledRecipients({
    prismaClient,
    storeKey: transfer.fromStoreKey,
    businessDate,
    personalConfig,
  })
  if (resolution.ok) {
    const deliveries = await Promise.all(resolution.recipients.map(async (recipient) => {
      if (!recipient.user) {
        return { employeeId: recipient.employeeId, status: 'skipped', reason: 'no active user account' }
      }
      try {
        const { row } = await createTransferNotification(prismaClient, transfer, recipient.user.username, copy)
        if (!recipient.binding) {
          await recordSkippedPersonal(prismaClient, row, transfer.id, recipient.employeeId, 'no binding')
          return { employeeId: recipient.employeeId, username: recipient.user.username, status: 'skipped', reason: 'no binding' }
        }
        const delivery = await deliverPersonal({
          prismaClient,
          notification: row,
          transfer,
          employeeId: recipient.employeeId,
          binding: recipient.binding,
          personalConfig,
          sendPersonal,
        })
        return { employeeId: recipient.employeeId, username: recipient.user.username, ...delivery }
      } catch (error) {
        return {
          employeeId: recipient.employeeId,
          username: recipient.user.username,
          status: 'failed',
          reason: String(error?.message || 'notification delivery failed').slice(0, 200),
        }
      }
    }))
    return {
      ok: deliveries.filter((delivery) => delivery.status === 'sent' || delivery.status === 'duplicate').length === resolution.reachableCount,
      status: 'scheduled_staff',
      recipientPolicy: TRANSFER_RECIPIENT_POLICY,
      businessDate,
      scheduledEmployeeIds: resolution.scheduledEmployeeIds,
      deliveries,
      groupCount: 0,
      developerCount: 0,
    }
  }

  const fallbackUsername = developerBinding?.username || 'budu'
  const { row } = await createTransferNotification(prismaClient, transfer, fallbackUsername, copy)
  const fallbackResults = await Promise.allSettled([
    deliverGroupFallback({ prismaClient, notification: row, transfer, reason: resolution.reason, sendGroup }),
    deliverDeveloperFallback({ prismaClient, notification: row, transfer, developerBinding, personalConfig, sendPersonal }),
  ])
  const asDelivery = (result) => result.status === 'fulfilled'
    ? result.value
    : { status: 'failed', reason: String(result.reason?.message || 'fallback delivery failed').slice(0, 200) }
  const group = asDelivery(fallbackResults[0])
  const developer = asDelivery(fallbackResults[1])
  return {
    ok: group.status === 'sent' && developer.status === 'sent',
    status: 'fallback',
    reason: resolution.reason,
    detail: resolution.detail || '',
    recipientPolicy: TRANSFER_RECIPIENT_POLICY,
    businessDate,
    group,
    developer,
  }
}
