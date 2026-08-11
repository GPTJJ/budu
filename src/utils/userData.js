import { api } from './api'

/**
 * 共享数据层：登录后从服务端加载「业绩录入 + 员工名单」，
 * 内存缓存 + 本地镜像（离线/SSR 时回退），变更后防抖同步到服务端。
 * 各模块通过 selectors 的 localEntries() / localStaffList() 读取，保持原有同步调用方式。
 * 首次登录会把旧版 localStorage 数据自动迁移到服务端。
 */

const MIRROR_KEY = 'budu-os-cloud-mirror-v1'
const LEGACY_ENTRIES_KEY = 'budu-os-store-entries-v1'
const LEGACY_STAFF_KEY = 'budu-os-staff-v1'

let cached = null
let saveTimer = null

function readMirror() {
  if (typeof localStorage === 'undefined') return null
  try {
    const v = JSON.parse(localStorage.getItem(MIRROR_KEY))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function readLegacy() {
  if (typeof localStorage === 'undefined') return { entries: null, staff: null }
  try {
    const entriesRaw = localStorage.getItem(LEGACY_ENTRIES_KEY)
    const staffRaw = localStorage.getItem(LEGACY_STAFF_KEY)
    let entries = null
    let staff = null
    if (entriesRaw) {
      const v = JSON.parse(entriesRaw)
      if (v && typeof v === 'object' && !Array.isArray(v)) entries = v
    }
    if (staffRaw) {
      const v = JSON.parse(staffRaw)
      if (Array.isArray(v)) staff = v
    }
    return { entries, staff }
  } catch {
    return { entries: null, staff: null }
  }
}

function writeMirror() {
  if (typeof localStorage === 'undefined' || !cached) return
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(cached))
  } catch {
    /* 忽略写入失败 */
  }
}

/** 登录成功后拉取共享数据；首次登录自动迁移旧版本地数据 */
export async function loadUserData() {
  const data = await api('/userdata').catch(() => null)
  if (!data || typeof data !== 'object') return
  cached = {
    entries: data.entries || {},
    staff: Array.isArray(data.staff) ? data.staff : [],
    removedStaff: Array.isArray(data.removedStaff) ? data.removedStaff : [],
    analysis: data.analysis && typeof data.analysis === 'object' ? data.analysis : {},
    productImages: data.productImages && typeof data.productImages === 'object' ? data.productImages : {},
    stores: Array.isArray(data.stores) ? data.stores : [],
    schedules: data.schedules && typeof data.schedules === 'object' ? data.schedules : {},
    products: Array.isArray(data.products) ? data.products : [],
    inventoryRequests: Array.isArray(data.inventoryRequests) ? data.inventoryRequests : [],
    inventory: Array.isArray(data.inventory) ? data.inventory : [],
    bigBonuses: [],
    posDaily: [],
    posProductSales: [],
  }
  // v2（PostgreSQL）为业绩数据权威源：合并进缓存，保证首页统计与录入一致
  try {
    const v2 = await api('/v2/daily-entries')
    if (v2 && Array.isArray(v2.rows) && v2.rows.length > 0) {
      const merged = {}
      for (const row of v2.rows) {
        const key = `${row.date.slice(0, 7)}|${row.storeKey}|${row.date.slice(5)}`
        merged[key] = {
          inc: Number(row.incCents) / 100,
          ord: row.ord,
          staff: Array.isArray(row.staffNames) ? row.staffNames : [],
          v2version: row.version,
        }
      }
      cached.entries = merged
    }
  } catch {
    /* v2 不可用时回退 KV */
  }
  try {
    const [posDaily, posProductSales] = await Promise.all([
      api('/v2/pos/daily-summary'),
      api('/v2/pos/product-sales'),
    ])
    cached.posDaily = (posDaily && Array.isArray(posDaily.rows)) ? posDaily.rows : []
    cached.posProductSales = (posProductSales && Array.isArray(posProductSales.rows)) ? posProductSales.rows : []
  } catch {
    /* POS 汇总不可用时保留旧值 */
  }
  // v2（PostgreSQL）为申请单/库存数据源
  try {
    const [transfers, purchases, stock] = await Promise.all([
      api('/v2/transfer-requests'),
      api('/v2/purchase-requests'),
      api('/v2/stock'),
    ])
    const reqs = []
    for (const r of (transfers && transfers.rows) || []) {
      reqs.push({
        id: r.id,
        type: 'transfer',
        storeKey: r.storeKey,
        fromStoreKey: r.fromStoreKey,
        status: r.status,
        note: r.note,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        history: [],
        items: (r.items || []).map((it) => ({
          category: it.category,
          productName: it.productName,
          quantity: it.quantity,
          note: it.note,
          itemId: it.itemId,
        })),
      })
    }
    for (const r of (purchases && purchases.rows) || []) {
      reqs.push({
        id: r.id,
        type: 'purchase',
        storeKey: r.storeKey,
        status: r.status === 'received' ? 'done' : r.status,
        note: r.note,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        history: [],
        items: (r.items || []).map((it) => ({
          category: it.category,
          productName: it.productName,
          quantity: it.receivedQty || it.quantity,
          note: it.note,
          itemId: it.itemId,
        })),
      })
    }
    cached.inventoryRequests = reqs
    cached.inventory = ((stock && stock.rows) || []).map((r) => ({
      storeKey: r.storeKey,
      productName: r.name,
      quantity: r.quantity,
      minQty: r.minQty || 0,
      updatedAt: r.updatedAt,
      updatedBy: '',
    }))
    try {
      const bb = await api('/v2/big-bonuses')
      cached.bigBonuses = ((bb && bb.rows) || []).map((r) => ({
        id: r.id,
        staffKey: r.staffKey,
        storeKey: r.storeKey,
        date: String(r.date || '').slice(0, 10),
        amountCents: Number(r.amountCents) || 0,
        bonusCents: Number(r.bonusCents) || 0,
      }))
    } catch {
      cached.bigBonuses = Array.isArray(cached.bigBonuses) ? cached.bigBonuses : []
    }
  } catch {
    /* v2 不可用时回退 KV */
  }
  const legacy = readLegacy()
  let migrated = false
  if (legacy.entries && Object.keys(legacy.entries).length > 0 && Object.keys(cached.entries).length === 0) {
    cached.entries = legacy.entries
    migrated = true
  }
  if (legacy.staff && legacy.staff.length > 0 && cached.staff.length === 0) {
    cached.staff = legacy.staff
    migrated = true
  }
  writeMirror()
  if (migrated) {
    try {
      await api('/userdata', { method: 'PUT', body: JSON.stringify(cached) })
    } catch {
      /* 迁移失败不阻塞登录 */
    }
  }
  return cached
}

export function getUserData() {
  if (cached) return cached
  const mirror = readMirror()
  if (mirror) {
    cached = {
      entries: mirror.entries || {},
      staff: Array.isArray(mirror.staff) ? mirror.staff : [],
      removedStaff: Array.isArray(mirror.removedStaff) ? mirror.removedStaff : [],
      analysis: mirror.analysis && typeof mirror.analysis === 'object' ? mirror.analysis : {},
      productImages: mirror.productImages && typeof mirror.productImages === 'object' ? mirror.productImages : {},
      stores: Array.isArray(mirror.stores) ? mirror.stores : [],
      schedules: mirror.schedules && typeof mirror.schedules === 'object' ? mirror.schedules : {},
      products: Array.isArray(mirror.products) ? mirror.products : [],
      inventoryRequests: Array.isArray(mirror.inventoryRequests) ? mirror.inventoryRequests : [],
      inventory: Array.isArray(mirror.inventory) ? mirror.inventory : [],
      bigBonuses: Array.isArray(mirror.bigBonuses) ? mirror.bigBonuses : [],
      posDaily: Array.isArray(mirror.posDaily) ? mirror.posDaily : [],
      posProductSales: Array.isArray(mirror.posProductSales) ? mirror.posProductSales : [],
    }
  }
  return cached || { entries: {}, staff: [], removedStaff: [], analysis: {}, productImages: {}, stores: [], schedules: {}, products: [], inventoryRequests: [], inventory: [], bigBonuses: [], posDaily: [], posProductSales: [] }
}

export function getEntries() {
  return getUserData().entries
}

export function getStaff() {
  return getUserData().staff
}

function syncUserData() {
  if (!cached) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    writeMirror()
    api('/userdata', { method: 'PUT', body: JSON.stringify(cached) }).catch(() => {
      console.warn('数据同步失败，已保存在本机缓存，将在下次变更时自动重试')
    })
  }, 250)
}

export async function commitEntries(entries) {
  const prev = { ...(getUserData().entries || {}) }
  getUserData().entries = entries
  syncUserData()
  // 同步写入 PostgreSQL（单条 upsert + 乐观锁），避免整库覆盖
  const changed = Object.keys(entries).filter((k) => JSON.stringify(entries[k]) !== JSON.stringify(prev[k]))
  const removed = Object.keys(prev).filter((k) => !(k in entries))
  for (const k of changed) {
    const parts = k.split('|')
    if (parts.length !== 3) continue
    const [month, storeKey, day] = parts
    const v = entries[k]
    try {
      const res = await api('/v2/daily-entries', {
        method: 'PUT',
        body: JSON.stringify({
          storeKey,
          date: `${month}-${day.slice(3)}`,
          incCents: Math.round((Number(v.inc) || 0) * 100),
          ord: Number(v.ord) || 0,
          staffNames: Array.isArray(v.staff) ? v.staff : [],
          version: v.v2version,
        }),
      })
      if (res && res.row) entries[k] = { ...v, v2version: res.row.version }
    } catch (err) {
      if (err.status === 409 && err.data && err.data.latest) {
        entries[k] = {
          inc: Number(err.data.latest.incCents) / 100,
          ord: err.data.latest.ord,
          staff: Array.isArray(err.data.latest.staffNames) ? err.data.latest.staffNames : [],
          v2version: err.data.latest.version,
        }
        console.warn('业绩版本冲突，已加载最新数据')
      }
    }
  }
  for (const k of removed) {
    const parts = k.split('|')
    if (parts.length !== 3) continue
    const [month, storeKey, day] = parts
    try {
      await api('/v2/daily-entries', {
        method: 'DELETE',
        body: JSON.stringify({ storeKey, date: `${month}-${day.slice(3)}` }),
      })
    } catch (err) {
      console.warn('业绩删除同步失败：', err.message)
    }
  }
  writeMirror()
}

export async function commitStaff(staff) {
  getUserData().staff = staff
  syncUserData()
  try {
    await api('/v2/staff', { method: 'PUT', body: JSON.stringify({ staff }) })
  } catch {
    /* PostgreSQL 不可用时仅同步 KV */
  }
}

export function getRemovedStaff() {
  return Array.isArray(getUserData().removedStaff) ? getUserData().removedStaff : []
}

export function getAnalysis() {
  return getUserData().analysis && typeof getUserData().analysis === 'object' ? getUserData().analysis : {}
}

export function getProductImages() {
  return getUserData().productImages && typeof getUserData().productImages === 'object'
    ? getUserData().productImages
    : {}
}

export function commitProductImages(images) {
  getUserData().productImages = images
  syncUserData()
}

export function getStores() {
  return Array.isArray(getUserData().stores) ? getUserData().stores : []
}

export function commitStores(stores) {
  getUserData().stores = stores
  syncUserData()
}

export function getSchedules() {
  const d = getUserData().schedules
  return d && typeof d === 'object' ? d : {}
}

export function commitSchedules(schedules) {
  getUserData().schedules = schedules
  syncUserData()
}

export function getProducts() {
  const p = getUserData().products
  return Array.isArray(p) ? p : []
}

export function commitProducts(products) {
  getUserData().products = products
  syncUserData()
}

export function getInventoryRequests() {
  const r = getUserData().inventoryRequests
  return Array.isArray(r) ? r : []
}

export function getBigBonuses() {
  const r = getUserData().bigBonuses
  return Array.isArray(r) ? r : []
}

export function commitInventoryRequests(requests) {
  getUserData().inventoryRequests = requests
  syncUserData()
}

export function getInventory() {
  const rows = getUserData().inventory
  return Array.isArray(rows) ? rows : []
}

/** 同步提交库存和申请单，保证发货/收货时两份数据一起保存。 */
export function commitInventoryState(inventory, requests) {
  const data = getUserData()
  data.inventory = inventory
  data.inventoryRequests = requests
  syncUserData()
}

export function commitRemovedStaff(removedStaff) {
  getUserData().removedStaff = removedStaff
  syncUserData()
}

export function resetUserData() {
  cached = null
  if (saveTimer) clearTimeout(saveTimer)
}
