export const NOTIFICATION_TARGET_VIEWS = {
  'staff-payroll': 'staff-payroll',
  approval: 'approval',
  'inventory-transfer': 'inventory-transfer',
  'inventory-purchase': 'inventory-purchase',
  'partner-supply': 'partner-supply',
  'finance-invoice': 'finance-invoice',
  'store-mailing': 'store-mailing',
  'asset-center': 'asset-center',
  staff: 'staff',
}

export function notificationTargetView(target) {
  return NOTIFICATION_TARGET_VIEWS[String(target || '')] || 'overview'
}

export function prepareApprovalScope(notification) {
  if (notification?.target !== 'approval') return
  const scope = notification.templateKey === 'approval_todo'
    ? 'todo'
    : notification.templateKey === 'approval_cc'
      ? 'cc'
      : 'my'
  try {
    sessionStorage.setItem('budu-approval-scope', scope)
  } catch {
    /* Safari 隐私模式下不阻塞跳转 */
  }
}

const FOCUS_KEY = 'budu-notification-record-focus'

/** 登录后的企微深链入口。查询参数只选择已授权页面并定位记录，不承担鉴权。 */
export function consumeNotificationDeepLink(canOpen = () => true) {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  const target = String(params.get('nav') || '')
  const refType = String(params.get('refType') || '')
  const refId = String(params.get('refId') || '')
  if (!['store-mailing', 'finance-invoice', 'inventory-transfer', 'partner-supply'].includes(target) || !/^[A-Za-z0-9._:-]{1,160}$/.test(refId)) return ''
  params.delete('nav')
  params.delete('refType')
  params.delete('refId')
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  if (!canOpen(target)) return ''
  try {
    sessionStorage.setItem(FOCUS_KEY, JSON.stringify({ target, refType, refId }))
  } catch {
    /* Safari 隐私模式下不阻塞页面跳转 */
  }
  return target
}

export function prepareNotificationRecordFocus(notification) {
  if (!notification?.target || !notification?.refId) return
  const detail = {
    target: String(notification.target),
    refType: String(notification.refType || ''),
    refId: String(notification.refId),
  }
  try {
    sessionStorage.setItem(FOCUS_KEY, JSON.stringify(detail))
  } catch {
    /* Safari 隐私模式下不阻塞页面跳转 */
  }
  window.dispatchEvent(new CustomEvent('budu:notification-record-focus', { detail }))
}

export function takeNotificationRecordFocus(target) {
  try {
    const raw = sessionStorage.getItem(FOCUS_KEY)
    if (!raw) return ''
    const value = JSON.parse(raw)
    if (value?.target !== target || !value?.refId) return ''
    sessionStorage.removeItem(FOCUS_KEY)
    return String(value.refId)
  } catch {
    return ''
  }
}
