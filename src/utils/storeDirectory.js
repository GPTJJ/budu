import { isStoreKey } from '../../shared/storeDirectory.js'

/** Validate a complete PostgreSQL directory response before using its state. */
export function isStoreDirectoryRows(rows) {
  return Array.isArray(rows)
    && rows.every((store) => store && isStoreKey(store.key)
      && typeof store.name === 'string' && Boolean(store.name.trim())
      && typeof store.active === 'boolean')
    && new Set(rows.map((store) => store.key)).size === rows.length
}

export function newStoreRequestKey() {
  return `store-${globalThis.crypto.randomUUID()}`
}

/** The existing cross-tab channel carries invalidation only, never store data. */
export function broadcastStoreDirectoryChanged() {
  let channel
  try {
    channel = new BroadcastChannel('budu-auth-sync')
    channel.postMessage({ type: 'stores-changed' })
  } catch {
    // Focus/poll refresh remains available when BroadcastChannel is unsupported.
  } finally {
    channel?.close()
  }
}
