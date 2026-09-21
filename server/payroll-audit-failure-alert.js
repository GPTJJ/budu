import crypto from 'node:crypto'

import { prisma } from './pg.js'
import {
  developerWecomRecipientBinding,
  sendWechatPersonal,
  wechatPersonalConfig,
} from './notification-center.js'

export const PAYROLL_AUDIT_DELIVERY_FAILURE_EVENT = 'PAYROLL_AUDIT_DELIVERY_FAILURE'

const REPORT_LABELS = Object.freeze({
  WEEKLY_PART_TIME: '兼职周报',
  MONTHLY_FULL_TIME: '全职月报',
  MONTHLY_UNIFIED_SUMMARY: '统一月报',
})
const cleanToken = (value, fallback = '') => String(value || fallback).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 100)
const digest = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const duplicate = (error) => error?.code === 'P2002'

export function payrollAuditFailureAlertCopy(input) {
  const reportType = cleanToken(input.reportType)
  const label = REPORT_LABELS[reportType]
  const periodStart = String(input.periodStart || '')
  const periodEnd = String(input.periodEnd || '')
  if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw Object.assign(new Error('Invalid payroll audit failure identity'), { code: 'PAYROLL_AUDIT_FAILURE_IDENTITY_INVALID' })
  }
  const stage = cleanToken(input.stage, 'UNKNOWN_STAGE')
  const safeErrorCode = cleanToken(input.safeErrorCode, 'PAYROLL_DELIVERY_FAILED')
  const formalStatus = cleanToken(input.formalStatus, 'NOT_SENT')
  return {
    reportType,
    periodStart,
    periodEnd,
    stage,
    safeErrorCode,
    formalStatus,
    title: '【budu 薪酬审查邮件发送失败】',
    content: [
      `报告类型：${label}`,
      `周期：${periodStart} ～ ${periodEnd}`,
      `失败阶段：${stage}`,
      `安全错误码：${safeErrorCode}`,
      `正式邮件状态：${formalStatus === 'PARTIAL_FAILURE' ? '部分失败' : '未发送'}`,
      '',
      '请及时处理。',
    ].join('\n'),
  }
}

export async function deliverPayrollAuditFailureAlert({
  prismaClient = prisma,
  recipientBinding = developerWecomRecipientBinding(),
  personalConfig = wechatPersonalConfig(),
  sendPersonal = sendWechatPersonal,
  ...input
}) {
  const copy = payrollAuditFailureAlertCopy(input)
  const reportId = String(input.reportId || 'unknown').trim().slice(0, 160)
  const eventId = digest(copy.reportType, copy.periodStart, copy.periodEnd, reportId, copy.stage, copy.safeErrorCode)
  const username = recipientBinding?.username || 'budu'
  const notificationId = `ntf-payroll-delivery-failure-${eventId}`
  let notification
  try {
    notification = await prismaClient.notification.create({
      data: {
        id: notificationId,
        username,
        templateKey: 'payroll_audit_delivery_failure',
        title: copy.title,
        content: copy.content,
        priority: 'high',
        status: 'unread',
        ackStatus: 'none',
        target: 'staff-payroll',
        refType: 'payroll_audit',
        refId: reportId,
      },
    })
  } catch (error) {
    if (!duplicate(error)) throw error
    notification = await prismaClient.notification.findUnique({ where: { id: notificationId } })
    if (!notification) throw new Error('Payroll delivery failure notification row missing')
  }

  const deliveryId = `nld-payroll-delivery-failure-${digest(notificationId, username, recipientBinding?.userId || 'missing')}`
  try {
    await prismaClient.notificationDelivery.create({
      data: { id: deliveryId, notificationId, channel: 'wecom', status: 'pending' },
    })
  } catch (error) {
    if (duplicate(error)) return { ok: true, status: 'duplicate', eventId, deliveryId }
    throw error
  }

  if (!recipientBinding?.userId || !personalConfig || personalConfig.channel !== 'wecom') {
    const reason = !recipientBinding?.userId ? 'developer wecom recipient not configured' : 'wecom app channel not configured'
    await prismaClient.notificationDelivery.update({ where: { id: deliveryId }, data: { status: 'skipped', error: reason, sentAt: new Date() } }).catch(() => {})
    return { ok: false, status: 'skipped', eventId, deliveryId, safeErrorCode: 'DEVELOPER_WECOM_UNAVAILABLE' }
  }

  const result = await sendPersonal(personalConfig, { openId: recipientBinding.userId }, {
    title: copy.title,
    content: copy.content,
    target: 'staff-payroll',
  })
  const error = result.ok ? '' : `send failed (errcode=${result.errcode || 'UNKNOWN'})`.slice(0, 240)
  await prismaClient.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: result.ok ? 'sent' : 'failed', error, sentAt: new Date() },
  }).catch(() => {})
  return { ok: result.ok, status: result.ok ? 'sent' : 'failed', eventId, deliveryId, recipientCount: 1 }
}
