// 只读备份脚本：把 Upstash KV 全量数据导出为本地 JSON 快照。
// 优先使用 KV_REST_API_READ_ONLY_TOKEN，保证不写入生产数据；不打印任何密钥值。
// 用法：node scripts/backup-kv.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const envPath = path.join(root, '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v
  }
}

const REDIS_KEY = 'budu-db'
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const token =
  process.env.KV_REST_API_READ_ONLY_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN

if (!url || !token) {
  console.error('未找到 KV 配置（.env.local 中需有 KV_REST_API_URL / KV_REST_API_TOKEN）')
  process.exit(1)
}

const res = await fetch(`${String(url).replace(/\/$/, '')}/get/${REDIS_KEY}`, {
  headers: { Authorization: `Bearer ${token}` },
})
if (!res.ok) throw new Error(`Upstash 读取失败（HTTP ${res.status}）`)
const data = await res.json()
const db = data && data.result ? JSON.parse(data.result) : null

const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14)
const dir = path.join(root, 'backups')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `kv-snapshot-${stamp}.json`)
fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8')

const entries = (db && db.entries) || {}
console.log('快照已保存：', file)
console.log('----------------------------------------')
console.log('用户数：', (db && db.users ? db.users.length : 0))
console.log('员工数：', (db && db.staff ? db.staff.length : 0))
console.log('业绩录入 key 数：', Object.keys(entries).length)
console.log('门店数：', (db && db.stores ? db.stores.length : 0))
console.log('报表月份：', (db && db.analysis && db.analysis.months ? db.analysis.months.length : 0))
console.log('商品图片数：', (db && db.productImages ? Object.keys(db.productImages).length : 0))
console.log('----------------------------------------')
console.log('注意：快照含 meta.secret（JWT 密钥），请勿提交 git、勿外传；建议上传到 COS 私有桶。')
