export const ORDER_PURPOSES = Object.freeze(['REAL', 'TEST', 'ACCEPTANCE_TEST', 'LEGACY_UNCLASSIFIED'])
export const ORDER_PURPOSE_LABELS = Object.freeze({ REAL: '真实业务', TEST: '开发测试', ACCEPTANCE_TEST: '验收测试', LEGACY_UNCLASSIFIED: '历史待确认' })
export const isTestOrderPurpose = (purpose) => purpose === 'TEST' || purpose === 'ACCEPTANCE_TEST'
// User confirmed the existing admin role is the system's super administrator.
export const canManageOrderPurpose = (user) => Boolean(user?.id && user.status === 'active' && ['developer', 'admin'].includes(user.role))
