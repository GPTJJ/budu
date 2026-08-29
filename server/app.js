import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadDb, persist } from './store.js'
import { getUserById, getUserByUsername, listUsers, createUser, updateUser, deleteUser } from './user-store.js'
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js'
import { parseAnalysis } from './analysis.js'
import { v2Router } from './v2.js'
import { partnerSupplyRouter } from './partner-supply.js'
import { productsRouter } from './products.js'
import { posRouter } from './pos.js'
import { scheduleRouter } from './schedule.js'
import { payrollNoticeRouter } from './payroll-notice.js'
import { approvalRouter, ensureApprovalTemplates } from './approvals.js'
import { notificationRouter } from './notifications.js'
import { customerRequestRouter, publicCustomerRequestRouter } from './customer-requests.js'
import { redactCustomerRequestUrl } from './customer-request-core.js'
import { wechatBindCallbackRouter, wechatBindRouter, wechatRecvRouter } from './wechat-bind.js'
import { ensureNotificationTemplates } from './notification-center.js'
import { dailyEntryUpgradeRouter } from './daily-entry-upgrade.js'
import { employeeProfileRouter } from './employee-profile.js'
import { assetCenterRouter } from './asset-center.js'
import { paymentCallbackRouter } from './payment-callbacks.js'
import { normalizeItemCategory } from './productCategories.js'
import { prisma, dbReady } from './pg.js'
import { resolveStoreName } from './store-names.js'
import { FIXED_STORE_KEYS, isFixedStoreKey } from '../shared/storeDirectory.js'
import { startAssetReminderJob } from './asset-reminders.js'
import { APP_ENV, APP_VERSION, GIT_SHA } from './config.js'
import * as Sentry from '@sentry/node'
import {
  ACTIVE_ROLES,
  MODULE_KEYS,
  canManageTransferStore,
  hasAnyModuleAccess,
  hasModuleAccess,
  hasInventoryTransferAll,
  isSuperUser,
  normalizeAccountPermissions,
} from '../shared/accountPermissions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const COOKIE = 'budu_token'
const COOKIE_MAX_AGE = 30 * 24 * 3600 * 1000

/** 校验并规范化排班数据结构：schedules[周一起始日期][门店key][日期] = [{staff, time?, note?}] */
function normalizeSchedules(raw) {
  const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const BAD_KEY = /^(__proto__|constructor|prototype)$/
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const out = {}
  const weeks = Object.entries(raw)
  if (weeks.length > 520) return null
  for (const [weekStart, stores] of weeks) {
    if (BAD_KEY.test(weekStart) || !WEEK_RE.test(weekStart)) return null
    if (!stores || typeof stores !== 'object' || Array.isArray(stores)) return null

    const storeOut = {}
    const storeEntries = Object.entries(stores)
    if (storeEntries.length > 200) return null
    for (const [storeKey, days] of storeEntries) {
      if (BAD_KEY.test(storeKey) || !storeKey.trim() || storeKey.length > 30) return null
      if (!days || typeof days !== 'object' || Array.isArray(days)) return null

      const daysOut = {}
      const dayEntries = Object.entries(days)
      if (dayEntries.length > 7) return null
      for (const [date, shifts] of dayEntries) {
        if (BAD_KEY.test(date) || !DATE_RE.test(date)) return null
        if (!Array.isArray(shifts) || shifts.length > 50) return null

        const shiftsOut = []
        for (const s of shifts) {
          if (!s || typeof s !== 'object' || Array.isArray(s)) return null
          const staff = String(s.staff ?? '').trim()
          const time = s.time === undefined || s.time === null ? '' : String(s.time).trim().slice(0, 30)
          const note = s.note === undefined || s.note === null ? '' : String(s.note).trim().slice(0, 100)
          if (!staff || staff.length > 30) return null
          const item = { staff }
          if (time) item.time = time
          if (note) item.note = note
          shiftsOut.push(item)
        }
        daysOut[date] = shiftsOut
      }
      storeOut[storeKey] = daysOut
    }
    out[weekStart] = storeOut
  }
  return out
}

/** 校验并规范化自定义商品：{ id?, name, storeKey, price?, note?, createdAt?, updatedAt? } */
function normalizeProducts(raw) {
  if (!Array.isArray(raw) || raw.length > 500) return null
  const out = []
  for (const p of raw) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    const name = String(p.name ?? '').trim()
    const storeKey = String(p.storeKey ?? '').trim()
    const note = p.note === undefined || p.note === null ? '' : String(p.note).trim().slice(0, 100)
    if (!name || name.length > 30) return null
    if (!storeKey || storeKey.length > 30 || /^(__proto__|constructor|prototype)$/.test(storeKey)) return null
    let price = 0
    if (p.price !== undefined && p.price !== null && p.price !== '') {
      price = Number(p.price)
      if (!Number.isFinite(price) || price < 0 || price > 999999) return null
    }
    out.push({
      id: typeof p.id === 'string' && p.id ? p.id.slice(0, 64) : crypto.randomUUID(),
      name,
      storeKey,
      price,
      note,
      createdAt: typeof p.createdAt === 'string' && p.createdAt ? p.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }
  return out
}

/** 校验并规范化库存申请：{ type, storeKey, fromStoreKey?, productName, quantity, note?, status?, createdBy, createdAt? } */
function normalizeInventoryRequests(raw) {
  if (!Array.isArray(raw) || raw.length > 500) return null
  const BAD_KEY = /^(__proto__|constructor|prototype)$/
  const out = []
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null
    const type = String(r.type || '')
    if (!['transfer', 'purchase'].includes(type)) return null
    const storeKey = String(r.storeKey ?? '').trim()
    const fromStoreKey = type === 'transfer' ? String(r.fromStoreKey ?? '').trim() : ''
    const storeName = r.storeName === undefined || r.storeName === null ? '' : String(r.storeName).trim().slice(0, 30)
    const fromStoreName =
      type === 'transfer'
        ? r.fromStoreName === undefined || r.fromStoreName === null
          ? ''
          : String(r.fromStoreName).trim().slice(0, 30)
        : ''
    const note = r.note === undefined || r.note === null ? '' : String(r.note).trim().slice(0, 100)
    if (!storeKey || storeKey.length > 30 || BAD_KEY.test(storeKey)) return null
    if (type === 'transfer' && (!fromStoreKey || fromStoreKey.length > 30 || BAD_KEY.test(fromStoreKey) || fromStoreKey === storeKey)) {
      return null
    }

    // 货品明细：优先 items 多行结构，兼容旧的单行 productName/quantity
    let items = null
    if (Array.isArray(r.items) && r.items.length > 0) {
      if (r.items.length > 50) return null
      items = []
      for (const it of r.items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return null
        const name = String(it.productName ?? '').trim()
        const qty = Number(it.quantity)
        const itNote = it.note === undefined || it.note === null ? '' : String(it.note).trim().slice(0, 100)
        if (!name || name.length > 50) return null
        if (!Number.isFinite(qty) || qty < 1 || qty > 99999) return null
        const category = normalizeItemCategory(name, it.category)
        const item = { category, productName: name, quantity: Math.floor(qty) }
        if (itNote) item.note = itNote
        items.push(item)
      }
    } else {
      const name = String(r.productName ?? '').trim()
      const qty = Number(r.quantity)
      if (!name || name.length > 50) return null
      if (!Number.isFinite(qty) || qty < 1 || qty > 99999) return null
      items = [{ category: normalizeItemCategory(name, 'product'), productName: name, quantity: Math.floor(qty) }]
    }
    const first = items[0]
    const allowedStatuses = type === 'transfer'
      ? new Set(['pending', 'in_transit', 'completed', 'rejected'])
      : new Set(['pending', 'done'])
    // 兼容 M1 早期状态命名
    const legacyMap = { shipped: 'in_transit', received: 'completed', done: 'completed' }
    const rawStatus = legacyMap[r.status] || String(r.status || 'pending')
    const status = allowedStatuses.has(rawStatus) ? rawStatus : 'pending'
    const history = []
    if (Array.isArray(r.history)) {
      if (r.history.length > 20) return null
      for (const event of r.history) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return null
        history.push({
          action: String(event.action || '').trim().slice(0, 40),
          status: String(event.status || '').trim().slice(0, 20),
          operator: String(event.operator || '').trim().slice(0, 30),
          at: String(event.at || '').slice(0, 40),
          note: String(event.note || '').trim().slice(0, 100),
        })
      }
    }
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : crypto.randomUUID(),
      type,
      storeKey,
      ...(type === 'transfer' ? { fromStoreKey } : {}),
      ...(storeName ? { storeName } : {}),
      ...(type === 'transfer' && fromStoreName ? { fromStoreName } : {}),
      items,
      productName: first.productName,
      quantity: first.quantity,
      note,
      status,
      createdBy: String(r.createdBy ?? '').trim().slice(0, 30) || 'unknown',
      createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString(),
      updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : '',
      history,
    })
  }
  return out
}

/** 库存台账：每个门店、每种货品仅一条非负数量记录（M2 迁 PG 前的临时 KV 实现）。 */
function normalizeInventory(raw) {
  if (!Array.isArray(raw) || raw.length > 10000) return null
  const BAD_KEY = /^(__proto__|constructor|prototype)$/
  const seen = new Set()
  const out = []
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const storeKey = String(row.storeKey || '').trim()
    const productName = String(row.productName || '').trim()
    const quantity = Number(row.quantity)
    if (!storeKey || storeKey.length > 30 || BAD_KEY.test(storeKey)) return null
    if (!productName || productName.length > 50 || BAD_KEY.test(productName)) return null
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 99999999) return null
    const key = `${storeKey}\n${productName}`
    if (seen.has(key)) return null
    seen.add(key)
    out.push({
      storeKey,
      productName,
      quantity: Math.round(quantity * 100) / 100,
      updatedAt: String(row.updatedAt || '').slice(0, 40),
      updatedBy: String(row.updatedBy || '').trim().slice(0, 30),
    })
  }
  return out
}

export function createApp() {
  const app = express()
  app.use(express.json({ limit: '15mb' }))
  app.use(cookieParser())
  // 请求级结构化日志（只记录方法/路径/状态/耗时/requestId，不记录 body）
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next()
    const start = Date.now()
    const requestId = crypto.randomUUID().slice(0, 8)
    res.setHeader('X-Request-Id', requestId)
    res.on('finish', () => {
      console.log(`[req] ${req.method} ${redactCustomerRequestUrl(req.originalUrl)} ${res.statusCode} ${Date.now() - start}ms ${requestId}`)
    })
    next()
  })
  // 所有 API 响应禁止缓存（登录态/业务数据是动态的，CDN 只缓存静态资源）
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  async function getSecret() {
    return process.env.JWT_SECRET || (await loadDb()).meta.secret
  }

  function userPublic(u) {
    const bindingComplete =
      !['manager', 'staff'].includes(u.role) ||
      ((u.storeKeys || []).length > 0 && Boolean(u.employeeId))
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName || '',
      role: u.role,
      storeKeys: Array.isArray(u.storeKeys) ? u.storeKeys : [],
      staffKey: u.staffKey || '',
      employeeId: u.employeeId || '',
      permissions: normalizeAccountPermissions(u.permissions, u.role, u.assetCenter === true),
      assetCenter: hasModuleAccess(u, MODULE_KEYS.ASSET_CENTER),
      status: u.status || (u.role === 'public' ? 'disabled' : 'active'),
      disabledAt: u.disabledAt || '',
      bindingComplete,
      bindingLegacyExempt: u.bindingLegacyExempt === true && !bindingComplete,
      operationalIdentityType: u.operationalIdentityType || 'STANDARD',
      permissionsUpdatedAt: u.permissionsUpdatedAt || '',
      permissionsUpdatedBy: u.permissionsUpdatedBy || '',
      avatar: u.avatar || '',
      createdAt: u.createdAt,
    }
  }

  function setAuthCookie(res, token) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: process.env.COOKIE_SECURE === '1',
    })
  }

  async function requireAuth(req, res, next) {
    const token = req.cookies[COOKIE]
    const payload = token ? verifyToken(token, await getSecret()) : null
    if (!payload || !payload.sub) return res.status(401).json({ error: '未登录或登录已过期' })
    // Data Authority DA-2：账号权威 = PostgreSQL
    const user = await getUserById(payload.sub)
    if (!user) return res.status(401).json({ error: '账号不存在' })
    if (user.status === 'disabled' || user.role === 'public') return res.status(403).json({ error: '账号已停用，请联系开发者' })
    req.user = user
    next()
  }

  function requireDeveloper(req, res, next) {
    // 财务角色权限与开发者一致
    if (!req.user || (req.user.role !== 'developer' && req.user.role !== 'finance' && req.user.role !== 'admin')) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  function requireAccountAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'developer') return res.status(403).json({ error: '仅开发者可管理账号与授权' })
    next()
  }

  function requireModule(moduleKey) {
    return (req, res, next) => {
      if (!hasModuleAccess(req.user, moduleKey)) return res.status(403).json({ error: '该功能尚未授权' })
      next()
    }
  }

  function requireAnyModule(moduleKeys) {
    return (req, res, next) => {
      if (!hasAnyModuleAccess(req.user, moduleKeys)) return res.status(403).json({ error: '该功能尚未授权' })
      next()
    }
  }

  function requireOperational(req, res, next) {
    if (!req.user || req.user.role === 'public') {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  /** 业务接口（业绩/库存/发票/资产/商品中心等）：门店收银仅 POS 点单，一律拒绝 */
  function requireBusiness(req, res, next) {
    if (!req.user || req.user.role === 'cashier') {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  const ROLES = [...ACTIVE_ROLES]

  /** 收银角色约束：仅绑定一家门店、不绑定员工 */
  function validateCashierRole(role, storeKeys, staffKey) {
    if (role !== 'cashier') return null
    if (!Array.isArray(storeKeys) || storeKeys.length !== 1 || !storeKeys[0]) {
      return '收银账号必须绑定且仅绑定一家门店'
    }
    if (staffKey) {
      return '收银账号不绑定员工'
    }
    return null
  }

  // Data Authority DA-2.2/2.4：绑定校验权威 = PG employees；返回 { error } 或 { employeeId, staffKeySnapshot }
  // Gate 20：显式 Employee.id 优先（staffKey 快照由 canonical Employee 推导，忽略 client 传入值防矛盾）；
  // legacy staffKey 路径 fail closed（0/1/>1 匹配）。
  async function validateBoundRole(role, storeKeys, staffKey, explicitEmployeeId = '') {
    if (!['manager', 'staff'].includes(role)) return null
    if (!Array.isArray(storeKeys) || storeKeys.length < 1) return `${role === 'manager' ? '店长' : '员工'}账号必须绑定至少一家门店`
    try {
      const { prisma } = await import('./pg.js')
      const explicitId = String(explicitEmployeeId || '').trim()
      if (explicitId) {
        // Gate 20：显式 Employee.id 为权威——绝不按姓名/门店重建/替换；
        // staffKey 兼容快照必须由 canonical Employee（currentStoreKey + name）推导，
        // client 传入的 staffKey 一律忽略，防止 employeeId 与快照互相矛盾。
        const emp = await prisma.employee.findUnique({
          where: { id: explicitId },
          select: { id: true, name: true, currentStoreKey: true },
        })
        if (!emp) return '员工不存在'
        if (!storeKeys.includes(emp.currentStoreKey)) return '绑定员工必须属于账号已绑定门店'
        return {
          employeeId: explicitId,
          staffKeySnapshot: `${emp.currentStoreKey}::${emp.name}`,
        }
      }
      // legacy 路径（无显式 id）：staffKey 既是解析输入也是门店归属校验；fail closed 0/1/>1
      if (!staffKey) return `${role === 'manager' ? '店长' : '员工'}账号必须绑定员工`
      const [staffStoreKey, staffName] = String(staffKey).split('::')
      if (!staffStoreKey || !staffName || !storeKeys.includes(staffStoreKey)) return '绑定员工必须属于账号已绑定门店'
      const matches = await prisma.employee.findMany({
        where: { name: staffName, currentStoreKey: staffStoreKey, status: { not: 'RESIGNED' } },
        select: { id: true, name: true, currentStoreKey: true },
      })
      if (matches.length === 0) return '绑定员工不存在或已离职'
      if (matches.length > 1) return '存在多个同名员工，无法确定绑定，请通过员工选择器指定'
      return {
        employeeId: matches[0].id,
        staffKeySnapshot: `${matches[0].currentStoreKey}::${matches[0].name}`,
      }
    } catch {
      return '绑定员工校验失败，请稍后重试'
    }
  }

  function boundStores(user) {
    return Array.isArray(user && user.storeKeys) ? user.storeKeys : []
  }

  function canManageStore(user, storeKey) {
    if (!user || user.role === 'public') return false
    if (user.role === 'developer' || user.role === 'finance' || user.role === 'admin') return true
    return boundStores(user).includes(storeKey)
  }

  function requireManager(req, res, next) {
    if (!req.user || !['developer', 'manager', 'finance', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  function requireTransferManager(req, res, next) {
    if (!req.user || (!['developer', 'manager', 'finance', 'admin'].includes(req.user.role) && !hasInventoryTransferAll(req.user))) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  function scopeInventoryRequests(bodyRequests, dbRequests, user) {
    if (user.role === 'developer' || user.role === 'finance' || user.role === 'admin') return true
    const allowed = new Set(boundStores(user))
    const inScope = (r) =>
      (r.type === 'transfer' && hasInventoryTransferAll(user)) ||
      allowed.has(r.storeKey) ||
      (r.type === 'transfer' && allowed.has(r.fromStoreKey))
    const dbArr = dbRequests || []
    const bodyArr = bodyRequests || []
    for (const r of dbArr.filter((x) => !inScope(x))) {
      const b = bodyArr.find((x) => x.id === r.id)
      if (!b || JSON.stringify(b) !== JSON.stringify(r)) return false
    }
    for (const r of dbArr.filter((x) => inScope(x))) {
      const b = bodyArr.find((x) => x.id === r.id)
      if (!b) {
        if (!(r.createdBy === user.username && r.status === 'pending')) return false
      } else if (JSON.stringify(b) !== JSON.stringify(r)) {
        return false
      }
    }
    for (const r of bodyArr) {
      if (!inScope(r)) return false
      const exists = dbArr.some((x) => x.id === r.id)
      if (!exists && !(r.createdBy === user.username && r.status === 'pending')) return false
    }
    return true
  }

  /** 按绑定门店过滤共享数据（developer/public 返回全量；cashier 仅返回 POS 所需最小集） */
  function scopeUserData(db, user) {
    // 门店收银：仅 POS 点单使用，只返回绑定门店与商品图片，其余全部隐藏
    if (user && user.role === 'cashier') {
      const allowed = new Set(boundStores(user))
      return {
        entries: {},
        staff: [],
        removedStaff: [],
        analysis: {},
        productImages: db.productImages || {},
        stores: (db.stores || []).filter((s) => allowed.has(s.key)),
        schedules: {},
        products: [],
        inventoryRequests: [],
        inventory: [],
      }
    }
    if (!user || user.role === 'developer' || user.role === 'finance' || user.role === 'admin' || user.role === 'public') {
      return {
        entries: db.entries || {},
        staff: db.staff || [],
        removedStaff: db.removedStaff || [],
        analysis: db.analysis || {},
        productImages: db.productImages || {},
        stores: db.stores || [],
        schedules: db.schedules || {},
        products: db.products || [],
        inventoryRequests: db.inventoryRequests || [],
        inventory: db.inventory || [],
      }
    }
    const allowed = new Set(boundStores(user))
    const entries = {}
    for (const [k, v] of Object.entries(db.entries || {})) {
      const store = k.split('|')[1]
      if (allowed.has(store)) entries[k] = v
    }
    let staff = (db.staff || []).filter((s) => allowed.has(s.storeKey))
    // 员工目录权威已迁移到 PG /v2/staff-list；legacy userdata 不再按 staffKey/姓名猜测本人。
    if (user.role === 'staff') staff = []
    const schedules = {}
    for (const [wk, sm] of Object.entries(db.schedules || {})) {
      const o = {}
      for (const [k, v] of Object.entries(sm)) if (allowed.has(k)) o[k] = v
      if (Object.keys(o).length) schedules[wk] = o
    }
    const products = (db.products || []).filter((p) => allowed.has(p.storeKey))
    const inventoryRequests = (db.inventoryRequests || []).filter(
      (r) =>
        (r.type === 'transfer' && hasInventoryTransferAll(user)) ||
        allowed.has(r.storeKey) ||
        (r.type === 'transfer' && allowed.has(r.fromStoreKey)),
    )
    const stores = (db.stores || []).filter((s) => allowed.has(s.key))
    const inventory = (db.inventory || []).filter((row) => allowed.has(row.storeKey))
    let analysis = {}
    if (user.role === 'manager') {
      const src = db.analysis || {}
      const daily = {}
      for (const [m, sm] of Object.entries(src.daily || {})) {
        const o = {}
        for (const [k, v] of Object.entries(sm)) if (allowed.has(k)) o[k] = v
        if (Object.keys(o).length) daily[m] = o
      }
      const products2 = {}
      for (const [m, sm] of Object.entries(src.products || {})) {
        const o = {}
        for (const [k, v] of Object.entries(sm)) if (allowed.has(k)) o[k] = v
        if (Object.keys(o).length) products2[m] = o
      }
      const employeeMonthly = {}
      for (const [m, rows] of Object.entries(src.employeeMonthly || {})) {
        const f = (Array.isArray(rows) ? rows : []).filter((r) => allowed.has(r.storeKey))
        if (f.length) employeeMonthly[m] = f
      }
      analysis = { ...src, daily, products: products2, employeeMonthly }
    }
    return {
      entries,
      staff,
      removedStaff: db.removedStaff || [],
      analysis,
      productImages: db.productImages || {},
      stores,
      schedules,
      products,
      inventoryRequests,
      inventory,
    }
  }

  function filterUserDataByModules(data, user) {
    const allowed = (keys) => hasAnyModuleAccess(user, keys)
    return {
      entries: allowed([MODULE_KEYS.OVERVIEW, MODULE_KEYS.ANALYSIS, MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.STAFF_PAYROLL, MODULE_KEYS.FINANCE]) ? data.entries : {},
      staff: allowed([MODULE_KEYS.STAFF, MODULE_KEYS.STAFF_PAYROLL, MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.STORE_SCHEDULE]) ? data.staff : [],
      removedStaff: allowed([MODULE_KEYS.STAFF]) ? data.removedStaff : [],
      analysis: allowed([MODULE_KEYS.OVERVIEW, MODULE_KEYS.ANALYSIS, MODULE_KEYS.FINANCE]) ? data.analysis : {},
      productImages: allowed([MODULE_KEYS.PRODUCT_CENTER, MODULE_KEYS.STORE_POS]) ? data.productImages : {},
      stores: (data.stores || []).filter((store) => isFixedStoreKey(store.key)),
      schedules: allowed([MODULE_KEYS.STORE_SCHEDULE]) ? data.schedules : {},
      products: allowed([MODULE_KEYS.PRODUCT_CENTER]) ? data.products : [],
      inventoryRequests: allowed([MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE]) ? data.inventoryRequests : [],
      inventory: allowed([MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE]) ? data.inventory : [],
    }
  }

  function normalizeStoreKeys(raw) {
    if (raw === undefined || raw === null) return null
    if (!Array.isArray(raw) || raw.length > 50) return null
    const seen = new Set()
    const out = []
    for (const k of raw) {
      const key = String(k || '').trim()
      if (!isFixedStoreKey(key) || seen.has(key)) return null
      seen.add(key)
      out.push(key)
    }
    return out
  }

  function normalizeStaffKey(raw) {
    const key = String(raw || '').trim()
    if (!key) return ''
    if (key.length > 80 || !key.includes('::')) return null
    return key
  }

  app.get('/api/health', (req, res) => res.json({
    ok: true,
    time: Date.now(),
    env: APP_ENV,
    appVersion: APP_VERSION,
    gitSha: GIT_SHA || '',
    dbOk: dbReady(),
  }))
  // 顾客自助表单：公开但仅由高熵一次性 token 授权；固定路径避免 token 进入访问日志。
  app.use('/api/public', publicCustomerRequestRouter)
  app.use('/api/payments', paymentCallbackRouter)
  // 微信扫码绑定 OAuth 回调（公开：数据库一次性 state 防伪造/重放）
  app.use('/api/v2/wechat/bind/callback', wechatBindCallbackRouter)
  // 企业微信接收消息服务器验证（公开：企业微信服务器回调，无登录态）
  app.use('/api/v2/wechat/recv', wechatRecvRouter)
  // v2 路由组：POS 对门店收银开放；其余业务接口（业绩/库存/发票/资产/商品中心等）对收银隐藏
  app.use('/api/v2', requireAuth)
  app.use('/api/v2', (req, res, next) => {
    const pathname = req.path || ''
    const rule =
      (/^\/products(?:\/|$)/.test(pathname) && [MODULE_KEYS.PRODUCT_CENTER]) ||
      (/^\/product-groups(?:\/|$)/.test(pathname) && [MODULE_KEYS.PRODUCT_CENTER]) ||
      (/^\/pos\/(?:config|orders|products|payments)(?:\/|$)/.test(pathname) && [MODULE_KEYS.STORE_POS]) ||
      (/^\/pos\/(?:daily-summary|product-sales)(?:\/|$)/.test(pathname) && [MODULE_KEYS.OVERVIEW, MODULE_KEYS.ANALYSIS, MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.FINANCE]) ||
      (/^\/daily-entries(?:\/|$)/.test(pathname) && (req.method === 'GET'
        ? [MODULE_KEYS.OVERVIEW, MODULE_KEYS.ANALYSIS, MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.STAFF_PAYROLL, MODULE_KEYS.FINANCE]
        : [MODULE_KEYS.STORE_ENTRY])) ||
      (/^\/daily-entry\/overview(?:\/|$)/.test(pathname) && [MODULE_KEYS.OVERVIEW, MODULE_KEYS.ANALYSIS, MODULE_KEYS.STORE_ENTRY]) ||
      (/^\/daily-(?:entry|staff)(?:\/|$)/.test(pathname) && [MODULE_KEYS.STORE_ENTRY]) ||
      (/^\/schedules(?:\/|$)/.test(pathname) && [MODULE_KEYS.STORE_SCHEDULE]) ||
      (/^\/store-sales-source/.test(pathname) && [MODULE_KEYS.STORE_ENTRY, MODULE_KEYS.SETTINGS]) ||
      (/^\/transfer-requests(?:\/|$)/.test(pathname) && [MODULE_KEYS.INVENTORY_TRANSFER]) ||
      (/^\/transfer-master-items(?:\/|$)/.test(pathname) && [MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT, MODULE_KEYS.INVENTORY_TRANSFER]) ||
      (/^\/product-categories(?:\/|$)/.test(pathname) && [MODULE_KEYS.PRODUCT_CENTER, MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT, MODULE_KEYS.INVENTORY_TRANSFER]) ||
      (/^\/(?:partners|partner-supply|partner-receipts)(?:\/|$)/.test(pathname) && [MODULE_KEYS.PARTNER_SUPPLY]) ||
      (/^\/(?:purchase-requests|suppliers)(?:\/|$)/.test(pathname) && [MODULE_KEYS.INVENTORY_PURCHASE]) ||
      (/^\/(?:stock|items|waste-records)(?:\/|$)/.test(pathname) && [MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE]) ||
      (/^\/(?:expenses|profit|export\/profit)(?:\/|$)/.test(pathname) && [MODULE_KEYS.FINANCE]) ||
      (/^\/invoices(?:\/|$)/.test(pathname) && [MODULE_KEYS.FINANCE_INVOICE]) ||
      (/^\/mailing-records(?:\/|$)/.test(pathname) && [MODULE_KEYS.STORE_MAILING]) ||
      (/^\/payroll-notices(?:\/|$)/.test(pathname) && [MODULE_KEYS.STAFF_PAYROLL]) ||
      (/^\/approvals(?:\/|$)/.test(pathname) && [MODULE_KEYS.APPROVAL]) ||
      (/^\/asset-center(?:\/|$)/.test(pathname) && [MODULE_KEYS.ASSET_CENTER]) ||
      (/^\/wechat(?:\/|$)/.test(pathname) && [MODULE_KEYS.SETTINGS]) ||
      (/^\/(?:big-bonuses|daily-pay-adjustments)(?:\/|$)/.test(pathname) && [MODULE_KEYS.STAFF, MODULE_KEYS.STAFF_PAYROLL])
    if (!rule) return next()
    return requireAnyModule(rule)(req, res, next)
  })
  app.use('/api/v2', posRouter)
  app.use('/api/v2', requireBusiness, payrollNoticeRouter, productsRouter, scheduleRouter, dailyEntryUpgradeRouter, employeeProfileRouter, assetCenterRouter, approvalRouter, notificationRouter, customerRequestRouter, wechatBindRouter, partnerSupplyRouter, v2Router)

  // ---------- 注册（第一个用户自动成为管理员） ----------
  app.post('/api/auth/register', async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需为 2-20 个字符' })
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })
    // Data Authority DA-2：账号权威 = PostgreSQL
    const existing = await listUsers()
    // 自助注册已关闭：仅当系统还没有任何账号时允许注册（首个开发者引导）
    if (existing.length > 0) {
      return res.status(403).json({ error: '注册已关闭，新账号请联系开发者创建' })
    }
    if (existing.some((u) => u.username === username)) return res.status(409).json({ error: '用户名已存在' })
    const user = {
      id: crypto.randomUUID(),
      username,
      role: 'developer',
      storeKeys: [],
      staffKey: '',
      status: 'active',
      bindingLegacyExempt: false,
      operationalIdentityType: 'STANDARD',
      permissions: normalizeAccountPermissions(null, 'developer'),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    await createUser(user)
    setAuthCookie(res, signToken(user, await getSecret()))
    res.json({ user: userPublic(user) })
  })

  // ---------- 创建账号（仅开发者） ----------
  app.post('/api/admin/users', requireAuth, requireAccountAdmin, async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    const role = String(req.body.role || 'staff')
    const displayName = String(req.body.name || '').trim().slice(0, 20)
    if (username.length < 2 || username.length > 20) {
      return res.status(400).json({ error: '用户名需为 2-20 个字符' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' })
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: '角色不正确' })
    }
    const storeKeys = req.body.storeKeys === undefined ? [] : normalizeStoreKeys(req.body.storeKeys)
    if (storeKeys === null) {
      return res.status(400).json({ error: 'storeKeys 格式错误' })
    }
    let staffKey = ''
    if (req.body.staffKey !== undefined) {
      const sk = normalizeStaffKey(req.body.staffKey)
      if (sk === null) return res.status(400).json({ error: 'staffKey 格式错误' })
      staffKey = sk
    }
    // 收银角色约束：仅绑定一家门店、不绑定员工
    const cashierError = validateCashierRole(role, storeKeys, staffKey)
    if (cashierError) {
      return res.status(400).json({ error: cashierError })
    }
    const bindingResult = await validateBoundRole(role, storeKeys, staffKey, String(req.body.employeeId || '').trim())
    if (typeof bindingResult === 'string') return res.status(400).json({ error: bindingResult })
    // Data Authority DA-2：账号权威 = PostgreSQL
    const existing = await listUsers()
    if (existing.some((u) => u.username === username)) {
      return res.status(409).json({ error: '用户名已存在' })
    }
    // Gate 20：1 Employee ↔ 至多 1 User（无论 active/disabled——禁用账号不释放绑定）
    const boundEmpId = bindingResult ? bindingResult.employeeId : ''
    if (boundEmpId && existing.some((u) => u.employeeId === boundEmpId)) {
      return res.status(409).json({ error: '该员工已绑定账号' })
    }
    // Gate 20：显式/legacy 解析出的 canonical staffKey 快照（由 Employee 推导，忽略 client 矛盾值）
    const effStaffKey = bindingResult && bindingResult.staffKeySnapshot ? bindingResult.staffKeySnapshot : staffKey
    const user = {
      id: crypto.randomUUID(),
      username,
      displayName,
      role,
      storeKeys,
      staffKey: effStaffKey,
      employeeId: boundEmpId,
      status: 'active',
      bindingLegacyExempt: false,
      operationalIdentityType: 'STANDARD',
      permissions: normalizeAccountPermissions(req.body.permissions, role),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    await createUser(user)
    res.json({ user: userPublic(user) })
  })

  // ---------- 登录 ----------
  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    // Data Authority DA-2：账号权威 = PostgreSQL
    const user = await getUserByUsername(username)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }
    if (user.status === 'disabled' || user.role === 'public') {
      return res.status(403).json({ error: '账号已停用，请联系开发者' })
    }
    setAuthCookie(res, signToken(user, await getSecret()))
    res.json({ user: userPublic(user) })
  })

  // ---------- 退出 ----------
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE)
    res.json({ ok: true })
  })

  // ---------- 当前登录用户 ----------
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: userPublic(req.user) })
  })

  // ---------- 修改用户名 / 头像 / 密码（复用 /api/auth/me，兼容 Vercel 已有函数） ----------
  app.put('/api/auth/me', requireAuth, async (req, res) => {
    const body = req.body || {}
    if (body.oldPassword !== undefined || body.newPassword !== undefined) {
      const oldPassword = String(body.oldPassword || '')
      const newPassword = String(body.newPassword || '')
      if (!verifyPassword(oldPassword, req.user.passwordHash)) {
        return res.status(400).json({ error: '当前密码错误' })
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: '密码至少 6 位' })
      }
      await updateUser(req.user.id, { passwordHash: hashPassword(newPassword) })
      req.user.passwordHash = hashPassword(newPassword)
      return res.json({ ok: true })
    }
    if (body.username !== undefined) {
      const username = String(body.username || '').trim()
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: '用户名需为 2-20 个字符' })
      }
      const all = await listUsers()
      if (all.some((u) => u.id !== req.user.id && u.username === username)) {
        return res.status(409).json({ error: '用户名已存在' })
      }
      req.user.username = username
    }
    if (body.avatar !== undefined) {
      const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : ''
      if (avatar && !avatar.startsWith('data:image/')) {
        return res.status(400).json({ error: '头像格式错误' })
      }
      if (avatar.length > 500000) {
        return res.status(400).json({ error: '头像文件过大' })
      }
      req.user.avatar = avatar
    }
    await updateUser(req.user.id, { username: req.user.username, avatar: req.user.avatar })
    res.json({ user: userPublic(req.user) })
  })

  // ---------- 二级密码：用于删除雇员等高风险操作 ----------
  app.put('/api/auth/second-password', requireAuth, async (req, res) => {
    const body = req.body || {}
    const oldPassword = String(body.oldPassword || '')
    const newSecondPassword = String(body.newSecondPassword || '')
    if (!oldPassword || !verifyPassword(oldPassword, req.user.passwordHash)) {
      return res.status(400).json({ error: '当前登录密码错误' })
    }
    if (newSecondPassword.length < 6) {
      return res.status(400).json({ error: '二级密码至少 6 位' })
    }
    await updateUser(req.user.id, { secondPasswordHash: hashPassword(newSecondPassword) })
    req.user.secondPasswordHash = hashPassword(newSecondPassword)
    res.json({ ok: true })
  })

  app.post('/api/auth/verify-second-password', requireAuth, async (req, res) => {
    const body = req.body || {}
    const secondPassword = String(body.secondPassword || '')
    if (!req.user.secondPasswordHash) {
      return res.status(400).json({ error: '尚未设置二级密码，请先在系统设置中设置' })
    }
    if (!verifyPassword(secondPassword, req.user.secondPasswordHash)) {
      return res.status(401).json({ error: '二级密码不正确' })
    }
    res.json({ ok: true })
  })

  // ---------- 修改用户名 / 头像 ----------
  app.put('/api/auth/profile', requireAuth, async (req, res) => {
    const body = req.body || {}
    if (body.username !== undefined) {
      const username = String(body.username || '').trim()
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: '用户名需为 2-20 个字符' })
      }
      const all = await listUsers()
      if (all.some((u) => u.id !== req.user.id && u.username === username)) {
        return res.status(409).json({ error: '用户名已存在' })
      }
      req.user.username = username
    }
    if (body.avatar !== undefined) {
      const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : ''
      if (avatar && !avatar.startsWith('data:image/')) {
        return res.status(400).json({ error: '头像格式错误' })
      }
      if (avatar.length > 500000) {
        return res.status(400).json({ error: '头像文件过大' })
      }
      req.user.avatar = avatar
    }
    await updateUser(req.user.id, { username: req.user.username, avatar: req.user.avatar })
    res.json({ user: userPublic(req.user) })
  })

  // ---------- 修改密码 ----------
  app.put('/api/auth/password', requireAuth, async (req, res) => {
    const oldPassword = String(req.body.oldPassword || '')
    const newPassword = String(req.body.newPassword || '')
    if (!verifyPassword(oldPassword, req.user.passwordHash)) {
      return res.status(400).json({ error: '当前密码错误' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' })
    }
    await updateUser(req.user.id, { passwordHash: hashPassword(newPassword) })
    req.user.passwordHash = hashPassword(newPassword)
    res.json({ ok: true })
  })

  // ---------- 账号管理（最高权限） ----------
  app.get('/api/admin/users', requireAuth, requireAccountAdmin, async (req, res) => {
    const users = await listUsers()
    res.json({ users: users.map(userPublic) })
  })

  app.put('/api/admin/users/:id/role', requireAuth, requireAccountAdmin, async (req, res) => {
    const role = String(req.body.role || '')
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: '角色不正确' })
    }
    let storeKeys = null
    if (req.body.storeKeys !== undefined) {
      storeKeys = normalizeStoreKeys(req.body.storeKeys)
      if (storeKeys === null) {
        return res.status(400).json({ error: 'storeKeys 格式错误' })
      }
    }
    let staffKey = null
    if (req.body.staffKey !== undefined) {
      staffKey = normalizeStaffKey(req.body.staffKey)
      if (staffKey === null) return res.status(400).json({ error: 'staffKey 格式错误' })
    }
    // Data Authority DA-2：账号权威 = PostgreSQL
    const users = await listUsers()
    const target = users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.id === req.user.id) {
      return res.status(400).json({ error: '不能修改自己的权限' })
    }
    // 降级保护：若目标当前是超管且将变为非超管，需保证至少还剩一个超管
    const superRoles = ['developer', 'finance', 'admin']
    if (superRoles.includes(target.role) && !superRoles.includes(role)) {
      const superCount = users.filter((u) => superRoles.includes(u.role)).length
      if (superCount <= 1) {
        return res.status(400).json({ error: '至少保留一个最高权限账号' })
      }
    }
    // 收银角色约束（按变更后的角色 + 生效的门店/员工绑定校验）
    const effStoreKeys = storeKeys !== null ? storeKeys : Array.isArray(target.storeKeys) ? target.storeKeys : []
    const effStaffKey = staffKey !== null ? staffKey : target.staffKey || ''
    const cashierError = validateCashierRole(role, effStoreKeys, effStaffKey)
    if (cashierError) {
      return res.status(400).json({ error: cashierError })
    }
    const bindingResult = await validateBoundRole(role, effStoreKeys, effStaffKey, String(req.body.employeeId || '').trim())
    if (typeof bindingResult === 'string') return res.status(400).json({ error: bindingResult })
    // Gate 20：1 Employee ↔ 至多 1 User——排除当前编辑账号自身（自持绑定允许）
    const boundEmpId = bindingResult ? bindingResult.employeeId : ''
    if (boundEmpId) {
      const otherBound = users.some((u) => u.id !== target.id && u.employeeId === boundEmpId)
      if (otherBound) return res.status(409).json({ error: '该员工已绑定账号' })
    }
    const next = {
      role,
      status: 'active',
      disabledAt: null,
      bindingLegacyExempt: false,
      storeKeys: effStoreKeys,
      // Gate 20：canonical staffKey 快照（显式/legacy 解析由 Employee 推导；非绑定角色清空）
      staffKey: !['manager', 'staff'].includes(role) ? '' : (bindingResult && bindingResult.staffKeySnapshot ? bindingResult.staffKeySnapshot : effStaffKey),
      employeeId: boundEmpId,
      permissions: normalizeAccountPermissions(null, role, target.assetCenter === true),
    }
    next.assetCenter = next.permissions.modules[MODULE_KEYS.ASSET_CENTER] === true
    const updated = await updateUser(target.id, next)
    res.json({ user: userPublic(updated) })
  })

  app.put('/api/admin/users/:id/permissions', requireAuth, requireAccountAdmin, async (req, res) => {
    const users = await listUsers()
    const target = users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.role === 'developer') return res.status(400).json({ error: '开发者固定拥有全部权限' })
    if (target.role === 'cashier') return res.status(400).json({ error: '门店收银固定仅开放 POS' })
    const permissions = normalizeAccountPermissions(req.body, target.role, target.assetCenter === true)
    const updated = await updateUser(target.id, {
      permissions,
      assetCenter: permissions.modules[MODULE_KEYS.ASSET_CENTER] === true,
      permissionsUpdatedAt: new Date().toISOString(),
      permissionsUpdatedBy: req.user.username,
    })
    res.json({ user: userPublic(updated) })
  })

  app.put('/api/admin/users/:id/operational-identity', requireAuth, requireAccountAdmin, async (req, res) => {
    const operationalIdentityType = String(req.body?.operationalIdentityType || '').trim()
    if (!['STANDARD', 'NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE'].includes(operationalIdentityType)) {
      return res.status(400).json({ error: '运营身份类型不正确' })
    }
    const users = await listUsers()
    const target = users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (operationalIdentityType === 'NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE' && target.employeeId) {
      return res.status(409).json({ error: '已绑定员工的账号不能标记为非员工运营替代账号' })
    }
    if (operationalIdentityType === 'STANDARD') {
      const participationCount = await prisma.dailyStoreStaff.count({ where: { participantUserId: target.id } })
      if (participationCount > 0) {
        return res.status(409).json({ error: '该账号已有运营参与记录，不能直接取消替代身份' })
      }
    }
    const updated = await updateUser(target.id, { operationalIdentityType })
    res.json({ user: userPublic(updated) })
  })

  app.put('/api/admin/users/:id/name', requireAuth, requireAccountAdmin, async (req, res) => {
    const users = await listUsers()
    const target = users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    const displayName = String(req.body.name || '').trim().slice(0, 20)
    const updated = await updateUser(target.id, { displayName })
    res.json({ user: userPublic(updated) })
  })

  app.put('/api/admin/users/:id/password', requireAuth, requireAccountAdmin, async (req, res) => {
    const newPassword = String(req.body.newPassword || '')
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' })
    }
    const users = await listUsers()
    const target = users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    await updateUser(target.id, { passwordHash: hashPassword(newPassword) })
    res.json({ ok: true })
  })

  app.delete('/api/admin/users/:id', requireAuth, requireAccountAdmin, async (req, res) => {
    const users = await listUsers()
    const target = users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.id === req.user.id) {
      return res.status(400).json({ error: '不能删除自己' })
    }
    const superCount = users.filter((u) => ['developer', 'finance', 'admin'].includes(u.role)).length
    if (['developer', 'finance', 'admin'].includes(target.role) && superCount <= 1) {
      return res.status(400).json({ error: '至少保留一个最高权限账号' })
    }
    await deleteUser(target.id)
    res.json({ ok: true })
  })

  // ---------- 门店目录固定为四店；旧接口仅保留显式拒绝，防止旧前端重新写入 ----------
  app.post('/api/stores', requireAuth, requireModule(MODULE_KEYS.SETTINGS), requireDeveloper, async (req, res) => {
    res.status(403).json({ error: '门店目录固定为通盈、官舍、朝外、西单，禁止新增' })
  })

  // ---------- 共享数据：读取（业绩录入 + 员工名单，全团队共享） ----------
  app.get('/api/userdata', requireAuth, async (req, res) => {
    const db = await loadDb()
    res.json(filterUserDataByModules(scopeUserData(db, req.user), req.user))
  })

  // ---------- 共享数据：整体保存 ----------
  app.put('/api/userdata', requireAuth, async (req, res) => {
    const body = req.body || {}
    const db = await loadDb()
    if (req.user.role === 'public' || req.user.role === 'cashier') {
      return res.status(403).json({ error: '无权限' })
    }
    const allowed = new Set(boundStores(req.user))
    const isDeveloper = isSuperUser(req.user)
    const isManager = req.user.role === 'manager'
    const fieldRules = {
      entries: [MODULE_KEYS.STORE_ENTRY],
      staff: [MODULE_KEYS.STAFF],
      removedStaff: [MODULE_KEYS.STAFF],
      productImages: [MODULE_KEYS.PRODUCT_CENTER],
      stores: [MODULE_KEYS.SETTINGS],
      schedules: [MODULE_KEYS.STORE_SCHEDULE],
      products: [MODULE_KEYS.PRODUCT_CENTER],
      inventoryRequests: [MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE],
      inventory: [MODULE_KEYS.INVENTORY_TRANSFER, MODULE_KEYS.INVENTORY_PURCHASE],
    }
    for (const [field, modules] of Object.entries(fieldRules)) {
      if (body[field] !== undefined && !hasAnyModuleAccess(req.user, modules)) {
        return res.status(403).json({ error: '该功能尚未授权' })
      }
    }

    if (body.entries !== undefined) {
      if (typeof body.entries !== 'object' || Array.isArray(body.entries)) {
        return res.status(400).json({ error: 'entries 格式错误' })
      }
      if (isDeveloper) {
        db.entries = body.entries
      } else {
        for (const k of Object.keys(body.entries)) {
          if (!allowed.has(k.split('|')[1])) return res.status(403).json({ error: '无权限' })
        }
        const next = { ...(db.entries || {}) }
        for (const k of Object.keys(next)) {
          if (allowed.has(k.split('|')[1]) && !(k in body.entries)) delete next[k]
        }
        for (const [k, v] of Object.entries(body.entries)) next[k] = v
        db.entries = next
      }
    }
    if (body.staff !== undefined) {
      const staffChanged = JSON.stringify(body.staff) !== JSON.stringify(db.staff || [])
      if (staffChanged && req.user.role === 'staff') {
        return res.status(403).json({ error: '无权限' })
      }
      if (!Array.isArray(body.staff)) return res.status(400).json({ error: 'staff 格式错误' })
      if (isManager) {
        for (const s of body.staff) {
          if (!allowed.has(s && s.storeKey)) return res.status(403).json({ error: '无权限' })
        }
        const out = (db.staff || []).filter((s) => !allowed.has(s.storeKey))
        const inItems = body.staff.filter((s) => allowed.has(s.storeKey))
        db.staff = [...out, ...inItems]
      } else if (isDeveloper) {
        db.staff = body.staff
      }
    }
    if (body.removedStaff !== undefined) {
      const removedChanged = JSON.stringify(body.removedStaff) !== JSON.stringify(db.removedStaff || [])
      if (removedChanged && !isSuperUser(req.user)) {
        return res.status(403).json({ error: '无权限' })
      }
      if (!Array.isArray(body.removedStaff) || body.removedStaff.some((n) => typeof n !== 'string')) {
        return res.status(400).json({ error: 'removedStaff 格式错误' })
      }
      db.removedStaff = body.removedStaff
    }
    if (body.productImages !== undefined) {
      if (typeof body.productImages !== 'object' || Array.isArray(body.productImages)) {
        return res.status(400).json({ error: 'productImages 格式错误' })
      }
      for (const [key, value] of Object.entries(body.productImages)) {
        if (key.length > 100 || typeof value !== 'string' || (value && !value.startsWith('data:image/'))) {
          return res.status(400).json({ error: '商品图片格式错误' })
        }
        if (value.length > 500000) {
          return res.status(400).json({ error: '商品图片过大' })
        }
      }
      db.productImages = body.productImages
    }
    if (body.stores !== undefined) {
      const storesChanged = JSON.stringify(body.stores) !== JSON.stringify(db.stores || [])
      if (storesChanged && !isSuperUser(req.user)) {
        return res.status(403).json({ error: '无权限' })
      }
      if (!Array.isArray(body.stores)) {
        return res.status(400).json({ error: 'stores 格式错误' })
      }
      const seen = new Set()
      for (const s of body.stores) {
        const key = s && typeof s.key === 'string' ? s.key.trim() : ''
        const name = s && typeof s.name === 'string' ? s.name.trim() : ''
        if (!key || key.length > 30 || !name || name.length > 30 || seen.has(key)) {
          return res.status(400).json({ error: '门店格式错误' })
        }
        seen.add(key)
      }
      db.stores = body.stores.map((s) => ({
        key: String(s.key).trim(),
        name: String(s.name).trim(),
        district: s && typeof s.district === 'string' ? String(s.district).trim().slice(0, 50) : '',
      }))
    }
    if (body.schedules !== undefined) {
      const schedulesChanged = JSON.stringify(body.schedules) !== JSON.stringify(db.schedules || {})
      const normalized = normalizeSchedules(body.schedules)
      if (!normalized) {
        return res.status(400).json({ error: 'schedules 格式错误' })
      }
      if (isDeveloper) {
        db.schedules = normalized
      } else {
        const next = structuredClone(db.schedules || {})
        for (const [wk, sm] of Object.entries(normalized)) {
          for (const k of Object.keys(sm)) {
            if (!allowed.has(k)) return res.status(403).json({ error: '无权限' })
          }
        }
        for (const [wk, sm] of Object.entries(next)) {
          const bodyWk = normalized[wk]
          for (const k of Object.keys(sm)) {
            if (allowed.has(k)) {
              if (bodyWk && k in bodyWk) sm[k] = bodyWk[k]
              else delete sm[k]
            }
          }
          if (bodyWk) {
            for (const [k, v] of Object.entries(bodyWk)) sm[k] = v
          }
          if (Object.keys(sm).length === 0) delete next[wk]
        }
        // 全新周（db 中不存在）
        for (const [wk, sm] of Object.entries(normalized)) {
          if (!(wk in next)) {
            const o = {}
            for (const [k, v] of Object.entries(sm)) o[k] = v
            next[wk] = o
          }
        }
        db.schedules = next
      }
    }
    if (body.products !== undefined) {
      const productsChanged = JSON.stringify(body.products) !== JSON.stringify(db.products || [])
      if (productsChanged && req.user.role === 'staff') {
        return res.status(403).json({ error: '无权限' })
      }
      const normalized = normalizeProducts(body.products)
      if (!normalized) {
        return res.status(400).json({ error: 'products 格式错误' })
      }
      if (isDeveloper) {
        db.products = normalized
      } else if (isManager) {
        for (const p of normalized) {
          if (!allowed.has(p.storeKey)) return res.status(403).json({ error: '无权限' })
        }
        const out = (db.products || []).filter((p) => !allowed.has(p.storeKey))
        const inItems = normalized.filter((p) => allowed.has(p.storeKey))
        db.products = [...out, ...inItems]
      }
    }
    if (body.inventoryRequests !== undefined) {
      const requestsChanged = JSON.stringify(body.inventoryRequests) !== JSON.stringify(db.inventoryRequests || [])
      if (requestsChanged && !scopeInventoryRequests(body.inventoryRequests, db.inventoryRequests || [], req.user)) {
        return res.status(403).json({ error: '无权限' })
      }
      const normalized = normalizeInventoryRequests(body.inventoryRequests)
      if (!normalized) {
        return res.status(400).json({ error: 'inventoryRequests 格式错误' })
      }
      if (isDeveloper) {
        db.inventoryRequests = normalized
      } else {
        const inScope = (r) => allowed.has(r.storeKey) || (r.type === 'transfer' && allowed.has(r.fromStoreKey))
        const out = (db.inventoryRequests || []).filter((r) => !inScope(r))
        db.inventoryRequests = [...out, ...normalized.filter((r) => inScope(r))]
      }
    }
    if (body.inventory !== undefined) {
      const inventoryChanged = JSON.stringify(body.inventory) !== JSON.stringify(db.inventory || [])
      if (inventoryChanged && req.user.role === 'staff') {
        return res.status(403).json({ error: '无权限' })
      }
      const normalized = normalizeInventory(body.inventory)
      if (!normalized) return res.status(400).json({ error: 'inventory 格式错误' })
      if (isDeveloper) {
        db.inventory = normalized
      } else if (isManager) {
        for (const row of normalized) {
          if (!allowed.has(row.storeKey)) return res.status(403).json({ error: '无权限' })
        }
        const out = (db.inventory || []).filter((row) => !allowed.has(row.storeKey))
        const inItems = normalized.filter((row) => allowed.has(row.storeKey))
        db.inventory = [...out, ...inItems]
      }
    }
    await persist()
    res.json({ ok: true, ...filterUserDataByModules(scopeUserData(db, req.user), req.user) })
  })

  // ---------- 数据分析：上传报表并解析 ----------
  app.post('/api/analysis/upload', requireAuth, requireModule(MODULE_KEYS.ANALYSIS), requireManager, async (req, res) => {
    const body = req.body || {}
    const name = String(body.name || '')
    const raw = String(body.base64 || '').replace(/^data:[^;]+;base64,/, '')
    if (!raw) return res.status(400).json({ error: '请选择文件' })
    const buffer = Buffer.from(raw, 'base64')
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: '文件过大（最大 10MB）' })
    }
    const parsed = parseAnalysis(buffer, name)
    if (!parsed) {
      return res.status(400).json({ error: '未识别到可分析的报表数据' })
    }
    const db = await loadDb()
    const cur = db.analysis || {}
    const analysis = {
      ...cur,
      daily: { ...(cur.daily || {}), ...parsed.daily },
      products: { ...(cur.products || {}), ...parsed.products },
      employeeMonthly: { ...(cur.employeeMonthly || {}), ...parsed.employeeMonthly },
      employees: parsed.employees || cur.employees || [],
      months: [...new Set([...(cur.months || []), ...parsed.months])].sort(),
      sourceFiles: [...new Set([...(cur.sourceFiles || []), ...parsed.sourceFiles])],
      uploadedAt: new Date().toISOString(),
    }
    db.analysis = analysis
    await persist()
    const summary = {
      months: analysis.months,
      dailyRows: Object.values(analysis.daily || {}).reduce(
        (s, stores) => s + Object.values(stores).reduce((a, rows) => a + rows.length, 0),
        0,
      ),
      productCount: Object.values(analysis.products || {}).reduce(
        (s, stores) => s + Object.values(stores).reduce((a, list) => a + list.length, 0),
        0,
      ),
      employeeCount: (analysis.employees || []).length,
      sourceFiles: analysis.sourceFiles,
    }
    res.json({ ok: true, summary })
  })

  app.delete('/api/analysis', requireAuth, requireModule(MODULE_KEYS.ANALYSIS), requireManager, async (req, res) => {
    const db = await loadDb()
    db.analysis = {}
    await persist()
    res.json({ ok: true })
  })

  // ---------- 静态前端（仅本地/自建服务器模式使用；Vercel 由平台托管前端） ----------
  app.use(
    express.static(DIST, {
      index: false,
      setHeaders(res, filePath) {
        const rel = path.relative(DIST, filePath)
        // 带 hash 的构建产物可长期缓存；入口 HTML 每次重新校验，保证发版后及时更新
        if (rel.startsWith(`assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('Cache-Control', 'no-cache')
        }
      },
    }),
  )
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    const index = path.join(DIST, 'index.html')
    if (fs.existsSync(index)) {
      res.setHeader('Cache-Control', req.path === '/customer-request' ? 'no-store' : 'no-cache')
      return res.sendFile(index)
    }
    res.status(404).json({ error: '前端未构建，请先运行 npm run build' })
  })

  // 门店名称自愈：静态报表中文名 + KV 门店名回填 PG，避免订单/推送显示字母 key
  async function syncStoreNames() {
    if (!process.env.DATABASE_URL) return
    try {
      const db = await loadDb()
      const kvNames = new Map((Array.isArray(db.stores) ? db.stores : []).map((s) => [s.key, String(s.name || '')]))
      const rows = await prisma.store.findMany({ where: { key: { in: FIXED_STORE_KEYS } } })
      let updated = 0
      for (const row of rows) {
        const name = resolveStoreName(row.key, kvNames.get(row.key) || '')
        if (name && name !== row.name && name !== row.key) {
          await prisma.store.update({ where: { key: row.key }, data: { name } })
          updated += 1
        }
      }
      console.log(`[store-names-sync] 完成，更新 ${updated} 家门店名称`)
    } catch (error) {
      console.error('[store-names-sync]', error.message)
    }
  }
  syncStoreNames()
  startAssetReminderJob()
  // 审批模板种子（数据库未配置时跳过，下次启动自动补）
  ensureApprovalTemplates().catch((error) => console.error('[approval-templates]', error.message))
  ensureNotificationTemplates().catch((error) => console.error('[notification-templates]', error.message))

  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app)
  }

  return app
}
