export const NOTIFICATION_TARGET_VIEWS = {
  'staff-payroll': 'staff-payroll',
  approval: 'approval',
  'inventory-transfer': 'inventory-transfer',
  'inventory-purchase': 'inventory-purchase',
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
