// 只读脚本：加载 .env.local 后直接从 Upstash 读取共享数据（不打印密钥）
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

const { loadDb } = await import('../server/store.js')
const db = await loadDb()
const entries = db.entries || {}

console.log('stores:', JSON.stringify(db.stores || []))
console.log('staff:', JSON.stringify((db.staff || []).map((s) => ({ name: s.name, storeKey: s.storeKey }))))
for (const [k, v] of Object.entries(entries).sort()) {
  if (k.startsWith('2026-08|')) console.log(k, JSON.stringify(v))
}
