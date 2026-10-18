import { FIXED_STORES, fixedStoreName } from '../shared/storeDirectory.js'

/** Historical four-store fallback only; current names come from PostgreSQL. */
export const STATIC_STORE_NAMES = Object.fromEntries(FIXED_STORES.map((store) => [store.key, store.name]))

export function resolveStoreName(key, fallback = '') {
  if (!key) return fallback
  return fallback || fixedStoreName(key, key)
}
