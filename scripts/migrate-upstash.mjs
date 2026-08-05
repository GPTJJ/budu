// 把本地 server/data/db.json 的账号与业务数据迁移到 Upstash Redis（Vercel 部署用）。
// 用法（先设置环境变量，再运行）：
//   $env:UPSTASH_REDIS_REST_URL='https://xxx.upstash.io'
//   $env:UPSTASH_REDIS_REST_TOKEN='xxx'
//   node scripts/migrate-upstash.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_FILE = path.join(ROOT, 'server', 'data', 'db.json')
const REDIS_KEY = 'budu-db'
const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '')
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || ''

if (!url || !token) {
  console.error('缺少环境变量（KV_REST_API_URL / KV_REST_API_TOKEN 或 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）')
  process.exit(1)
}
if (!fs.existsSync(DB_FILE)) {
  console.error('未找到 ' + DB_FILE)
  process.exit(1)
}

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
const res = await fetch(`${url}/set/${REDIS_KEY}/${encodeURIComponent(JSON.stringify(db))}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
})
if (!res.ok) throw new Error(`迁移失败（HTTP ${res.status}）`)
const out = await res.json()
console.log('✅ 迁移完成:', JSON.stringify(out))
console.log(`   用户 ${db.users.length} 个 | 业绩录入 ${Object.keys(db.entries || {}).length} 条 | 员工 ${(db.staff || []).length} 人`)