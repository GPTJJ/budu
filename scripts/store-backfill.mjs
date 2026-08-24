#!/usr/bin/env node
/**
 * BUDU Data Authority 1.0 — DA-2.3 Store 目录回填脚本
 * 从 KV（db.json）stores + 静态 BASE_STORES 迁移到 PostgreSQL Store 表（幂等 upsert）。
 * - dry-run：--dry-run 只统计不写入
 * - 输出：CREATE / UPDATE / SKIP / CONFLICT / ERROR
 * 用法：
 *   DATABASE_URL=... node scripts/store-backfill.mjs --db /app/server/data/db.json --dry-run
 */
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { FIXED_STORES, isFixedStoreKey } from '../shared/storeDirectory.js'

const args = process.argv.slice(2)
const dbFile = args[args.indexOf('--db') + 1] || 'server/data/db.json'
const dryRun = args.includes('--dry-run')

if (!process.env.DATABASE_URL && !dryRun) {
  console.error('缺少 DATABASE_URL（dry-run 模式不需要）')
  process.exit(1)
}

const prisma = new PrismaClient()
const kv = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
const sources = [
  ...(Array.isArray(kv.stores) ? kv.stores : [])
    .filter((store) => isFixedStoreKey(store.key))
    .map((s) => ({ key: s.key, name: s.name, district: s.district || '' })),
  ...FIXED_STORES,
]
const merged = new Map()
for (const s of sources) if (s.key && s.name) merged.set(s.key, s)

const counters = { CREATE: 0, UPDATE: 0, SKIP: 0, RETIRE: 0, CONFLICT: 0, ERROR: 0 }
const errors = []

async function run() {
  for (const [key, s] of merged.entries()) {
    try {
      const existing = await prisma.store.findUnique({ where: { key } })
      if (!dryRun) {
        if (existing) {
          const same = existing.name === s.name && (existing.district || '') === s.district
          if (same && existing.active !== false) counters.SKIP++
          else { await prisma.store.update({ where: { key }, data: { name: s.name, district: s.district, active: true } }); counters.UPDATE++ }
        } else {
          await prisma.store.create({ data: { key, name: s.name, district: s.district } })
          counters.CREATE++
        }
      } else if (existing) {
        counters.SKIP++
      } else {
        counters.CREATE++
      }
    } catch (e) {
      // 名称唯一冲突（同 name 不同 key）
      if (e && e.code === 'P2002') { counters.CONFLICT++; errors.push(`${key}(${s.name}): 名称冲突`) }
      else { counters.ERROR++; errors.push(`${key}: ${e.message.slice(0, 120)}`) }
    }
  }
  // 权威集合之外的门店 → 退役（active=false，可逆；不硬删被引用数据）
  if (!dryRun) {
    const all = await prisma.store.findMany({ where: { active: true } })
    for (const row of all) {
      if (!merged.has(row.key)) {
        await prisma.store.update({ where: { key: row.key }, data: { active: false } })
        counters.RETIRE++
      }
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', sources: merged.size, counters, errorCount: errors.length }))
  if (errors.length) {
    console.error('ERRORS:\n' + errors.slice(0, 10).join('\n'))
    process.exitCode = 2
  }
  await prisma.$disconnect()
}

run().catch((e) => { console.error(e); process.exit(1) })
