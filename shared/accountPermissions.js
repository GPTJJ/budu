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
  PARTNER_SUPPLY: 'partner-supply',
  PRODUCT_MATERIAL_MANAGEMENT: 'product-material-management',
  FINANCE: 'finance',
  FINANCE_INVOICE: 'finance-invoice',
  APPROVAL: 'approval',
  ASSET_CENTER: 'asset-center',
  SETTINGS: 'settings',
  EMPLOYEE_PROFILE: 'employee-profile',
  SWEET_CARD: 'sweet-card',
})

export const MODULE_GROUPS = Object.freeze([
  { key: 'workspace', label: '工作台', modules: [
    { key: MODULE_KEYS.OVERVIEW, label: '首页' },
    { key: MODULE_KEYS.ANALYSIS, label: '经营分析' },
  ] },
  { key: 'personnel', label: '人员管理', modules: [
    { key: MODULE_KEYS.STAFF, label: '雇员' },
    { key: MODULE_KEYS.STAFF_PAYROLL, label: '工资条' },
    { key: MODULE_KEYS.EMPLOYEE_PROFILE, label: '员工档案' },
  ] },
  { key: 'store', label: '门店经营', modules: [
    { key: MODULE_KEYS.STORE_ENTRY, label: '门店业绩录入' },
    { key: MODULE_KEYS.STORE_SCHEDULE, label: '门店排班' },
    { key: MODULE_KEYS.STORE_MAILING, label: '门店邮寄' },
    { key: MODULE_KEYS.STORE_POS, label: 'POS 点单（含订单记录）' },
    { key: MODULE_KEYS.PRODUCT_CENTER, label: '商品中心' },
  ] },
  { key: 'inventory', label: '库存管理', modules: [
    { key: MODULE_KEYS.INVENTORY_TRANSFER, label: '门店调拨' },
    { key: MODULE_KEYS.INVENTORY_PURCHASE, label: '申请采购' },
    { key: MODULE_KEYS.PARTNER_SUPPLY, label: '合作商供货' },
    { key: MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT, label: '物料管理' },
  ] },
  { key: 'finance', label: '财务管理', modules: [
    { key: MODULE_KEYS.FINANCE, label: '报表中心' },
    { key: MODULE_KEYS.FINANCE_INVOICE, label: '发票开具' },
  ] },
  { key: 'collaboration', label: '协同管理', modules: [
    { key: MODULE_KEYS.APPROVAL, label: '审批中心' },
    { key: MODULE_KEYS.ASSET_CENTER, label: 'budu档案馆' },
  ] },
  { key: 'customerValue', label: '客户权益', modules: [
    { key: MODULE_KEYS.SWEET_CARD, label: 'budu 甜意卡' },
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
  MODULE_KEYS.PARTNER_SUPPLY, MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT,
  MODULE_KEYS.FINANCE_INVOICE, MODULE_KEYS.APPROVAL, MODULE_KEYS.SETTINGS,
  MODULE_KEYS.EMPLOYEE_PROFILE,
])

const STAFF_DEFAULTS = Object.freeze(MANAGER_DEFAULTS.filter((key) => key !== MODULE_KEYS.PRODUCT_CENTER && key !== MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT && key !== MODULE_KEYS.EMPLOYEE_PROFILE))

export const ACCOUNT_PERMISSION_KEYS = Object.freeze({
  INVENTORY_TRANSFER_ALL: 'inventoryTransferAll',
  EXTERNAL_ORDER_CREATE: 'externalOrderCreate',
  EXTERNAL_SETTLEMENT_CONFIRM: 'externalSettlementConfirm',
  MANUAL_EXTERNAL_REFUND_RECORD: 'manualExternalRefundRecord',
  MANUAL_EXTERNAL_REFUND_CONFIRM: 'manualExternalRefundConfirm',
  REPORT_SALES_VIEW: 'reportSalesView',
  REPORT_ALL_STORES: 'reportAllStores',
  REPORT_COST_VIEW: 'reportCostView',
  REPORT_LABOR_VIEW: 'reportLaborView',
  REPORT_COST_MANAGE: 'reportCostManage',
  DEVELOPER_SENSITIVE_RECORD_DELETE: 'developerSensitiveRecordDelete',
  DAILY_ENTRY: 'dailyEntry',
  SWEET_CARD: 'sweetCard',
  SWEET_CARD_PRODUCTION_TEST: 'sweetCardProductionTest',
})

export const SWEET_CARD_CAPABILITIES = Object.freeze({
  VIEW: 'view', ISSUE: 'issue', MANAGE: 'manage', ACTIVATE: 'activate',
  FREEZE: 'freeze', VOID: 'void', AUDIT: 'audit',
})

function normalizeSweetCardCapabilities(value, role) {
  const privileged = role === 'developer' || role === 'admin'
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries(Object.values(SWEET_CARD_CAPABILITIES).map((key) => [
    key,
    privileged || source[key] === true,
  ]))
}

export const DAILY_ENTRY_CAPABILITIES = Object.freeze({
  VIEW: 'view',
  EDIT: 'edit',
  CONFIRM: 'confirm',
  REVISE: 'revise',
})

export const DAILY_ENTRY_CAPABILITY_OPTIONS = Object.freeze([
  { key: DAILY_ENTRY_CAPABILITIES.VIEW, label: '查看每日录入' },
  { key: DAILY_ENTRY_CAPABILITIES.EDIT, label: '编辑未确认录入' },
  { key: DAILY_ENTRY_CAPABILITIES.CONFIRM, label: '确认当日录入' },
  { key: DAILY_ENTRY_CAPABILITIES.REVISE, label: '修正已确认历史' },
])

function defaultDailyEntryCapabilities(role, modules) {
  const moduleEnabled = modules[MODULE_KEYS.STORE_ENTRY] === true
  const elevated = ['developer', 'admin', 'finance', 'manager'].includes(role)
  return {
    [DAILY_ENTRY_CAPABILITIES.VIEW]: moduleEnabled,
    [DAILY_ENTRY_CAPABILITIES.EDIT]: moduleEnabled,
    [DAILY_ENTRY_CAPABILITIES.CONFIRM]: moduleEnabled,
    [DAILY_ENTRY_CAPABILITIES.REVISE]: moduleEnabled && elevated,
  }
}

function normalizeDailyEntryCapabilities(value, role, modules) {
  if (role === 'developer') {
    return Object.fromEntries(Object.values(DAILY_ENTRY_CAPABILITIES).map((key) => [key, true]))
  }
  if (role === 'cashier' || role === 'public') {
    return Object.fromEntries(Object.values(DAILY_ENTRY_CAPABILITIES).map((key) => [key, false]))
  }
  const defaults = defaultDailyEntryCapabilities(role, modules)
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  return Object.fromEntries(Object.values(DAILY_ENTRY_CAPABILITIES).map((key) => [
    key,
    source && Object.prototype.hasOwnProperty.call(source, key) ? source[key] === true : defaults[key],
  ]))
}

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
  return Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key,
    source
      ? ([MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT, MODULE_KEYS.PARTNER_SUPPLY].includes(key) && !Object.prototype.hasOwnProperty.call(source, key)
          ? defaults.has(key)
          : source[key] === true)
      : defaults.has(key),
  ]))
}

export function normalizeAccountPermissions(value, role = 'staff', legacyAssetCenter = false) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const modules = normalizeModules(source.modules, role, legacyAssetCenter)
  return {
    modules,
    [ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL]:
      source[ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL] === true,
    [ACCOUNT_PERMISSION_KEYS.EXTERNAL_ORDER_CREATE]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.EXTERNAL_ORDER_CREATE] === true),
    [ACCOUNT_PERMISSION_KEYS.EXTERNAL_SETTLEMENT_CONFIRM]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.EXTERNAL_SETTLEMENT_CONFIRM] === true),
    [ACCOUNT_PERMISSION_KEYS.MANUAL_EXTERNAL_REFUND_RECORD]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.MANUAL_EXTERNAL_REFUND_RECORD] === true),
    [ACCOUNT_PERMISSION_KEYS.MANUAL_EXTERNAL_REFUND_CONFIRM]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.MANUAL_EXTERNAL_REFUND_CONFIRM] === true),
    [ACCOUNT_PERMISSION_KEYS.REPORT_SALES_VIEW]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.REPORT_SALES_VIEW] === true),
    [ACCOUNT_PERMISSION_KEYS.REPORT_ALL_STORES]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.REPORT_ALL_STORES] === true),
    [ACCOUNT_PERMISSION_KEYS.REPORT_COST_VIEW]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.REPORT_COST_VIEW] === true),
    [ACCOUNT_PERMISSION_KEYS.REPORT_LABOR_VIEW]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.REPORT_LABOR_VIEW] === true),
    [ACCOUNT_PERMISSION_KEYS.REPORT_COST_MANAGE]:
      role === 'developer' || (role !== 'cashier' && source[ACCOUNT_PERMISSION_KEYS.REPORT_COST_MANAGE] === true),
    [ACCOUNT_PERMISSION_KEYS.DEVELOPER_SENSITIVE_RECORD_DELETE]: role === 'developer',
    [ACCOUNT_PERMISSION_KEYS.DAILY_ENTRY]: normalizeDailyEntryCapabilities(
      source[ACCOUNT_PERMISSION_KEYS.DAILY_ENTRY],
      role,
      modules,
    ),
    [ACCOUNT_PERMISSION_KEYS.SWEET_CARD]: normalizeSweetCardCapabilities(
      source[ACCOUNT_PERMISSION_KEYS.SWEET_CARD],
      role,
    ),
    [ACCOUNT_PERMISSION_KEYS.SWEET_CARD_PRODUCTION_TEST]:
      source[ACCOUNT_PERMISSION_KEYS.SWEET_CARD_PRODUCTION_TEST] === true,
  }
}

/** 独立高风险权限：不可下放，只有在职 developer 拥有。 */
export function hasDeveloperSensitiveRecordDelete(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role === 'developer' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.DEVELOPER_SENSITIVE_RECORD_DELETE],
  )
}

export function hasModuleAccess(user, moduleKey) {
  if (!user || user.status === 'disabled' || user.role === 'public' || !ALL_MODULE_KEYS.includes(moduleKey)) return false
  if (user.role === 'developer') return true
  if (user.role === 'cashier') return moduleKey === MODULE_KEYS.STORE_POS
  return normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true).modules[moduleKey] === true
}

export function hasDailyEntryCapability(user, capability) {
  if (!user || user.status === 'disabled' || !Object.values(DAILY_ENTRY_CAPABILITIES).includes(capability)) return false
  return normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)
    [ACCOUNT_PERMISSION_KEYS.DAILY_ENTRY][capability] === true
}

export function hasSweetCardCapability(user, capability) {
  if (!user || user.status === 'disabled' || !Object.values(SWEET_CARD_CAPABILITIES).includes(capability)) return false
  return normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)
    [ACCOUNT_PERMISSION_KEYS.SWEET_CARD][capability] === true
}

/** Production grey-release authority: explicit User.id-bound allowlist, never role-derived. */
export function hasSweetCardProductionTestAccess(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)
        [ACCOUNT_PERMISSION_KEYS.SWEET_CARD_PRODUCTION_TEST] === true,
  )
}

export function hasAnyModuleAccess(user, moduleKeys) {
  return Array.isArray(moduleKeys) && moduleKeys.some((key) => hasModuleAccess(user, key))
}

export function firstAccessibleModule(user) {
  return ALL_MODULE_KEYS.find((key) => hasPageAccess(user, key)) || ''
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

export function hasExternalOrderCreate(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.EXTERNAL_ORDER_CREATE],
  )
}

export function hasExternalSettlementConfirm(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.EXTERNAL_SETTLEMENT_CONFIRM],
  )
}

export function hasManualExternalRefundRecord(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.MANUAL_EXTERNAL_REFUND_RECORD],
  )
}

export function hasManualExternalRefundConfirm(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.MANUAL_EXTERNAL_REFUND_CONFIRM],
  )
}

export function hasReportSalesView(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.REPORT_SALES_VIEW],
  )
}

export function hasReportAllStores(user) {
  return Boolean(
    user &&
      user.status !== 'disabled' &&
      user.role !== 'public' &&
      normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.REPORT_ALL_STORES],
  )
}

export function hasReportCostView(user) {
  return Boolean(
    user && user.status !== 'disabled' && user.role !== 'public'
      && normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.REPORT_COST_VIEW],
  )
}

export function hasReportLaborView(user) {
  return Boolean(
    user && user.status !== 'disabled' && user.role !== 'public'
      && normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.REPORT_LABOR_VIEW],
  )
}

export function hasReportCostManage(user) {
  return Boolean(
    user && user.status !== 'disabled' && user.role !== 'public'
      && normalizeAccountPermissions(user.permissions, user.role, user.assetCenter === true)[ACCOUNT_PERMISSION_KEYS.REPORT_COST_MANAGE],
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
  if (pageKey === MODULE_KEYS.STORE_ENTRY) {
    return hasModuleAccess(user, pageKey) && hasDailyEntryCapability(user, DAILY_ENTRY_CAPABILITIES.VIEW)
  }
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

export function canCreatePartnerSupply(user) {
  return Boolean(user && ['developer', 'admin', 'finance', 'manager', 'staff'].includes(user.role) && hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY))
}

export function canAccessPartnerSupplyStore(user, storeKey) {
  if (!user || !hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY)) return false
  if (isSuperUser(user)) return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey)
}

export function canConfirmPartnerSupply(user, storeKey) {
  return Boolean(hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY) && (isSuperUser(user) || (user?.role === 'manager' && canAccessPartnerSupplyStore(user, storeKey))))
}

export function canManagePartnerSupplyPartners(user) {
  return Boolean(isSuperUser(user) && hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY))
}

export function canOverridePartnerSupplyPrice(user) {
  return Boolean(isSuperUser(user) && hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY))
}

export function canRegisterPartnerReceipt(user) {
  return Boolean(isSuperUser(user) && hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY))
}
