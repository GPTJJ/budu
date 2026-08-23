import { api } from './api'

/**
 * 共享数据层：登录后从服务端加载「业绩录入 + 员工名单」，
 * 内存缓存 + 本地镜像（离线/SSR 时回退），变更后防抖同步到服务端。
 * 各模块通过 selectors 的 localEntries() / localStaffList() 读取，保持原有同步调用方式。
 * 首次登录会把旧版 localStorage 数据自动迁移到服务端。
 */

const MIRROR_KEY = 'budu-os-cloud-mirror-v1'
const MIRROR_OWNER_KEY = 'budu-os-cloud-mirror-owner-v1'
const LEGACY_ENTRIES_KEY = 'budu-os-store-entries-v1'
const LEGACY_STAFF_KEY = 'budu-os-staff-v1'

let cached = null
let saveTimer = null
const pendingFields = new Set()
let activeUserId = ''

function normalizeCachedData(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    entries: source.entries || {},
    staff: Array.isArray(source.staff) ? source.staff : [],
    removedStaff: Array.isArray(source.removedStaff) ? source.removedStaff : [],
    analysis: source.analysis && typeof source.analysis === 'object' ? source.analysis : {},
    productImages: source.productImages && typeof source.productImages === 'object' ? source.productImages : {},
    stores: Array.isArray(source.stores) ? source.stores : [],
    schedules: source.schedules && typeof source.schedules === 'object' ? source.schedules : {},
    products: Array.isArray(source.products) ? source.products : [],
    inventoryRequests: Array.isArray(source.inventoryRequests) ? source.inventoryRequests : [],
    inventory: Array.isArray(source.inventory) ? source.inventory : [],
    bigBonuses: Array.isArray(source.bigBonuses) ? source.bigBonuses : [],
    dailyPayAdjustments: Array.isArray(source.dailyPayAdjustments) ? source.dailyPayAdjustments : [],
    posDaily: Array.isArray(source.posDaily) ? source.posDaily : [],
    posProductSales: Array.isArray(source.posProductSales) ? source.posProductSales : [],
  }
}

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
    if (activeUserId) localStorage.setItem(MIRROR_OWNER_KEY, activeUserId)
  } catch {
    /* 忽略写入失败 */
  }
}

/**
 * 仅在镜像明确属于当前登录账号时恢复数据，避免同一台设备切换账号时短暂显示上一账号数据。
 * 返回 true 表示可以先展示镜像，再在后台刷新服务端数据。
 */
export function prepareUserDataForUser(userId) {
  const nextUserId = String(userId || '')
  if (activeUserId && activeUserId !== nextUserId) cached = null
  activeUserId = nextUserId
  if (!nextUserId || typeof localStorage === 'undefined') return false
  try {
    if (localStorage.getItem(MIRROR_OWNER_KEY) !== nextUserId) return false
    const mirror = readMirror()
    if (!mirror) return false
    cached = normalizeCachedData(mirror)
    return true
  } catch {
    return false
  }
}

/** 登录成功后拉取共享数据；首次登录自动迁移旧版本地数据 */
export async function loadUserData(options = {}) {
  const userId = typeof options === 'string' ? options : options?.userId
  const onBaseReady = typeof options === 'object' ? options?.onBaseReady : null
  if (userId) {
    const nextUserId = String(userId)
    if (activeUserId && activeUserId !== nextUserId) cached = null
    activeUserId = nextUserId
  }
  const data = await api('/userdata').catch(() => null)
  if (!data || typeof data !== 'object') return
  let previousMirror = null
  try {
    const owner = typeof localStorage !== 'undefined' ? localStorage.getItem(MIRROR_OWNER_KEY) : ''
    if (!activeUserId || owner === activeUserId) previousMirror = readMirror()
  } catch {
    previousMirror = null
  }
  cached = normalizeCachedData({
    ...data,
    bigBonuses: previousMirror?.bigBonuses,
    dailyPayAdjustments: previousMirror?.dailyPayAdjustments,
    posDaily: previousMirror?.posDaily,
    posProductSales: previousMirror?.posProductSales,
  })
  // 基础数据到达即可解除首屏等待，其余 PostgreSQL 数据并行在后台补齐。
  writeMirror()
  if (onBaseReady) {
    try {
      onBaseReady(cached)
    } catch {
      /* UI 回调异常不影响数据同步 */
    }
  }

  const requests = await Promise.allSettled([
    api('/v2/daily-entries'),
    api('/v2/daily-pay-adjustments'),
    api('/v2/pos/daily-summary'),
    api('/v2/pos/product-sales'),
    api('/v2/transfer-requests'),
    api('/v2/purchase-requests'),
    api('/v2/stock'),
    api('/v2/big-bonuses'),
  ])
  const result = (index) => (requests[index]?.status === 'fulfilled' ? requests[index].value : null)

  // v2（PostgreSQL）为业绩数据权威源：合并进缓存，保证首页统计与录入一致
  const v2 = result(0)
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

  const adjustments = result(1)
  if (adjustments) {
    cached.dailyPayAdjustments = ((adjustments && adjustments.rows) || []).map((row) => ({
      id: row.id,
      staffName: row.staffName,
      date: String(row.date || '').slice(0, 10),
      autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot) || 0,
      adjustedPayCents: Number(row.adjustedPayCents) || 0,
      reason: row.reason || '',
      createdBy: row.createdBy || '',
      updatedBy: row.updatedBy || '',
      createdAt: row.createdAt || '',
      updatedAt: row.updatedAt || '',
      version: Number(row.version) || 1,
    }))
  }

  const posDaily = result(2)
  const posProductSales = result(3)
  if (posDaily) {
    cached.posDaily = (posDaily && Array.isArray(posDaily.rows)) ? posDaily.rows : []
  }
  if (posProductSales) {
    cached.posProductSales = (posProductSales && Array.isArray(posProductSales.rows)) ? posProductSales.rows : []
  }

  // v2（PostgreSQL）为申请单/库存数据源
  const transfers = result(4)
  const purchases = result(5)
  const stock = result(6)
  if (transfers && purchases) {
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
  }
  if (stock) {
    cached.inventory = ((stock && stock.rows) || []).map((r) => ({
      storeKey: r.storeKey,
      productName: r.name,
      quantity: r.quantity,
      minQty: r.minQty || 0,
      updatedAt: r.updatedAt,
      updatedBy: '',
    }))
  }

  const bb = result(7)
  if (bb) {
    cached.bigBonuses = ((bb && bb.rows) || []).map((r) => ({
      id: r.id,
      staffKey: r.staffKey,
      storeKey: r.storeKey,
      date: String(r.date || '').slice(0, 10),
      amountCents: Number(r.amountCents) || 0,
      bonusCents: Number(r.bonusCents) || 0,
    }))
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
  let mirror = null
  try {
    const owner = typeof localStorage !== 'undefined' ? localStorage.getItem(MIRROR_OWNER_KEY) : ''
    if (!activeUserId || owner === activeUserId) mirror = readMirror()
  } catch {
    mirror = null
  }
  if (mirror) {
    cached = normalizeCachedData(mirror)
  }
  return cached || { entries: {}, staff: [], removedStaff: [], analysis: {}, productImages: {}, stores: [], schedules: {}, products: [], inventoryRequests: [], inventory: [], bigBonuses: [], dailyPayAdjustments: [], posDaily: [], posProductSales: [] }
}

export function getEntries() {
  return getUserData().entries
}

export function getStaff() {
  return getUserData().staff
}

function syncUserData(fields = []) {
  if (!cached) return
  for (const field of fields) pendingFields.add(field)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    writeMirror()
    const names = [...pendingFields]
    pendingFields.clear()
    const payload = Object.fromEntries(names.map((field) => [field, cached[field]]))
    if (names.length === 0) return
    api('/userdata', { method: 'PUT', body: JSON.stringify(payload) }).catch(() => {
      console.warn('数据同步失败，已保存在本机缓存，将在下次变更时自动重试')
    })
  }, 250)
}

export async function commitEntries(entries) {
  const prev = { ...(getUserData().entries || {}) }
  getUserData().entries = entries
  syncUserData(['entries'])
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
  writeMirror()
  // 直接以本次快照写服务端（不依赖 saveTimer 读 cached）：
  // 登录时 loadUserData 异步返回的旧数据可能覆盖 cached.staff，
  // 若走 syncUserData 定时器会把空 staff 推给服务端，导致新增员工
  // 在其他页面/设备（如账号管理绑定员工）不可见。
  const snapshot = Array.isArray(staff) ? staff : []
  let kvOk = false
  try {
    await api('/userdata', { method: 'PUT', body: JSON.stringify({ staff: snapshot }) })
    kvOk = true
  } catch {
    /* 服务端不可用时回退本地镜像 */
  }
  if (!kvOk) syncUserData(['staff'])
  try {
    await api('/v2/staff', { method: 'PUT', body: JSON.stringify({ staff: snapshot }) })
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
  syncUserData(['productImages'])
}

export function getStores() {
  return Array.isArray(getUserData().stores) ? getUserData().stores : []
}

export function commitStores(stores) {
  getUserData().stores = stores
  syncUserData(['stores'])
}

export function getSchedules() {
  const d = getUserData().schedules
  return d && typeof d === 'object' ? d : {}
}

export function commitSchedules(schedules) {
  getUserData().schedules = schedules
  syncUserData(['schedules'])
}

export function getProducts() {
  const p = getUserData().products
  return Array.isArray(p) ? p : []
}

export function commitProducts(products) {
  getUserData().products = products
  syncUserData(['products'])
}

export function getInventoryRequests() {
  const r = getUserData().inventoryRequests
  return Array.isArray(r) ? r : []
}

export function getBigBonuses() {
  const r = getUserData().bigBonuses
  return Array.isArray(r) ? r : []
}

export function getDailyPayAdjustments() {
  const rows = getUserData().dailyPayAdjustments
  return Array.isArray(rows) ? rows : []
}

/** 仅更新 PostgreSQL 权威数据的本地镜像，不写入 KV userdata。 */
export function replaceDailyPayAdjustments(rows) {
  getUserData().dailyPayAdjustments = Array.isArray(rows) ? rows : []
  writeMirror()
}

export function upsertDailyPayAdjustment(row) {
  const rows = getDailyPayAdjustments().filter((item) => item.id !== row.id)
  replaceDailyPayAdjustments([...rows, row])
}

export function removeDailyPayAdjustment(id) {
  replaceDailyPayAdjustments(getDailyPayAdjustments().filter((row) => row.id !== id))
}

export function commitInventoryRequests(requests) {
  getUserData().inventoryRequests = requests
  syncUserData(['inventoryRequests'])
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
  syncUserData(['inventory', 'inventoryRequests'])
}

export function commitRemovedStaff(removedStaff) {
  getUserData().removedStaff = removedStaff
  syncUserData(['removedStaff'])
}

export function resetUserData() {
  cached = null
  activeUserId = ''
  if (saveTimer) clearTimeout(saveTimer)
  pendingFields.clear()
}
