export const ACTIVE_ROLES = Object.freeze(['developer', 'admin', 'finance', 'manager', 'staff', 'cashier'])

export const ROLE_LABELS = Object.freeze({
  developer: '开发者',
  admin: '管理员',
  finance: '财务',
  manager: '店长',
  staff: '员工',
  cashier: '门店收银',
})

export const MODULE_KEYS = Object.freeze({
  OVERVIEW: 'overview',
  ANALYSIS: 'analysis',
  STAFF: 'staff',
  STAFF_PAYROLL: 'staff-payroll',
  STORE_ENTRY: 'store-entry',
  STORE_SCHEDULE: 'store-schedule',
  STORE_MAILING: 'store-mailing',
  STORE_POS: 'store-pos',
  PRODUCT_CENTER: 'product-center',
  INVENTORY_TRANSFER: 'inventory-transfer',
  INVENTORY_PURCHASE: 'inventory-purchase',
  FINANCE: 'finance',
  FINANCE_INVOICE: 'finance-invoice',
  APPROVAL: 'approval',
  ASSET_CENTER: 'asset-center',
  SETTINGS: 'settings',
})

export const MODULE_GROUPS = Object.freeze([
  { key: 'workspace', label: '工作台', modules: [
    { key: MODULE_KEYS.OVERVIEW, label: '首页' },
    { key: MODULE_KEYS.ANALYSIS, label: '经营分析' },
  ] },
  { key: 'personnel', label: '人员管理', modules: [
    { key: MODULE_KEYS.STAFF, label: '雇员' },
    { key: MODULE_KEYS.STAFF_PAYROLL, label: '工资条' },
  ] },
  { key: 'store', label: '门店经营', modules: [
    { key: MODULE_KEYS.STORE_ENTRY, label: '门店业绩录入' },
    { key: MODULE_KEYS.STORE_SCHEDULE, label: '门店排班' },
    { key: MODULE_KEYS.STORE_MAILING, label: '门店邮寄' },
    { key: MODULE_KEYS.STORE_POS, label: 'POS 点单（含订单记录）' },
    { key: MODULE_KEYS.PRODUCT_CENTER, label: '商品中心' },
  ] },
  { key: 'inventory', label: '库存管理', modules: [
    { key: MODULE_KEYS.INVENTORY_TRANSFER, label: '申请调货' },
    { key: MODULE_KEYS.INVENTORY_PURCHASE, label: '申请采购' },
  ] },
  { key: 'finance', label: '财务管理', modules: [
    { key: MODULE_KEYS.FINANCE, label: '财务利润' },
    { key: MODULE_KEYS.FINANCE_INVOICE, label: '发票开具' },
  ] },
  { key: 'collaboration', label: '协同管理', modules: [
    { key: MODULE_KEYS.APPROVAL, label: '审批中心' },
    { key: MODULE_KEYS.ASSET_CENTER, label: 'budu档案馆' },
  ] },
  { key: 'system', label: '系统管理', modules: [
    { key: MODULE_KEYS.SETTINGS, label: '系统设置' },
  ] },
])

export const ALL_MODULE_KEYS = Object.freeze(MODULE_GROUPS.flatMap((group) => group.modules.map((item) => item.key)))

const MANAGER_DEFAULTS = Object.freeze([
  MODULE_KEYS.OVERVIEW, MODULE_KEYS.ANALYSIS, MODULE_KEYS.STAFF, MODULE_KEYS.STAFF_PAYROLL,
  MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.STORE_SCHEDULE, MODULE_KEYS.STORE_MAILING, MODULE_KEYS.STORE_POS,
  MODULE_KEYS.PRODUCT_CENTER, MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE,
  MODULE_KEYS.FINANCE_INVOICE, MODULE_KEYS.APPROVAL, MODULE_KEYS.SETTINGS,
])

const STAFF_DEFAULTS = Object.freeze(MANAGER_DEFAULTS.filter((key) => key !== MODULE_KEYS.PRODUCT_CENTER))

export const ACCOUNT_PERMISSION_KEYS = Object.freeze({
  INVENTORY_TRANSFER_ALL: 'inventoryTransferAll',
})

export function defaultModuleKeys(role, legacyAssetCenter = false) {
  if (role === 'developer' || role === 'admin' || role === 'finance') return [...ALL_MODULE_KEYS]
  if (role === 'cashier') return [MODULE_KEYS.STORE_POS]
  const base = role === 'manager' ? [...MANAGER_DEFAULTS] : role === 'staff' ? [...STAFF_DEFAULTS] : []
  if (legacyAssetCenter && !base.includes(MODULE_KEYS.ASSET_CENTER)) base.push(MODULE_KEYS.ASSET_CENTER)
  return base
}

function normalizeModules(value, role, legacyAssetCenter) {
  if (role === 'developer') return Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, true]))
  if (role === 'cashier') return Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, key === MODULE_KEYS.STORE_POS]))
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const defaults = new Set(defaultModuleKeys(role, legacyAssetCenter))
  return Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, source ? source[key] === true : defaults.has(key)]))
}

export function normalizeAccountPermissions(value, role = 'staff', legacyAssetCenter = false) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    modules: normalizeModules(source.modules, role, legacyAssetCenter),
    [ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL]:
      source[ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL] === true,
  }
}

export function hasModuleAccess(user, moduleKey) {
  if (!user || user.status === 'disabled' || user.role === 'public' || !ALL_MODULE_KEYS.includes(moduleKey)) return false
  if (user.role === 'developer') return true
  if (user.role === 'cashier') return moduleKey === MODULE_KEYS.STORE_POS
  return normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true).modules[moduleKey] === true
}

export function hasAnyModuleAccess(user, moduleKeys) {
  return Array.isArray(moduleKeys) && moduleKeys.some((key) => hasModuleAccess(user, key))
}

export function firstAccessibleModule(user) {
  return ALL_MODULE_KEYS.find((key) => hasModuleAccess(user, key)) || ''
}

export function hasInventoryTransferAll(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      (isSuperUser(user) ||
        normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL]),
  )
}

/** 业务最高权限角色；账号治理仍仅限 developer。 */
export function isSuperUser(user) {
  return Boolean(user && user.status !== 'disabled' && (user.role === 'developer' || user.role === 'finance' || user.role === 'admin'))
}

export function canManageAccounts(user) {
  return Boolean(user && user.status !== 'disabled' && user.role === 'developer')
}

/** 页面访问判定：账号治理是开发者保留能力，不属于可授权业务版块。 */
export function hasPageAccess(user, pageKey) {
  if (pageKey === 'account-admin') return canManageAccounts(user)
  return hasModuleAccess(user, pageKey)
}

export function canAccessTransferStore(user, storeKey) {
  if (!user || user.role === 'public' || !hasModuleAccess(user, MODULE_KEYS.INVENTORY_TRANSFER)) return false
  if (hasInventoryTransferAll(user)) return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey)
}

export function canManageTransferStore(user, storeKey) {
  if (!user || user.role === 'public' || !hasModuleAccess(user, MODULE_KEYS.INVENTORY_TRANSFER)) return false
  if (hasInventoryTransferAll(user)) return true
  return user.role === 'manager' && canAccessTransferStore(user, storeKey)
}
