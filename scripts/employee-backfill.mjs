#!/usr/bin/env node
/**
 * BUDU Data Authority — Employee 主档离线回填。
 *
 * 从 PostgreSQL Staff 镜像为缺失的 (currentStoreKey, name) 创建 Employee，
 * 不修改或删除既有员工。脚本可重复执行，第二次及以后只会 SKIP。
 *
 * 用法：
 *   DATABASE_URL=... node scripts/employee-backfill.mjs [--dry-run]
 */
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const dryRun = process.argv.slice(2).includes('--dry-run')
if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL')
  process.exit(1)
}

const prisma = new PrismaClient()

async function run() {
  const staffRows = await prisma.staff.findMany({ orderBy: [{ storeKey: 'asc' }, { name: 'asc' }] })
  const employeeRows = await prisma.employee.findMany({
    select: { employeeNo: true, currentStoreKey: true, name: true },
  })
  const existing = new Set(employeeRows.map((row) => `${row.currentStoreKey}::${row.name}`))
  let seq = employeeRows.reduce((max, row) => {
    const value = Number(String(row.employeeNo || '').replace(/\D/g, '')) || 0
    return Math.max(max, value)
  }, 0)
  const counters = { CREATE: 0, SKIP: 0, CONFLICT: 0, ERROR: 0 }
  const errors = []

  for (const staff of staffRows) {
    const key = `${staff.storeKey}::${staff.name}`
    if (existing.has(key)) {
      counters.SKIP += 1
      continue
    }
    seq += 1
    counters.CREATE += 1
    if (dryRun) {
      existing.add(key)
      continue
    }
    try {
      const employeeId = `emp-${crypto.randomUUID()}`
      const employeeNo = `BUDU-${String(seq).padStart(4, '0')}`
      await prisma.$transaction([
        prisma.employee.create({
          data: {
            id: employeeId,
            employeeNo,
            name: staff.name,
            status: 'ACTIVE',
            employmentType: String(staff.type || 'fulltime'),
            currentStoreKey: staff.storeKey,
            position: '店员',
            hireDate: null,
          },
        }),
        prisma.employeeAuditLog.create({
          data: {
            id: `eal-${crypto.randomUUID()}`,
            employeeId,
            action: 'backfill.create',
            targetType: 'employee',
            afterValue: { created: true, source: 'scripts/employee-backfill.mjs' },
            operatorName: 'deployment-migration',
            operatorRole: 'system',
          },
        }),
      ])
      existing.add(key)
    } catch (error) {
      counters.CREATE -= 1
      if (error?.code === 'P2002') counters.CONFLICT += 1
      else counters.ERROR += 1
      errors.push(`${key}: ${String(error?.message || error).slice(0, 160)}`)
    }
  }

  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', total: staffRows.length, counters, errorCount: errors.length }))
  if (errors.length) {
    console.error(`ERRORS:\n${errors.slice(0, 10).join('\n')}`)
    process.exitCode = 2
  }
}

run()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect() })
