import { httpError } from './pos-core.js'
import { isStoreKey } from '../shared/storeDirectory.js'

export function storeDirectoryRow(store) {
  return { key: store.key, name: store.name, district: store.district || '', active: store.active === true,
    pickupEnabled: store.pickupEnabled === true }
}

const STATUS_ACTIONS = ['CREATE_STORE', 'ENABLE_STORE', 'DISABLE_STORE']

/** Existing append-only audits provide display dates; Store.active controls writes. */
export async function readStoreStatusHistory(db, storeKeys) {
  const keys = [...new Set(storeKeys)].filter(isStoreKey)
  const result = new Map(keys.map(key => [key, []]))
  if (!keys.length) return result
  const rows = await db.sensitiveRecordAudit.findMany({
    where: { recordType: 'store', recordId: { in: keys }, action: { in: STATUS_ACTIONS } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { recordId: true, action: true, reason: true, createdAt: true },
  })
  for (const row of rows) {
    let detail
    try { detail = JSON.parse(row.reason) } catch { continue }
    if (typeof detail?.after?.active !== 'boolean') continue
    if (row.action === 'ENABLE_STORE' && !detail.after.active) continue
    if (row.action === 'DISABLE_STORE' && detail.after.active) continue
    const timestamp = new Date(detail.executedAt || row.createdAt)
    if (!Number.isFinite(timestamp.getTime())) continue
    const event = { action: row.action, active: detail.after.active, executedAt: timestamp.toISOString() }
    if (row.action === 'DISABLE_STORE' && /^\d{4}-\d{2}-\d{2}$/.test(detail.businessClosedOn || '')) {
      event.businessClosedOn = detail.businessClosedOn
    }
    result.get(row.recordId)?.push(event)
  }
  for (const events of result.values()) events.sort((a, b) => a.executedAt.localeCompare(b.executedAt))
  return result
}

// Include disabled rows so history never depends on current operating status.
// Public callers use the default basic fields and never read the audit table.
export async function readStoreDirectory(db, { includeHistory = false } = {}) {
  if (includeHistory && typeof db.$transaction === 'function') {
    // Keep Store.active and its display history in one consistent snapshot.
    return db.$transaction(tx => readStoreDirectorySnapshot(tx, true), { isolationLevel: 'RepeatableRead' })
  }
  return readStoreDirectorySnapshot(db, includeHistory)
}

async function readStoreDirectorySnapshot(db, includeHistory) {
  const rows = (await db.store.findMany({
    select: { key: true, name: true, district: true, active: true, pickupEnabled: true, ...(includeHistory ? { createdAt: true } : {}) },
    orderBy: { key: 'asc' },
  })).filter(row => isStoreKey(row.key))
  if (!includeHistory) return rows.map(storeDirectoryRow)
  const histories = await readStoreStatusHistory(db, rows.map(row => row.key))
  return rows.map(row => ({ ...storeDirectoryRow(row),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    statusHistory: histories.get(row.key) || [],
  }))
}

/** Lookup only: ordinary operations must never create, rename or enable stores. */
export async function assertExistingStore(db, storeKey, { lock = false } = {}) {
  if (!isStoreKey(storeKey)) throw httpError('门店不存在', 404)
  if (lock) {
    if (typeof db.$queryRawUnsafe !== 'function') throw Error('STORE_OPERATION_LOCK_REQUIRED')
    await db.$queryRawUnsafe('SELECT key FROM "Store" WHERE key = $1 FOR SHARE', storeKey)
  }
  const store = await db.store.findUnique({ where: { key: storeKey } })
  if (!store) throw httpError('门店不存在', 404)
  return store
}

// Only new operating transactions use this check. Reads, provider results,
// refunds and historical maintenance retain their existing authorization.
export async function assertOperatingStore(db, storeKey, { payment = false, lock = false } = {}) {
  const store = await assertExistingStore(db, storeKey, { lock })
  if (store.active !== true) {
    const label = store.key === 'chaowai' ? '朝外店' : store.name || '该门店'
    const message = payment ? `${label}已停止营业，该订单无法继续发起支付，请重新选择门店下单。` : `${label}已停止营业，请选择其他门店。`
    throw Object.assign(httpError(message, 409), { code: 'STORE_CLOSED', publicCode: 'STORE_CLOSED' })
  }
  return store
}

export async function assertOperatingStores(db, storeKeys, options = {}) {
  const keys = [...new Set(storeKeys)].sort()
  const stores = []
  for (const key of keys) stores.push(await assertOperatingStore(db, key, options))
  return stores
}
