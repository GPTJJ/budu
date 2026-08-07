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
  const data = await api('/userdata')
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
    }
  }
  return cached || { entries: {}, staff: [], removedStaff: [], analysis: {}, productImages: {}, stores: [], schedules: {}, products: [], inventoryRequests: [], inventory: [] }
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

export function commitEntries(entries) {
  getUserData().entries = entries
  syncUserData()
}

export function commitStaff(staff) {
  getUserData().staff = staff
  syncUserData()
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
