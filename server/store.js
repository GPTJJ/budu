import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * 数据存储适配层：
 * - 设置了 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 时使用 Upstash Redis（Vercel Serverless 场景）
 * - 否则使用本地 JSON 文件（本地开发 / 自建服务器场景）
 * 存储结构：{ meta: { secret }, users: [], entries: {}, staff: [] }
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')
const REDIS_KEY = 'budu-db'

const DEFAULT_DB = { meta: {}, users: [], entries: {}, staff: [], removedStaff: [] }

let cached = null

function redisConfig() {
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
  // 账号权限迁移：至少保留一个最高权限账号，缺省时由最早注册的账号担任
  if (db.users.length > 0 && !db.users.some((u) => u.role === 'owner')) {
    const first = [...db.users].sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
    )[0]
    first.role = 'owner'
  }
  if (!db.entries || typeof db.entries !== 'object' || Array.isArray(db.entries)) db.entries = {}
  if (!Array.isArray(db.staff)) db.staff = []
  if (!Array.isArray(db.removedStaff)) db.removedStaff = []
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
