#!/usr/bin/env node
/**
 * BUDU Data Authority 1.0 — DA-2.3 Store 目录回填脚本
 * 仅补建缺失的原四家门店；已有 PostgreSQL 资料及启停状态保持原样。
 * KV、缓存和本脚本均不能覆盖当前门店，也不能停用新建门店。
 * - dry-run：--dry-run 只统计不写入
 * - 输出：CREATE / SKIP / CONFLICT / ERROR
 * 用法：
 *   DATABASE_URL=... node scripts/store-backfill.mjs --dry-run
 */
import { PrismaClient } from '@prisma/client'
import { FIXED_STORES } from '../shared/storeDirectory.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

if (!process.env.DATABASE_URL && !dryRun) {
  console.error('缺少 DATABASE_URL（dry-run 模式不需要）')
  process.exit(1)
}

const prisma = new PrismaClient()
const sources = FIXED_STORES
const merged = new Map()
for (const s of sources) if (s.key && s.name) merged.set(s.key, s)

const counters = { CREATE: 0, SKIP: 0, CONFLICT: 0, ERROR: 0 }
const errors = []

async function run() {
  for (const [key, s] of merged.entries()) {
    try {
      const existing = await prisma.store.findUnique({ where: { key } })
      if (!dryRun) {
        if (existing) {
          counters.SKIP++
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
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', sources: merged.size, counters, errorCount: errors.length }))
  if (errors.length) {
    console.error('ERRORS:\n' + errors.slice(0, 10).join('\n'))
    process.exitCode = 2
  }
  await prisma.$disconnect()
}

run().catch((e) => { console.error(e); process.exit(1) })
