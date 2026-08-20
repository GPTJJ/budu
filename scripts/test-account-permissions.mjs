import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_MODULE_KEYS,
  MODULE_KEYS,
  canAccessTransferStore,
  canManageTransferStore,
  hasInventoryTransferAll,
  hasPageAccess,
  normalizeAccountPermissions,
  hasModuleAccess,
} from '../shared/accountPermissions.js'

test('开发者始终拥有库存调拨全权限', () => {
  const user = { role: 'developer', storeKeys: [] }
  assert.equal(hasInventoryTransferAll(user), true)
  assert.equal(canManageTransferStore(user, 'any-store'), true)
})

test('调拨全权限不依赖角色和绑定门店', () => {
  const user = { role: 'staff', storeKeys: ['guanshe'], permissions: { inventoryTransferAll: true } }
  assert.equal(hasInventoryTransferAll(user), true)
  assert.equal(canAccessTransferStore(user, 'other-store'), true)
  assert.equal(canManageTransferStore(user, 'other-store'), true)
})

test('普通店长只能管理绑定门店，普通店员不能审核', () => {
  const manager = { role: 'manager', storeKeys: ['guanshe'] }
  const staff = { role: 'staff', storeKeys: ['guanshe'] }
  assert.equal(canManageTransferStore(manager, 'guanshe'), true)
  assert.equal(canManageTransferStore(manager, 'other-store'), false)
  assert.equal(canAccessTransferStore(staff, 'guanshe'), true)
  assert.equal(canManageTransferStore(staff, 'guanshe'), false)
})

test('公开账号不能通过权限字段越权', () => {
  const user = { role: 'public', permissions: { inventoryTransferAll: true } }
  assert.equal(hasInventoryTransferAll(user), false)
  assert.equal(canManageTransferStore(user, 'guanshe'), false)
})

test('权限规范化保留已知模块并过滤未知字段', () => {
  const normalized = normalizeAccountPermissions({
    inventoryTransferAll: true,
    developer: true,
    modules: { overview: false, finance: true, unknown: true },
  }, 'staff')
  assert.equal(normalized.inventoryTransferAll, true)
  assert.equal(normalized.modules.overview, false)
  assert.equal(normalized.modules.finance, true)
  assert.equal(Object.hasOwn(normalized.modules, 'unknown'), false)
  assert.deepEqual(Object.keys(normalized.modules), [...ALL_MODULE_KEYS])
  assert.equal(normalizeAccountPermissions({ inventoryTransferAll: 'true' }).inventoryTransferAll, false)
})

test('开发者固定全权限，管理员财务默认全权限但可以被开发者收回', () => {
  assert.equal(ALL_MODULE_KEYS.every((key) => hasModuleAccess({ role: 'developer' }, key)), true)
  assert.equal(ALL_MODULE_KEYS.every((key) => hasModuleAccess({ role: 'admin' }, key)), true)
  const finance = { role: 'finance', permissions: { modules: { ...Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, true])), finance: false } } }
  assert.equal(hasModuleAccess(finance, MODULE_KEYS.FINANCE), false)
  assert.equal(hasModuleAccess(finance, MODULE_KEYS.OVERVIEW), true)
})

test('收银账号无论保存何种权限都固定仅开放 POS', () => {
  const cashier = { role: 'cashier', permissions: { modules: { finance: true, overview: true } } }
  assert.equal(hasModuleAccess(cashier, MODULE_KEYS.STORE_POS), true)
  assert.equal(hasModuleAccess(cashier, MODULE_KEYS.FINANCE), false)
  assert.equal(hasModuleAccess(cashier, MODULE_KEYS.OVERVIEW), false)
})

test('账号管理作为开发者保留页面不会被版块撤权检查送回首页', () => {
  assert.equal(hasPageAccess({ role: 'developer' }, 'account-admin'), true)
  assert.equal(hasPageAccess({ role: 'admin' }, 'account-admin'), false)
  assert.equal(hasPageAccess({ role: 'finance' }, 'account-admin'), false)
  assert.equal(hasPageAccess({ role: 'developer', status: 'disabled' }, 'account-admin'), false)
  assert.equal(hasPageAccess({ role: 'staff' }, MODULE_KEYS.STORE_POS), true)
})
