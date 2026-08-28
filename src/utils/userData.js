import { api } from './api.js'
import { monthsInPayrollRange } from './payrollPeriod.js'

/**
 * 共享数据层：登录后从服务端加载「业绩录入 + 员工名单」，
 * 内存缓存 + 本地镜像（离线/SSR 时回退），变更后防抖同步到服务端。
 * 各模块通过 selectors 的 localEntries() / localStaffList() 读取，保持原有同步调用方式。
 * 首次登录会把旧版 localStorage 数据自动迁移到服务端。
 */


let cached = null
let activeUserId = ''
let userDataGeneration = 0
let staffMonthRequestSequence = 0

export const STAFF_MONTH_LOAD_STATE = Object.freeze({
  NOT_LOADED: 'not_loaded',
  LOADING: 'loading',
  LOADED: 'loaded',
  ERROR: 'error',
})

// 月缓存状态与请求都绑定到当前账号代际。reset/切换账号会推进 generation，
// 旧账号的迟到响应因此不能写入新账号缓存。
const staffMonthStates = new Map()
const inflightStaffMonths = new Map()

function invalidateMonthlyAttendanceCache({ clearPayload = true } = {}) {
  userDataGeneration += 1
  staffMonthStates.clear()
  inflightStaffMonths.clear()
  if (clearPayload && cached) cached.dailyStoreStaffByMonth = {}
}

function activateUser(nextUserId) {
  const next = String(nextUserId || '')
  if (activeUserId !== next) {
    invalidateMonthlyAttendanceCache()
    cached = null
    activeUserId = next
  }
  return { userId: activeUserId, generation: userDataGeneration }
}

// 数据更新通知：后台拉取/合并完成后回调订阅者，让已挂载的页面重新渲染最新缓存
const dataListeners = new Set()
export function onUserDataUpdated(listener) {
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}
function notifyUserDataUpdated() {
  for (const listener of dataListeners) {
    try {
      listener()
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}
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
    // Gate 21：DailyStoreStaff 按月键控缓存（YYYY-MM → rows）；不再使用单一共享数组
    dailyStoreStaffByMonth: source.dailyStoreStaffByMonth && typeof source.dailyStoreStaffByMonth === 'object'
      ? source.dailyStoreStaffByMonth
      : {},
    posDaily: Array.isArray(source.posDaily) ? source.posDaily : [],
    posProductSales: Array.isArray(source.posProductSales) ? source.posProductSales : [],
  }
}

/**
 * 仅在镜像明确属于当前登录账号时恢复数据，避免同一台设备切换账号时短暂显示上一账号数据。
 * 返回 true 表示可以先展示镜像，再在后台刷新服务端数据。
 */
export function prepareUserDataForUser(userId) {
  // DA-5：JSON/localStorage 镜像不再作为业务数据源（读权威 = PostgreSQL）
  const nextUserId = String(userId || '')
  activateUser(nextUserId)
  return false
}

/** 登录成功后拉取共享数据；首次登录自动迁移旧版本地数据 */
export async function loadUserData(options = {}) {
  const userId = typeof options === 'string' ? options : options?.userId
  const onBaseReady = typeof options === 'object' ? options?.onBaseReady : null
  if (userId) {
    activateUser(userId)
  }
  const requestOwner = { userId: activeUserId, generation: userDataGeneration }
  const ownsCurrentSession = () => (
    requestOwner.generation === userDataGeneration && requestOwner.userId === activeUserId
  )
  // Data Authority DA-4/DA-2.2：entries 与 staff 的唯一权威是 PostgreSQL。
  // 先暂存进入本函数前的内存缓存（上一次会话内成功的 PG 数据），
  // 基础 KV 数据中的 entries/staff 不再作为初始值/回退。
  const prevEntries = cached && cached.entries ? cached.entries : {}
  const prevStaff = cached && Array.isArray(cached.staff) ? cached.staff : []
  // Legacy 与 PostgreSQL authority bootstrap 必须彼此独立：先同时启动，
  // 避免 /userdata 失败或变慢时阻止 PG 权威接口发出请求。
  const legacyRequest = api('/userdata').catch(() => null)
  const pgAuthorityRequest = Promise.allSettled([
    api('/v2/daily-entries'),
    api('/v2/daily-pay-adjustments'),
    api('/v2/pos/daily-summary'),
    api('/v2/pos/product-sales'),
    api('/v2/transfer-requests'),
    api('/v2/purchase-requests'),
    api('/v2/stock'),
    api('/v2/big-bonuses'),
    api('/v2/staff-list'),
    api('/v2/stores'),
  ])
  const data = await legacyRequest
  if (!ownsCurrentSession()) return cached
  // DA-5：JSON 镜像不再作为业务数据源；bigBonuses/调整/POS 汇总等一律以 PG 接口为准。
  // legacy 失败时仅保留当前账号已有的内存数据；首次加载则创建空缓存容器承接 PG 结果，
  // 但不把 KV 空对象或 legacy 字段当成任何 PG 权威域的业务事实。
  if (data && typeof data === 'object') cached = normalizeCachedData(data)
  else if (!cached) cached = normalizeCachedData(null)
  cached.entries = {} // entries 权威为 PG：不以 KV 初始值/回退
  cached.staff = [] // staff 权威为 PG /v2/staff-list：不以 KV 初始值/回退
  cached.stores = [] // stores 权威为 PG /v2/stores：不展示 KV/旧缓存中的幽灵门店
  // 基础数据到达即可解除首屏等待，其余 PostgreSQL 数据并行在后台补齐。
  if (onBaseReady) {
    try {
      onBaseReady(cached)
    } catch {
      /* UI 回调异常不影响数据同步 */
    }
  }

  const requests = await pgAuthorityRequest
  if (!ownsCurrentSession()) return cached
  const result = (index) => (requests[index]?.status === 'fulfilled' ? requests[index].value : null)

  // v2（PostgreSQL）为业绩数据唯一权威源：即使 PG 返回空也是事实（无 KV 回退）。
  // PG 查询失败 → 保留上一次成功加载的 PG 缓存并显式告警（非 KV 回退）。
  const v2 = result(0)
  if (v2 && Array.isArray(v2.rows)) {
    const merged = {}
    for (const row of v2.rows) {
      const key = `${row.date.slice(0, 7)}|${row.storeKey}|${row.date.slice(5)}`
      merged[key] = {
        inc: Number(row.incCents) / 100,
        ord: row.ord,
        staff: Array.isArray(row.staffNames) ? row.staffNames : [],
        status: row.status,
        v2version: row.version,
      }
    }
    cached.entries = merged
  } else {
    if (Object.keys(prevEntries).length > 0) cached.entries = prevEntries
    console.error(`[data-authority] DailyEntry 读取失败（PostgreSQL 不可用），${Object.keys(prevEntries).length > 0 ? '展示上次 PG 成功缓存' : '不使用 KV 回退'}`)
  }

  // DA-2.2：员工名单权威 = PG /v2/staff-list
  const staffRes = result(8)
  if (staffRes && Array.isArray(staffRes.rows)) {
    cached.staff = staffRes.rows
  } else {
    if (prevStaff.length > 0) cached.staff = prevStaff
    console.error(`[data-authority] 员工名单读取失败（PostgreSQL 不可用），${prevStaff.length > 0 ? '展示上次 PG 成功缓存' : '不使用 KV 回退'}`)
  }

  // DA-2.3：门店目录权威 = PG /v2/stores（静态 BASE_STORES 仅作同步渲染种子，PG 覆盖）
  const storesRes = result(9)
  if (storesRes && Array.isArray(storesRes.rows)) {
    cached.stores = storesRes.rows
  }

  const adjustments = result(1)
  if (adjustments) {
    cached.dailyPayAdjustments = ((adjustments && adjustments.rows) || []).map((row) => ({
      id: row.id,
      employeeId: row.employeeId || '',
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
        storeName: r.storeName || '',
        fromStoreName: r.fromStoreName || '',
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
      employeeId: r.employeeId || '',
      staffKey: r.staffKey,
      staffName: r.staffName || '',
      storeKey: r.storeKey,
      date: String(r.date || '').slice(0, 10),
      amountCents: Number(r.amountCents) || 0,
      bonusCents: Number(r.bonusCents) || 0,
    }))
  }
  // DA-5：legacy localStorage 迁移已退役（数据权威 = PG）
  // 后台并行数据（含 PostgreSQL 业绩权威源）合并完成后，通知已挂载页面刷新
  notifyUserDataUpdated()
  // Gate 12：按月懒加载 DailyStoreStaff（有界窗口，不进主请求数组）
  const currentMonth = new Date().toISOString().slice(0, 7)
  loadDailyStoreStaffMonth(currentMonth).catch(() => {})
  return cached
}

/**
 * Gate 21：按月加载 DailyStoreStaff 稳定考勤数据（月键控缓存，月与月完全隔离）。
 * - cached.dailyStoreStaffByMonth[YYYY-MM] 为各月独立数据集；互不覆盖
 * - 有界窗口：仅请求指定月份；同月幂等（已加载直接返回缓存；并发中共享同一 in-flight 请求）
 * - legacy 行 employeeId 保持 null 原样透传，绝不按姓名推断
 * @param {string} month YYYY-MM
 * @param {object} [opts] { force } force=true 强制重新拉取（刷新/失效用）
 */
export async function loadDailyStoreStaffMonth(month, opts = {}) {
  const key = String(month || '')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    return { month: key, status: STAFF_MONTH_LOAD_STATE.NOT_LOADED, rows: [] }
  }
  const owner = { userId: activeUserId, generation: userDataGeneration }
  const requestToken = staffMonthRequestSequence + 1
  staffMonthRequestSequence = requestToken
  const ownsCurrentSession = () => (
    owner.generation === userDataGeneration && owner.userId === activeUserId
  )
  const ownsCurrentRequest = () => (
    ownsCurrentSession() && staffMonthStates.get(key)?.requestToken === requestToken
  )
  const byMonth = cached?.dailyStoreStaffByMonth
  const hasPayload = Boolean(
    byMonth && Object.prototype.hasOwnProperty.call(byMonth, key) && Array.isArray(byMonth[key]),
  )
  const state = staffMonthStates.get(key)
  const stateMatchesOwner = state?.generation === owner.generation && state?.userId === owner.userId
  if (!opts.force && stateMatchesOwner && state.status === STAFF_MONTH_LOAD_STATE.LOADED && hasPayload) {
    return { month: key, status: STAFF_MONTH_LOAD_STATE.LOADED, rows: byMonth[key] }
  }
  // marker 与 payload 不一致即视为损坏，绝不以“已加载”短路。
  if (state?.status === STAFF_MONTH_LOAD_STATE.LOADED && !hasPayload) staffMonthStates.delete(key)
  const inflight = inflightStaffMonths.get(key)
  if (!opts.force && inflight && inflight.generation === owner.generation && inflight.userId === owner.userId) {
    return inflight.promise
  }
  staffMonthStates.set(key, {
    month: key,
    status: STAFF_MONTH_LOAD_STATE.LOADING,
    generation: owner.generation,
    userId: owner.userId,
    requestToken,
    error: null,
  })
  const promise = (async () => {
    try {
      const res = await api(`/v2/daily-store-staff?month=${key}`)
      const rows = Array.isArray(res && res.rows) ? res.rows : []
      if (!ownsCurrentRequest()) return { month: key, status: 'ignored', rows: [] }
      if (!cached) cached = normalizeCachedData(null)
      const nextByMonth = { ...(cached.dailyStoreStaffByMonth || {}) }
      nextByMonth[key] = rows
      cached.dailyStoreStaffByMonth = nextByMonth
      staffMonthStates.set(key, {
        month: key,
        status: STAFF_MONTH_LOAD_STATE.LOADED,
        generation: owner.generation,
        userId: owner.userId,
        requestToken,
        error: null,
      })
      notifyUserDataUpdated()
      return { month: key, status: STAFF_MONTH_LOAD_STATE.LOADED, rows }
    } catch (e) {
      if (!ownsCurrentRequest()) return { month: key, status: 'ignored', rows: [] }
      const nextByMonth = { ...(cached?.dailyStoreStaffByMonth || {}) }
      delete nextByMonth[key]
      if (!cached) cached = normalizeCachedData(null)
      cached.dailyStoreStaffByMonth = nextByMonth
      staffMonthStates.set(key, {
        month: key,
        status: STAFF_MONTH_LOAD_STATE.ERROR,
        generation: owner.generation,
        userId: owner.userId,
        requestToken,
        error: e?.message || '加载失败',
      })
      notifyUserDataUpdated()
      console.error(`[daily-store-staff] ${key} 加载失败：`, e?.message)
      return { month: key, status: STAFF_MONTH_LOAD_STATE.ERROR, rows: [], error: e }
    } finally {
      const current = inflightStaffMonths.get(key)
      if (current?.promise === promise && current?.generation === owner.generation && current?.userId === owner.userId) {
        inflightStaffMonths.delete(key)
      }
    }
  })()
  inflightStaffMonths.set(key, { ...owner, promise })
  return promise
}

/** Gate 21：失效某月缓存并重新拉取（只影响该月，其他月不受影响） */
export async function refreshDailyStoreStaffMonth(month) {
  const key = String(month || '')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return
  staffMonthStates.delete(key)
  const byMonth = { ...(getUserData().dailyStoreStaffByMonth || {}) }
  delete byMonth[key]
  getUserData().dailyStoreStaffByMonth = byMonth
  return loadDailyStoreStaffMonth(key, { force: true })
}

/**
 * Gate 21：读取指定月份的 DailyStoreStaff 行——月身份属于缓存键，绝不回退到"最后加载的月份"。
 * 未加载月份返回空数组（不会拿到其他月数据）。
 */
export function getDailyStoreStaff(month) {
  const key = String(month || '')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return []
  const byMonth = getUserData().dailyStoreStaffByMonth || {}
  return Array.isArray(byMonth[key]) ? byMonth[key] : []
}

/**
 * 返回当前账号代际下某月的显式加载状态。
 * LOADED + rows=[] 表示权威空月；缺少 payload 时永远不会伪装成 LOADED。
 */
export function getDailyStoreStaffMonthState(month) {
  const key = String(month || '')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    return { month: key, status: STAFF_MONTH_LOAD_STATE.NOT_LOADED, hasPayload: false, rows: [], error: null }
  }
  const byMonth = cached?.dailyStoreStaffByMonth
  const hasPayload = Boolean(
    byMonth && Object.prototype.hasOwnProperty.call(byMonth, key) && Array.isArray(byMonth[key]),
  )
  const state = staffMonthStates.get(key)
  const ownsState = state?.generation === userDataGeneration && state?.userId === activeUserId
  if (!ownsState) {
    return { month: key, status: STAFF_MONTH_LOAD_STATE.NOT_LOADED, hasPayload, rows: hasPayload ? byMonth[key] : [], error: null }
  }
  if (state.status === STAFF_MONTH_LOAD_STATE.LOADED && !hasPayload) {
    return { month: key, status: STAFF_MONTH_LOAD_STATE.NOT_LOADED, hasPayload: false, rows: [], error: null }
  }
  return {
    month: key,
    status: state.status,
    hasPayload,
    rows: hasPayload ? byMonth[key] : [],
    error: state.error || null,
  }
}

/** Load all attendance months intersecting an inclusive payroll range. */
export async function loadDailyStoreStaffRange(periodStart, periodEnd, opts = {}) {
  const months = monthsInPayrollRange(periodStart, periodEnd)
  const rangeKey = `${periodStart}|${periodEnd}`
  if (months.length === 0) return { rangeKey, status: STAFF_MONTH_LOAD_STATE.NOT_LOADED, complete: false, months: [], rows: [] }
  await Promise.all(months.map((month) => loadDailyStoreStaffMonth(month, opts)))
  return getDailyStoreStaffRangeState(periodStart, periodEnd)
}

export function getDailyStoreStaffRange(periodStart, periodEnd) {
  return monthsInPayrollRange(periodStart, periodEnd).flatMap((month) => getDailyStoreStaff(month))
}

/**
 * A range is complete only when every intersecting month has a payload marker
 * owned by the current account generation. Empty loaded months remain facts.
 */
export function getDailyStoreStaffRangeState(periodStart, periodEnd) {
  const months = monthsInPayrollRange(periodStart, periodEnd)
  const rangeKey = `${periodStart}|${periodEnd}`
  if (months.length === 0) {
    return { rangeKey, status: STAFF_MONTH_LOAD_STATE.NOT_LOADED, complete: false, months: [], missingMonths: [], rows: [] }
  }
  const states = months.map((month) => getDailyStoreStaffMonthState(month))
  const missingMonths = states
    .filter((state) => state.status !== STAFF_MONTH_LOAD_STATE.LOADED || !state.hasPayload)
    .map((state) => state.month)
  const hasError = states.some((state) => state.status === STAFF_MONTH_LOAD_STATE.ERROR)
  const loading = states.some((state) => state.status === STAFF_MONTH_LOAD_STATE.LOADING)
  const status = missingMonths.length === 0
    ? STAFF_MONTH_LOAD_STATE.LOADED
    : hasError
      ? STAFF_MONTH_LOAD_STATE.ERROR
      : loading
        ? STAFF_MONTH_LOAD_STATE.LOADING
        : STAFF_MONTH_LOAD_STATE.NOT_LOADED
  return {
    rangeKey,
    status,
    complete: missingMonths.length === 0,
    months,
    missingMonths,
    rows: missingMonths.length === 0 ? getDailyStoreStaffRange(periodStart, periodEnd) : [],
  }
}

export function getUserData() {
  // DA-5：JSON/localStorage 镜像不再作为业务数据源（读权威 = PostgreSQL）
  return cached || { entries: {}, staff: [], removedStaff: [], analysis: {}, productImages: {}, stores: [], schedules: {}, products: [], inventoryRequests: [], inventory: [], bigBonuses: [], dailyPayAdjustments: [], dailyStoreStaffByMonth: {}, posDaily: [], posProductSales: [] }
}

export function getEntries() {
  return getUserData().entries
}

export function getStaff() {
  return getUserData().staff
}

/**
 * 保存门店业绩（Data Authority DA-4：PostgreSQL 为唯一写权威）
 * 写序：先写 PG（单条 upsert + 乐观锁），全部成功后更新本地缓存并做 KV 镜像（best-effort）。
 * PG 失败 → 显式抛错（不静默回退、不写 KV 镜像，避免 KV 出现 PG 没有的数据）。
 */
export async function commitEntries(entries) {
  const prev = { ...(getUserData().entries || {}) }
  const changed = Object.keys(entries).filter((k) => JSON.stringify(entries[k]) !== JSON.stringify(prev[k]))
  const removed = Object.keys(prev).filter((k) => !(k in entries))
  const failures = []
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
      if (res && res.row) entries[k] = { ...v, status: res.row.status, v2version: res.row.version }
    } catch (err) {
      if (err.status === 409 && err.data && err.data.latest) {
        // 版本冲突：以 PG 最新值为准
        entries[k] = {
          inc: Number(err.data.latest.incCents) / 100,
          ord: err.data.latest.ord,
          staff: Array.isArray(err.data.latest.staffNames) ? err.data.latest.staffNames : [],
          status: err.data.latest.status,
          v2version: err.data.latest.version,
        }
        console.warn('业绩版本冲突，已加载最新数据')
      } else {
        failures.push(k)
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
      failures.push(k)
    }
  }
  if (failures.length > 0) {
    // 显式失败：PostgreSQL 权威写入未全部成功，不更新缓存、不写 KV 镜像
    throw new Error(`业绩保存失败（PostgreSQL 不可用），未保存 ${failures.length} 条，请稍后重试`)
  }
  // 权威写全部成功 → 仅更新本地缓存（DA-5：不再写 KV 镜像，KV 为只读存档）
  getUserData().entries = entries
}

export async function commitStaff(staff) {
  // Data Authority DA-2.2：员工名单权威 = PG employees（先写）；KV staff / PG Staff 为镜像（后写，best-effort）
  const snapshot = Array.isArray(staff) ? staff : []
  try {
    await api('/v2/staff-list', { method: 'PUT', body: JSON.stringify({ staff: snapshot }) })
  } catch (e) {
    throw new Error(`员工名单保存失败（PostgreSQL 不可用）：${e.message}`)
  }
  getUserData().staff = staff
  // DA-5：KV staff 镜像写已退役（KV 为只读存档）；PG Staff 为日值班派生表镜像（保留，供 staffId 引用）
  try {
    await api('/v2/staff', { method: 'PUT', body: JSON.stringify({ staff: snapshot }) })
  } catch {
    /* 派生表镜像失败不影响员工名单权威 */
  }
}

/**
 * Gate 7：按 Employee.id 定向离职（不做全量名单替换）。
 * 走既有员工档案端点 POST /v2/employees/:id/status-change（RESIGN），
 * 只影响该员工，绝不因同名误伤其他员工；成功后在本地缓存中移除该条目。
 * 历史业绩/工资条等按姓名快照的数据不受影响。
 */
export async function resignEmployeeById(employeeId) {
  const id = String(employeeId || '').trim()
  if (!id) throw new Error('员工 ID 不正确')
  try {
    await api(`/v2/employees/${encodeURIComponent(id)}/status-change`, {
      method: 'POST',
      body: JSON.stringify({ action: 'RESIGN', resignReason: '人员管理删除' }),
    })
  } catch (e) {
    throw new Error(`员工离职操作失败：${e.message}`)
  }
  getUserData().staff = (getUserData().staff || []).filter((e) => String(e.id || '') !== id)
  notifyUserDataUpdated()
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

export function getStores() {
  return Array.isArray(getUserData().stores) ? getUserData().stores : []
}

export function commitStores(stores) {
  // DA-5：门店目录权威 = PG；本函数仅更新本地缓存
  getUserData().stores = stores
}

export function getProducts() {
  const p = getUserData().products
  return Array.isArray(p) ? p : []
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
}

export function upsertDailyPayAdjustment(row) {
  const rows = getDailyPayAdjustments().filter((item) => item.id !== row.id)
  replaceDailyPayAdjustments([...rows, row])
}

export function removeDailyPayAdjustment(id) {
  replaceDailyPayAdjustments(getDailyPayAdjustments().filter((row) => row.id !== id))
}

export function getInventory() {
  const rows = getUserData().inventory
  return Array.isArray(rows) ? rows : []
}

export function commitRemovedStaff(removedStaff) {
  // DA-5：removedStaff 仅为前端过滤缓存（删除权威 = PG employees.status）；不再写 KV
  getUserData().removedStaff = removedStaff
}

export function resetUserData() {
  invalidateMonthlyAttendanceCache()
  cached = null
  activeUserId = ''
}

/** 测试专用：注入内存缓存（DA-5 后 localStorage 镜像播种已移除，仅集成测试使用） */
export function seedCachedDataForTest(data) {
  invalidateMonthlyAttendanceCache()
  cached = normalizeCachedData(data)
  for (const [month, rows] of Object.entries(cached.dailyStoreStaffByMonth || {})) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Array.isArray(rows)) {
      staffMonthStates.set(month, {
        month,
        status: STAFF_MONTH_LOAD_STATE.LOADED,
        generation: userDataGeneration,
        userId: activeUserId,
        error: null,
      })
    }
  }
  return cached
}
