// KV(Upstash/本地 JSON) → PostgreSQL 迁移脚本（幂等，支持 --dry-run / --reconcile）
// 用法：DATABASE_URL=... node scripts/migrate-kv-to-pg.mjs [--dry-run] [--reconcile]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const envPath = path.join(root, '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!(m[1] in process.env)) process.env[m[1]] = v
  }
}

const dryRun = process.argv.includes('--dry-run')
const reconcile = process.argv.includes('--reconcile')

if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL')
  process.exit(1)
}

const prisma = new PrismaClient()
const REDIS_KEY = 'budu-db'

async function loadKv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token =
    process.env.KV_REST_API_READ_ONLY_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    const res = await fetch(`${String(url).replace(/\/$/, '')}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`KV 读取失败 HTTP ${res.status}`)
    const data = await res.json()
    return data && data.result ? JSON.parse(data.result) : { users: [], stores: [], staff: [], entries: {}, inventoryRequests: [], inventory: [], products: [] }
  }
  const local = path.join(root, 'server/data/db.json')
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'))
  throw new Error('未找到 KV 配置或本地 db.json')
}

const id = (prefix, s) => `${prefix}-${String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
const iso = (s) => (s ? new Date(s) : new Date())

async function main() {
  const kv = await loadKv()
  const counts = { stores: 0, users: 0, staff: 0, entries: 0, items: 0, transfers: 0, purchases: 0, inventory: 0 }

  if (!dryRun) {
    // 门店
    for (const s of kv.stores || []) {
      await prisma.store.upsert({ where: { key: s.key }, update: { name: s.name, district: s.district || '' }, create: { key: s.key, name: s.name, district: s.district || '' } })
      counts.stores += 1
    }
    // 用户
    for (const u of kv.users || []) {
      await prisma.user.upsert({ where: { id: u.id }, update: { username: u.username, role: u.role, avatar: u.avatar || '' }, create: { id: u.id, username: u.username, passwordHash: u.passwordHash, role: u.role, avatar: u.avatar || '', createdAt: iso(u.createdAt) } })
      counts.users += 1
    }
    // 员工
    for (const s of kv.staff || []) {
      const sid = id('st', `${s.storeKey}-${s.name}`)
      await prisma.store.upsert({ where: { key: s.storeKey }, update: {}, create: { key: s.storeKey, name: s.storeKey } })
      await prisma.staff.upsert({ where: { id: sid }, update: { name: s.name, type: s.type || 'fulltime', salary: Number(s.salary) || 0 }, create: { id: sid, name: s.name, type: s.type || 'fulltime', storeKey: s.storeKey, salary: Number(s.salary) || 0 } })
      counts.staff += 1
    }
    // 业绩
    for (const [key, v] of Object.entries(kv.entries || {})) {
      const [month, storeKey, day] = key.split('|')
      if (!month || !storeKey || !day) continue
      const eid = id('de', `${month}-${storeKey}-${day}`)
      await prisma.store.upsert({ where: { key: storeKey }, update: {}, create: { key: storeKey, name: storeKey } })
      await prisma.dailyEntry.upsert({
        where: { id: eid },
        update: { incCents: BigInt(Math.round((Number(v.inc) || 0) * 100)), ord: Number(v.ord) || 0, staffNames: Array.isArray(v.staff) ? v.staff : [] },
        create: { id: eid, storeKey, date: new Date(`${month}-${day.slice(3)}T00:00:00.000Z`), incCents: BigInt(Math.round((Number(v.inc) || 0) * 100)), ord: Number(v.ord) || 0, staffNames: Array.isArray(v.staff) ? v.staff : [] },
      })
      counts.entries += 1
    }
    // 货品
    const itemNames = new Set()
    for (const p of kv.products || []) itemNames.add(p.name)
    for (const r of kv.inventoryRequests || []) for (const it of r.items || []) itemNames.add(it.productName)
    for (const row of kv.inventory || []) itemNames.add(row.productName)
    for (const name of itemNames) {
      await prisma.inventoryItem.upsert({ where: { name }, update: {}, create: { id: id('it', name), name } })
      counts.items += 1
    }
    // 申请单
    for (const r of kv.inventoryRequests || []) {
      const exists = await prisma.transferRequest.findUnique({ where: { id: r.id } })
      if (!exists && r.type === 'transfer') {
        await prisma.store.upsert({ where: { key: r.fromStoreKey }, update: {}, create: { key: r.fromStoreKey, name: r.fromStoreKey } })
        await prisma.store.upsert({ where: { key: r.storeKey }, update: {}, create: { key: r.storeKey, name: r.storeKey } })
        const created = await prisma.transferRequest.create({
          data: {
            id: r.id,
            fromStoreKey: r.fromStoreKey,
            toStoreKey: r.storeKey,
            status: r.status === 'received' ? 'completed' : r.status === 'shipped' ? 'in_transit' : r.status || 'pending',
            note: r.note || '',
            createdBy: r.createdBy || '',
            createdAt: iso(r.createdAt),
            updatedAt: iso(r.updatedAt || r.createdAt),
          },
        })
        for (const it of r.items || []) {
          const item = await prisma.inventoryItem.upsert({ where: { name: it.productName }, update: {}, create: { id: id('it', it.productName), name: it.productName } })
          await prisma.transferItem.create({ data: { id: id('ti', `${r.id}-${it.productName}`), requestId: created.id, itemId: item.id, quantity: Number(it.quantity) || 0, note: it.note || '' } })
        }
        counts.transfers += 1
      } else if (!exists && r.type === 'purchase') {
        await prisma.store.upsert({ where: { key: r.storeKey }, update: {}, create: { key: r.storeKey, name: r.storeKey } })
        const created = await prisma.purchaseRequest.create({
          data: {
            id: r.id,
            storeKey: r.storeKey,
            status: r.status === 'done' ? 'received' : 'pending',
            note: r.note || '',
            createdBy: r.createdBy || '',
            createdAt: iso(r.createdAt),
            updatedAt: iso(r.updatedAt || r.createdAt),
          },
        })
        for (const it of r.items || []) {
          const item = await prisma.inventoryItem.upsert({ where: { name: it.productName }, update: {}, create: { id: id('it', it.productName), name: it.productName } })
          await prisma.purchaseItem.create({ data: { id: id('pi', `${r.id}-${it.productName}`), requestId: created.id, itemId: item.id, orderedQty: Number(it.quantity) || 0, note: it.note || '' } })
        }
        counts.purchases += 1
      }
    }
    // 库存余额（临时 KV 台账）
    for (const row of kv.inventory || []) {
      const item = await prisma.inventoryItem.upsert({ where: { name: row.productName }, update: {}, create: { id: id('it', row.productName), name: row.productName } })
      await prisma.store.upsert({ where: { key: row.storeKey }, update: {}, create: { key: row.storeKey, name: row.storeKey } })
      await prisma.stockBalance.upsert({
        where: { storeKey_itemId: { storeKey: row.storeKey, itemId: item.id } },
        update: { quantity: Math.round(Number(row.quantity) || 0) },
        create: { id: id('sb', `${row.storeKey}-${row.productName}`), storeKey: row.storeKey, itemId: item.id, quantity: Math.round(Number(row.quantity) || 0) },
      })
      counts.inventory += 1
    }
  }

  console.log(dryRun ? '[DRY-RUN] 将要迁移：' : '[OK] 已迁移：', JSON.stringify(counts))
  if (reconcile) {
    const pgEntries = await prisma.dailyEntry.count()
    const pgStaff = await prisma.staff.count()
    const kvEntries = Object.keys(kv.entries || {}).length
    const kvStaff = (kv.staff || []).length
    console.log('对账 entries: KV=', kvEntries, 'PG=', pgEntries, kvEntries === pgEntries ? '一致' : '不一致')
    console.log('对账 staff: KV=', kvStaff, 'PG=', pgStaff, kvStaff === pgStaff ? '一致' : '不一致')
  }
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('迁移失败：', e.message)
  await prisma.$disconnect()
  process.exit(1)
})
