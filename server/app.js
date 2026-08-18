import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadDb, persist } from './store.js'
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js'
import { parseAnalysis } from './analysis.js'
import { v2Router } from './v2.js'
import { productsRouter } from './products.js'
import { posRouter } from './pos.js'
import { payrollNoticeRouter } from './payroll-notice.js'
import { approvalRouter, ensureApprovalTemplates } from './approvals.js'
import { dailyEntryUpgradeRouter } from './daily-entry-upgrade.js'
import { assetCenterRouter } from './asset-center.js'
import { paymentCallbackRouter } from './payment-callbacks.js'
import { normalizeItemCategory } from './productCategories.js'
import { prisma, dbReady } from './pg.js'
import { resolveStoreName } from './store-names.js'
import { startAssetReminderJob } from './asset-reminders.js'
import { APP_ENV, APP_VERSION, GIT_SHA } from './config.js'
import * as Sentry from '@sentry/node'
import {
  canManageTransferStore,
  hasInventoryTransferAll,
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
      console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ${requestId}`)
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
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      storeKeys: Array.isArray(u.storeKeys) ? u.storeKeys : [],
      staffKey: u.staffKey || '',
      permissions: normalizeAccountPermissions(u.permissions),
      assetCenter: u.role === 'developer' || Boolean(u.assetCenter),
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
    const user = (await loadDb()).users.find((u) => u.id === payload.sub)
    if (!user) return res.status(401).json({ error: '账号不存在' })
    req.user = user
    next()
  }

  function requireDeveloper(req, res, next) {
    // 财务角色权限与开发者一致
    if (!req.user || (req.user.role !== 'developer' && req.user.role !== 'finance')) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
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

  const ROLES = ['developer', 'manager', 'staff', 'cashier', 'public', 'finance']

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

  function boundStores(user) {
    return Array.isArray(user && user.storeKeys) ? user.storeKeys : []
  }

  function canManageStore(user, storeKey) {
    if (!user || user.role === 'public') return false
    if (user.role === 'developer' || user.role === 'finance') return true
    return boundStores(user).includes(storeKey)
  }

  function requireManager(req, res, next) {
    if (!req.user || !['developer', 'manager', 'finance'].includes(req.user.role)) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  function requireTransferManager(req, res, next) {
    if (!req.user || (!['developer', 'manager', 'finance'].includes(req.user.role) && !hasInventoryTransferAll(req.user))) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }

  function scopeInventoryRequests(bodyRequests, dbRequests, user) {
    if (user.role === 'developer' || user.role === 'finance') return true
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
    if (!user || user.role === 'developer' || user.role === 'finance' || user.role === 'public') {
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
    // 绑定员工的店员：只能看到本人档案
    if (user.role === 'staff' && user.staffKey) {
      staff = staff.filter((s) => `${s.storeKey}::${s.name}` === user.staffKey)
    } else if (user.role === 'staff') {
      staff = []
    }
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

  function normalizeStoreKeys(raw) {
    if (raw === undefined || raw === null) return null
    if (!Array.isArray(raw) || raw.length > 50) return null
    const seen = new Set()
    const out = []
    for (const k of raw) {
      const key = String(k || '').trim()
      if (!key || key.length > 30 || seen.has(key)) return null
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
  app.use('/api/payments', paymentCallbackRouter)
  // v2 路由组：POS 对门店收银开放；其余业务接口（业绩/库存/发票/资产/商品中心等）对收银隐藏
  app.use('/api/v2', requireAuth)
  app.use('/api/v2', posRouter)
  app.use('/api/v2', requireBusiness, payrollNoticeRouter, productsRouter, dailyEntryUpgradeRouter, assetCenterRouter, approvalRouter, v2Router)

  // ---------- 注册（第一个用户自动成为管理员） ----------
  app.post('/api/auth/register', async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需为 2-20 个字符' })
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })
    const db = await loadDb()
    // 自助注册已关闭：仅当系统还没有任何账号时允许注册（首个开发者引导）
    if (db.users.length > 0) {
      return res.status(403).json({ error: '注册已关闭，新账号请联系开发者创建' })
    }
    if (db.users.some((u) => u.username === username)) return res.status(409).json({ error: '用户名已存在' })
    const user = {
      id: crypto.randomUUID(),
      username,
      role: db.users.length === 0 ? 'developer' : 'store',
      storeKeys: [],
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    db.users.push(user)
    await persist()
    setAuthCookie(res, signToken(user, await getSecret()))
    res.json({ user: userPublic(user) })
  })

  // ---------- 创建账号（仅开发者） ----------
  app.post('/api/admin/users', requireAuth, requireDeveloper, async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    const role = String(req.body.role || 'staff')
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
    const db = await loadDb()
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
    if (db.users.some((u) => u.username === username)) {
      return res.status(409).json({ error: '用户名已存在' })
    }
    const user = {
      id: crypto.randomUUID(),
      username,
      role,
      storeKeys,
      staffKey,
      permissions: normalizeAccountPermissions(),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    db.users.push(user)
    await persist()
    res.json({ user: userPublic(user) })
  })

  // ---------- 登录 ----------
  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim()
    const password = String(req.body.password || '')
    const user = (await loadDb()).users.find((u) => u.username === username)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: '用户名或密码错误' })
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
      req.user.passwordHash = hashPassword(newPassword)
      await persist()
      return res.json({ ok: true })
    }
    const db = await loadDb()
    if (body.username !== undefined) {
      const username = String(body.username || '').trim()
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: '用户名需为 2-20 个字符' })
      }
      if (db.users.some((u) => u.id !== req.user.id && u.username === username)) {
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
    await persist()
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
    req.user.secondPasswordHash = hashPassword(newSecondPassword)
    await persist()
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
    const db = await loadDb()
    if (body.username !== undefined) {
      const username = String(body.username || '').trim()
      if (username.length < 2 || username.length > 20) {
        return res.status(400).json({ error: '用户名需为 2-20 个字符' })
      }
      if (db.users.some((u) => u.id !== req.user.id && u.username === username)) {
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
    await persist()
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
    req.user.passwordHash = hashPassword(newPassword)
    await persist()
    res.json({ ok: true })
  })

  // ---------- 账号管理（最高权限） ----------
  app.get('/api/admin/users', requireAuth, requireDeveloper, async (req, res) => {
    const db = await loadDb()
    res.json({ users: db.users.map(userPublic) })
  })

  app.put('/api/admin/users/:id/role', requireAuth, requireDeveloper, async (req, res) => {
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
    const db = await loadDb()
    let staffKey = null
    if (req.body.staffKey !== undefined) {
      staffKey = normalizeStaffKey(req.body.staffKey)
      if (staffKey === null) return res.status(400).json({ error: 'staffKey 格式错误' })
    }
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.id === req.user.id) {
      return res.status(400).json({ error: '不能修改自己的权限' })
    }
    const developerCount = db.users.filter((u) => u.role === 'developer').length
    if (target.role === 'developer' && role !== 'developer' && developerCount <= 1) {
      return res.status(400).json({ error: '至少保留一个最高权限账号' })
    }
    // 收银角色约束（按变更后的角色 + 生效的门店/员工绑定校验）
    const effStoreKeys = storeKeys !== null ? storeKeys : Array.isArray(target.storeKeys) ? target.storeKeys : []
    const effStaffKey = staffKey !== null ? staffKey : target.staffKey || ''
    const cashierError = validateCashierRole(role, effStoreKeys, effStaffKey)
    if (cashierError) {
      return res.status(400).json({ error: cashierError })
    }
    target.role = role
    if (storeKeys !== null) target.storeKeys = storeKeys
    if (staffKey !== null) target.staffKey = staffKey
    await persist()
    res.json({ user: userPublic(target) })
  })

  app.put('/api/admin/users/:id/permissions', requireAuth, requireDeveloper, async (req, res) => {
    const db = await loadDb()
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    target.permissions = normalizeAccountPermissions(req.body)
    await persist()
    res.json({ user: userPublic(target) })
  })

  app.put('/api/admin/users/:id/password', requireAuth, requireDeveloper, async (req, res) => {
    const newPassword = String(req.body.newPassword || '')
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' })
    }
    const db = await loadDb()
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    target.passwordHash = hashPassword(newPassword)
    await persist()
    res.json({ ok: true })
  })

  app.delete('/api/admin/users/:id', requireAuth, requireDeveloper, async (req, res) => {
    const db = await loadDb()
    const target = db.users.find((u) => u.id === req.params.id)
    if (!target) return res.status(404).json({ error: '账号不存在' })
    if (target.id === req.user.id) {
      return res.status(400).json({ error: '不能删除自己' })
    }
    const developerCount = db.users.filter((u) => u.role === 'developer').length
    if (target.role === 'developer' && developerCount <= 1) {
      return res.status(400).json({ error: '至少保留一个最高权限账号' })
    }
    db.users = db.users.filter((u) => u.id !== target.id)
    await persist()
    res.json({ ok: true })
  })

  // ---------- 自定义门店（仅追加，门店运营/开发者可用；不能改名/删除） ----------
  app.post('/api/stores', requireAuth, requireDeveloper, async (req, res) => {
    const name = String(req.body.name || '').trim()
    const district =
      req.body.district === undefined || req.body.district === null
        ? ''
        : String(req.body.district).trim().slice(0, 50)
    if (!name || name.length > 30) {
      return res.status(400).json({ error: '门店名称需为 1-30 个字符' })
    }
    const db = await loadDb()
    const stores = Array.isArray(db.stores) ? db.stores : []
    if (stores.some((s) => s.name === name)) {
      return res.status(409).json({ error: '该门店已存在' })
    }
    const store = { key: `store-${Date.now().toString(36)}`, name, district }
    db.stores = [...stores, store]
    await persist()
    res.json({ store })
  })

  // ---------- 调货状态机：发货（调出门店 manager） / 确认收货（调入门店 manager） ----------
  app.post('/api/inventory/requests/:id/ship', requireAuth, requireTransferManager, async (req, res) => {
    const db = await loadDb()
    const r = (db.inventoryRequests || []).find((x) => x.id === req.params.id)
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.type !== 'transfer') return res.status(400).json({ error: '仅调货申请可发货' })
    if (r.status !== 'pending') return res.status(400).json({ error: '当前状态不可发货' })
    if (!canManageTransferStore(req.user, r.fromStoreKey)) return res.status(403).json({ error: '无权限' })
    const at = new Date().toISOString()
    r.status = 'in_transit'
    r.updatedAt = at
    r.history = [
      ...(Array.isArray(r.history) ? r.history : []),
      { action: '审核通过并确认发货', status: 'in_transit', operator: req.user.username, at, note: '' },
    ]
    await persist()
    res.json({ ok: true, request: r })
  })

  app.post('/api/inventory/requests/:id/receive', requireAuth, requireTransferManager, async (req, res) => {
    const db = await loadDb()
    const r = (db.inventoryRequests || []).find((x) => x.id === req.params.id)
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.type !== 'transfer') return res.status(400).json({ error: '仅调货申请可确认收货' })
    if (r.status !== 'in_transit') return res.status(400).json({ error: '当前状态不可收货' })
    if (!canManageTransferStore(req.user, r.storeKey)) return res.status(403).json({ error: '无权限' })
    const at = new Date().toISOString()
    r.status = 'completed'
    r.updatedAt = at
    r.history = [
      ...(Array.isArray(r.history) ? r.history : []),
      { action: '确认收货', status: 'completed', operator: req.user.username, at, note: '' },
    ]
    await persist()
    res.json({ ok: true, request: r })
  })

  app.post('/api/inventory/requests/:id/reject', requireAuth, requireTransferManager, async (req, res) => {
    const db = await loadDb()
    const r = (db.inventoryRequests || []).find((x) => x.id === req.params.id)
    if (!r) return res.status(404).json({ error: '申请不存在' })
    if (r.type !== 'transfer') return res.status(400).json({ error: '仅调货申请可驳回' })
    if (r.status !== 'pending') return res.status(400).json({ error: '当前状态不可驳回' })
    if (!canManageTransferStore(req.user, r.fromStoreKey)) return res.status(403).json({ error: '无权限' })
    const at = new Date().toISOString()
    r.status = 'rejected'
    r.updatedAt = at
    r.history = [
      ...(Array.isArray(r.history) ? r.history : []),
      {
        action: '驳回申请',
        status: 'rejected',
        operator: req.user.username,
        at,
        note: String(req.body.note || '').trim().slice(0, 100),
      },
    ]
    await persist()
    res.json({ ok: true, request: r })
  })

  // ---------- 共享数据：读取（业绩录入 + 员工名单，全团队共享） ----------
  app.get('/api/userdata', requireAuth, async (req, res) => {
    const db = await loadDb()
    res.json(scopeUserData(db, req.user))
  })

  // ---------- 共享数据：整体保存 ----------
  app.put('/api/userdata', requireAuth, async (req, res) => {
    const body = req.body || {}
    const db = await loadDb()
    if (req.user.role === 'public' || req.user.role === 'cashier') {
      return res.status(403).json({ error: '无权限' })
    }
    const allowed = new Set(boundStores(req.user))
    const isDeveloper = req.user.role === 'developer' || req.user.role === 'finance'
    const isManager = req.user.role === 'manager'

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
      if (removedChanged && req.user.role !== 'developer' && req.user.role !== 'finance') {
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
      if (storesChanged && req.user.role !== 'developer' && req.user.role !== 'finance') {
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
    res.json({ ok: true, ...scopeUserData(db, req.user) })
  })

  // ---------- 数据分析：上传报表并解析 ----------
  app.post('/api/analysis/upload', requireAuth, requireManager, async (req, res) => {
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

  app.delete('/api/analysis', requireAuth, requireManager, async (req, res) => {
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
      res.setHeader('Cache-Control', 'no-cache')
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
      const rows = await prisma.store.findMany()
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

  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app)
  }

  return app
}
