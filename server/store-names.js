import { FIXED_STORES, fixedStoreName } from '../shared/storeDirectory.js'

/** 固定四店中文名称；禁止在服务端维护第二份门店目录。 */
export const STATIC_STORE_NAMES = Object.fromEntries(FIXED_STORES.map((store) => [store.key, store.name]))

export function resolveStoreName(key, fallback = '') {
  if (!key) return fallback
  return fixedStoreName(key, fallback || key)
}
