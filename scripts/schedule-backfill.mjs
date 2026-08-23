#!/usr/bin/env node
/**
 * BUDU Data Authority 1.0 — DA-3 Schedule 回填脚本
 * 从 KV（db.json）schedules 迁移到 PostgreSQL schedules 表。
 * - 幂等：run once == run twice（按 (weekStart, storeKey, date) 唯一键 upsert，不重复生成）
 * - dry-run：--dry-run 只统计不写入
 * - 输出：CREATE / UPDATE / SKIP / CONFLICT / ERROR 计数
 * 用法：
 *   node scripts/schedule-backfill.mjs --db /app/server/data/db.json --dry-run
 *   DATABASE_URL=... node scripts/schedule-backfill.mjs --db /app/server/data/db.json
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const args = process.argv.slice(2)
const dbFile = args[args.indexOf('--db') + 1] || 'server/data/db.json'
const dryRun = args.includes('--dry-run')

if (!process.env.DATABASE_URL && !dryRun) {
  console.error('缺少 DATABASE_URL（dry-run 模式不需要）')
  process.exit(1)
}

const prisma = new PrismaClient()
const kv = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
const schedules = kv.schedules && typeof kv.schedules === 'object' ? kv.schedules : {}

const counters = { CREATE: 0, UPDATE: 0, SKIP: 0, CONFLICT: 0, ERROR: 0 }
const errors = []

async function run() {
  for (const [weekStart, stores] of Object.entries(schedules)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) { counters.CONFLICT++; errors.push(`weekStart 格式异常：${weekStart}`); continue }
    if (!stores || typeof stores !== 'object') { counters.CONFLICT++; errors.push(`周 ${weekStart} 数据格式异常`); continue }
    for (const [storeKey, days] of Object.entries(stores)) {
      if (!days || typeof days !== 'object') { counters.CONFLICT++; errors.push(`周 ${weekStart} 门店 ${storeKey} 数据格式异常`); continue }
      for (const [date, shifts] of Object.entries(days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { counters.CONFLICT++; errors.push(`日期格式异常：${date}`); continue }
        const list = Array.isArray(shifts) ? shifts.map((s) => ({
          staff: String((s && s.staff) || '').slice(0, 30),
          time: String((s && s.time) || '').slice(0, 20),
          note: String((s && s.note) || '').slice(0, 100),
        })).filter((s) => s.staff) : []
        const key = { weekStart, storeKey, date }
        try {
          const existing = await prisma.schedule.findUnique({ where: { weekStart_storeKey_date: key } })
          if (!dryRun) {
            if (existing) {
              const same = JSON.stringify(existing.shifts) === JSON.stringify(list)
              if (same) counters.SKIP++
              else {
                await prisma.schedule.update({ where: { weekStart_storeKey_date: key }, data: { shifts: list } })
                counters.UPDATE++
              }
            } else {
              await prisma.schedule.create({
                data: { id: `sc-${crypto.randomUUID()}`, ...key, shifts: list },
              })
              counters.CREATE++
            }
          } else if (existing) {
            counters.SKIP++
          } else {
            counters.CREATE++
          }
        } catch (e) {
          counters.ERROR++
          errors.push(`${weekStart}/${storeKey}/${date}: ${e.message.slice(0, 120)}`)
        }
      }
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', counters, errorCount: errors.length }))
  if (errors.length) {
    console.error('ERRORS:\n' + errors.slice(0, 10).join('\n'))
    process.exitCode = 2
  }
  await prisma.$disconnect()
}

run().catch((e) => { console.error(e); process.exit(1) })
