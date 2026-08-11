import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canAccessTransferStore,
  canManageTransferStore,
  hasInventoryTransferAll,
  normalizeAccountPermissions,
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

test('权限规范化只保留已知布尔权限', () => {
  assert.deepEqual(normalizeAccountPermissions({ inventoryTransferAll: true, developer: true }), {
    inventoryTransferAll: true,
  })
  assert.deepEqual(normalizeAccountPermissions({ inventoryTransferAll: 'true' }), {
    inventoryTransferAll: false,
  })
})
