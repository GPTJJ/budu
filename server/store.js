import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { normalizeAccountPermissions } from '../shared/accountPermissions.js'

/**
 * 数据存储适配层：
 * - 设置了 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 时使用 Upstash Redis（Vercel Serverless 场景）
 * - 否则使用本地 JSON 文件（本地开发 / 自建服务器场景）
 * 存储结构：{ meta: { secret }, users: [], entries: {}, staff: [] }
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')
const REDIS_KEY = 'budu-db'

const DEFAULT_DB = {
  meta: {},
  users: [],
  entries: {},
  staff: [],
  removedStaff: [],
  analysis: {},
  productImages: {},
  stores: [],
  schedules: {},
  products: [],
  inventoryRequests: [],
  inventory: [],
}

let cached = null

function redisConfig() {
  // 自建服务器可显式选择持久卷文件存储；避免同时存在历史 KV 变量时悄悄切换数据源。
  if (String(process.env.DATA_STORE || '').trim().toLowerCase() === 'file') return null
  // 兼容两套变量名：Vercel KV 标准命名（KV_REST_API_*）与 Upstash 原生命名（UPSTASH_REDIS_REST_*）
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  return url && token ? { url: String(url).replace(/\/$/, ''), token } : null
}

async function redisGet() {
  const cfg = redisConfig()
  if (!cfg) return null
  const res = await fetch(`${cfg.url}/get/${REDIS_KEY}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  })
  if (!res.ok) throw new Error(`Upstash 读取失败（HTTP ${res.status}）`)
  const data = await res.json()
  const raw = data && data.result
  return raw ? JSON.parse(raw) : null
}

async function redisSet(db) {
  const cfg = redisConfig()
  if (!cfg) return
  const res = await fetch(`${cfg.url}/set/${REDIS_KEY}/${encodeURIComponent(JSON.stringify(db))}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}` },
  })
  if (!res.ok) throw new Error(`Upstash 写入失败（HTTP ${res.status}）`)
}

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeLocal(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DB_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
  fs.renameSync(tmp, DB_FILE)
}

/** 读取数据库（带进程内缓存；首次读取时自动补全结构并生成 JWT 密钥） */
export async function loadDb() {
  if (cached) return cached
  let db = redisConfig() ? await redisGet() : readLocal()
  if (!db) db = structuredClone(DEFAULT_DB)
  if (!db.meta || typeof db.meta !== 'object') db.meta = {}
  if (!Array.isArray(db.users)) db.users = []
  // 角色迁移：owner/member/store -> developer/staff/manager；旧 store 账号升级为 manager
  // 注意：admin 已是正式角色（管理员，与开发者同权），不参与迁移
  for (const u of db.users) {
    if (u.role === 'owner') u.role = 'developer'
    else if (u.role === 'store') u.role = 'manager'
    else if (u.role === 'member') u.role = 'staff'
    if (!Array.isArray(u.storeKeys)) u.storeKeys = []
    if (!u.staffKey) u.staffKey = ''
    if (!u.secondPasswordHash) u.secondPasswordHash = ''
    if (u.role === 'public') {
      u.status = 'disabled'
      if (!u.disabledAt) u.disabledAt = new Date().toISOString()
    } else if (!u.status) {
      u.status = 'active'
    }
    const bindingComplete =
      !['manager', 'staff'].includes(u.role) ||
      (u.storeKeys.length > 0 && Boolean(u.staffKey))
    if (u.bindingLegacyExempt === undefined) u.bindingLegacyExempt = !bindingComplete
    if (bindingComplete) u.bindingLegacyExempt = false
    u.permissions = normalizeAccountPermissions(u.permissions, u.role, u.assetCenter === true)
  }
  // 至少保留一个开发者（最高权限）账号，缺省时由最早注册的账号担任
  if (db.users.length > 0 && !db.users.some((u) => u.role === 'developer')) {
    const first = [...db.users].sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
    )[0]
    first.role = 'developer'
  }
  if (!db.entries || typeof db.entries !== 'object' || Array.isArray(db.entries)) db.entries = {}
  if (!Array.isArray(db.staff)) db.staff = []
  if (!Array.isArray(db.removedStaff)) db.removedStaff = []
  if (!db.analysis || typeof db.analysis !== 'object' || Array.isArray(db.analysis)) db.analysis = {}
  if (!db.productImages || typeof db.productImages !== 'object' || Array.isArray(db.productImages)) {
    db.productImages = {}
  }
  if (!Array.isArray(db.stores)) db.stores = []
  if (!db.schedules || typeof db.schedules !== 'object' || Array.isArray(db.schedules)) db.schedules = {}
  if (!Array.isArray(db.products)) db.products = []
  if (!Array.isArray(db.inventoryRequests)) db.inventoryRequests = []
  for (const request of db.inventoryRequests) {
    if (request?.type === 'transfer' && request.status === 'done') request.status = 'completed'
  }
  if (!Array.isArray(db.inventory)) db.inventory = []
  if (!db.meta.secret && !process.env.JWT_SECRET) {
    db.meta.secret = crypto.randomBytes(32).toString('hex')
  }
  cached = db
  if (!process.env.JWT_SECRET && db.meta.secret) {
    // 本地文件模式持久化密钥；Redis 模式下密钥以 meta.secret 存在数据里
    await persist()
  }
  return db
}

export function getDb() {
  return cached || null
}

/** 写回数据库（Redis 模式异步写云端；本地模式写 JSON 文件） */
export async function persist() {
  if (!cached) return
  if (redisConfig()) {
    await redisSet(cached)
  } else {
    writeLocal(cached)
  }
}

/** 清空内存缓存（测试用） */
export function resetCache() {
  cached = null
}
