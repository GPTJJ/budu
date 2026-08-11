export const ACCOUNT_PERMISSION_KEYS = Object.freeze({
  INVENTORY_TRANSFER_ALL: 'inventoryTransferAll',
})

export function normalizeAccountPermissions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    [ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL]:
      source[ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL] === true,
  }
}

export function hasInventoryTransferAll(user) {
  return Boolean(
    user &&
      user.role !== 'public' &&
      (user.role === 'developer' ||
        normalizeAccountPermissions(user.permissions)[ACCOUNT_PERMISSION_KEYS.INVENTORY_TRANSFER_ALL]),
  )
}

export function canAccessTransferStore(user, storeKey) {
  if (!user || user.role === 'public') return false
  if (hasInventoryTransferAll(user)) return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey)
}

export function canManageTransferStore(user, storeKey) {
  if (!user || user.role === 'public') return false
  if (hasInventoryTransferAll(user)) return true
  return user.role === 'manager' && canAccessTransferStore(user, storeKey)
}
