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
