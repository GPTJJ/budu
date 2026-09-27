import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const oldRoot = process.env.OLD_SOURCE_ROOT
if (!oldRoot) throw new Error('OLD_SOURCE_ROOT_REQUIRED')
const mode = process.argv.includes('--expect-after-backfill') ? 'after-backfill' : 'schema-only'
const { calculateEmployeeIdShadowPayroll } = await import(pathToFileURL(path.join(oldRoot, 'utils/payrollShadowCalculator.js')).href)
const prisma = new PrismaClient()
const start = new Date('2026-08-01T00:00:00.000Z')
const end = new Date('2026-08-27T00:00:00.000Z')
const iso = (value) => new Date(value).toISOString().slice(0, 10)
const money = (value) => Math.round(Number(value || 0) * 100) / 100

try {
  const [dailyEntries, staffRows, adjustments, bonuses] = await Promise.all([
    prisma.dailyEntry.findMany({ where: { date: { gte: start, lt: end } } }),
    prisma.dailyStoreStaff.findMany({ where: { date: { gte: start, lt: end } } }),
    prisma.dailyPayAdjustment.findMany({ where: { date: { gte: start, lt: end }, active: true } }),
    prisma.bigOrderBonus.findMany({ where: { date: { gte: start, lt: end } } }),
  ])
  const entries = Object.fromEntries(dailyEntries.map((row) => [
    `2026-08|${row.storeKey}|${iso(row.date).slice(5)}`,
    { inc: Number(row.incCents) / 100, ord: row.ord, staff: row.staffNames, status: row.status },
  ]))
  const attendance = staffRows.map((row) => ({ ...row, date: iso(row.date) }))
  const adjustmentRows = adjustments.map((row) => ({ ...row, date: iso(row.date), autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot), adjustedPayCents: Number(row.adjustedPayCents) }))
  const bonusRows = bonuses.map((row) => ({ ...row, date: iso(row.date), amountCents: Number(row.amountCents), bonusCents: Number(row.bonusCents) }))

  if (mode === 'after-backfill') {
    assert.throws(
      () => calculateEmployeeIdShadowPayroll(entries, attendance, bonusRows, adjustmentRows, '2026-08'),
      /payableHours/,
      '8e49a31 fails closed on historical rows with actualHours=NULL',
    )
    console.log(JSON.stringify({ ok: true, mode, oldApplicationHistoricalPayroll: 'FAILS_CLOSED' }))
  } else {
    const result = calculateEmployeeIdShadowPayroll(entries, attendance, bonusRows, adjustmentRows, '2026-08')
    const total = money(result.employees.reduce((sum, row) => sum + Number(row.salary || 0), 0))
    assert.equal(result.employees.length, 10)
    assert.equal(total, 21423.45)
    console.log(JSON.stringify({ ok: true, mode, subjects: result.employees.length, total }))
  }
} finally {
  await prisma.$disconnect()
}
