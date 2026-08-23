#!/usr/bin/env node
/**
 * BUDU Data Authority 1.0 — DA-2 User/Account 回填脚本
 * 从 KV（db.json）users 迁移到 PostgreSQL User 表（以 KV user.id 为稳定主键）。
 * - 幂等：run once == run twice（按 id upsert）
 * - dry-run：--dry-run 只统计不写入
 * - 输出：CREATE / UPDATE / SKIP / CONFLICT / ERROR
 * 用法：
 *   DATABASE_URL=... node scripts/user-backfill.mjs --db /app/server/data/db.json --dry-run
 *   DATABASE_URL=... node scripts/user-backfill.mjs --db /app/server/data/db.json
 */
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { normalizeAccountPermissions } from '../shared/accountPermissions.js'

const args = process.argv.slice(2)
const dbFile = args[args.indexOf('--db') + 1] || 'server/data/db.json'
const dryRun = args.includes('--dry-run')

if (!process.env.DATABASE_URL && !dryRun) {
  console.error('缺少 DATABASE_URL（dry-run 模式不需要）')
  process.exit(1)
}

const prisma = new PrismaClient()
const kv = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
const users = Array.isArray(kv.users) ? kv.users : []

const counters = { CREATE: 0, UPDATE: 0, SKIP: 0, CONFLICT: 0, ERROR: 0 }
const errors = []

/** 规范化 JSON（键排序，忽略键序差异） */
function canon(v) {
  if (Array.isArray(v)) return JSON.stringify(v.map(canon))
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k])
    return JSON.stringify(out)
  }
  return JSON.stringify(v)
}

async function run() {
  for (const u of users) {
    const id = String(u.id || '')
    if (!id) { counters.CONFLICT++; errors.push('缺少 id 的账号被跳过'); continue }
    const username = String(u.username || '').trim()
    if (!username || username.length < 2) { counters.CONFLICT++; errors.push(`账号 ${id} 用户名无效`); continue }
    const data = {
      username,
      passwordHash: String(u.passwordHash || ''),
      role: String(u.role || 'staff'),
      displayName: String(u.displayName || ''),
      avatar: String(u.avatar || ''),
      storeKeys: Array.isArray(u.storeKeys) ? u.storeKeys : [],
      staffKey: String(u.staffKey || ''),
      status: String(u.status || 'active'),
      secondPasswordHash: String(u.secondPasswordHash || ''),
      bindingLegacyExempt: Boolean(u.bindingLegacyExempt),
      assetCenter: Boolean(u.assetCenter),
      permissions: normalizeAccountPermissions(u.permissions, u.role, Boolean(u.assetCenter)),
      permissionsUpdatedAt: u.permissionsUpdatedAt ? new Date(u.permissionsUpdatedAt) : null,
      permissionsUpdatedBy: String(u.permissionsUpdatedBy || ''),
      disabledAt: u.disabledAt ? new Date(u.disabledAt) : null,
      createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
    }
    try {
      const existing = await prisma.user.findUnique({ where: { id } })
      if (!dryRun) {
        if (existing) {
          const same = existing.username === data.username && existing.passwordHash === data.passwordHash &&
            existing.role === data.role && existing.staffKey === data.staffKey &&
            existing.status === data.status && canon(existing.storeKeys) === canon(data.storeKeys) &&
            canon(existing.permissions) === canon(data.permissions)
          if (same) counters.SKIP++
          else { await prisma.user.update({ where: { id }, data }); counters.UPDATE++ }
        } else {
          await prisma.user.create({ data: { id, ...data } })
          counters.CREATE++
        }
      } else if (existing) {
        counters.SKIP++
      } else {
        counters.CREATE++
      }
    } catch (e) {
      counters.ERROR++
      errors.push(`${username}: ${e.message.slice(0, 120)}`)
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
