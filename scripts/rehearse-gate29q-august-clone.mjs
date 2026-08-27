import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')

const prisma = new PrismaClient()
const month = '2026-08'
const start = new Date('2026-08-01T00:00:00.000Z')
const end = new Date('2026-09-01T00:00:00.000Z')
const isoDate = (value) => new Date(value).toISOString().slice(0, 10)
const money = (value) => Math.round(Number(value || 0) * 100) / 100

try {
  const [dailyEntries, staffRows, adjustments, bonuses, employees, users] = await Promise.all([
    prisma.dailyEntry.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }] }),
    prisma.dailyStoreStaff.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { id: 'asc' }] }),
    prisma.dailyPayAdjustment.findMany({ where: { date: { gte: start, lt: end }, active: true }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    prisma.bigOrderBonus.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    prisma.employee.findMany({ select: { id: true, name: true, status: true } }),
    prisma.user.findMany({ select: { id: true, username: true, employeeId: true, status: true } }),
  ])

  const entries = Object.fromEntries(dailyEntries.map((row) => [
    `${month}|${row.storeKey}|${isoDate(row.date).slice(5)}`,
    {
      inc: Number(row.incCents) / 100,
      ord: row.ord,
      staff: Array.isArray(row.staffNames) ? row.staffNames : [],
      status: row.status,
    },
  ]))
  const attendance = staffRows.map((row) => ({ ...row, date: isoDate(row.date) }))
  const adjustmentRows = adjustments.map((row) => ({
    ...row,
    date: isoDate(row.date),
    autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot),
    adjustedPayCents: Number(row.adjustedPayCents),
  }))
  const bonusRows = bonuses.map((row) => ({
    ...row,
    date: isoDate(row.date),
    amountCents: Number(row.amountCents),
    bonusCents: Number(row.bonusCents),
  }))

  const partial = resolvePayrollCalculation({
    month,
    dailyEntries: entries,
    dailyStoreStaffRows: attendance,
    dailyPayAdjustments: adjustmentRows,
    bigOrderBonuses: bonusRows,
    employees,
    users,
  })
  const partialTotal = money(partial.payroll.employees.reduce((sum, row) => sum + Number(row.salary || 0), 0))

  const legacyCompatibleCount = attendance.filter((row) => row.participantType === 'LEGACY_EMPLOYEE_COMPATIBLE').length
  const substituteCount = attendance.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').length
  // Raw migrated shape is 64 reviewed-compatible + 6 substitutes. Six of the
  // compatible rows belong to draft/unconfirmed days, so confirmed attendance
  // coverage below is 58. Draft rows remain deliberately non-payable.
  assert.equal(legacyCompatibleCount, 64)
  assert.equal(substituteCount, 6)
  assert.equal(adjustmentRows.filter((row) => row.employeeId).length, 2)
  assert.equal(bonusRows.filter((row) => row.employeeId).length, 1)
  assert.equal(partial.attendanceMode, 'LEGACY_COMPATIBLE')
  assert.equal(partial.calculationReady, false)
  assert.equal(partial.issueReady, false)
  assert.ok(partial.blockers.some((row) => row.reason === 'STABLE_CONTRIBUTION_WITH_LEGACY_ATTENDANCE'))
  assert.equal(partial.payroll.employees.length, 9)
  assert.equal(partial.payroll.attendanceCoverage.expected, 58)
  assert.equal(partial.payroll.attendanceCoverage.represented, 58)
  assert.notEqual(partialTotal, 280)

  // Rehearsal only: every reviewed compatible name must map to one and only one
  // Employee.id. This in-memory promotion is not persisted and is never runtime
  // policy; it verifies the future all-stable target after a separately approved
  // data migration.
  const employeeIdsByName = new Map()
  for (const employee of employees) {
    const name = String(employee.name || '').trim()
    const ids = employeeIdsByName.get(name) || []
    ids.push(employee.id)
    employeeIdsByName.set(name, ids)
  }
  const promoted = attendance.map((row) => {
    if (row.participantType !== 'LEGACY_EMPLOYEE_COMPATIBLE') return row
    const ids = employeeIdsByName.get(String(row.staffNameSnapshot || '').trim()) || []
    assert.equal(ids.length, 1, `PROMOTION_MAPPING_NOT_UNIQUE:${row.id}:${row.staffNameSnapshot}`)
    return {
      ...row,
      employeeId: ids[0],
      participantType: 'EMPLOYEE',
      participantUserId: null,
      staffId: `employee:${ids[0]}`,
    }
  })

  const fullStable = resolvePayrollCalculation({
    month,
    dailyEntries: entries,
    dailyStoreStaffRows: promoted,
    dailyPayAdjustments: adjustmentRows,
    bigOrderBonuses: bonusRows,
    employees,
    users,
  })
  const fullTotal = money(fullStable.payroll.employees.reduce((sum, row) => sum + Number(row.salary || 0), 0))
  const substituteSubjects = fullStable.payroll.employees.filter((row) => String(row.employeeId || '').startsWith('user:')).length
  const jingxin = fullStable.payroll.employees.find((row) => row.displayName === '马婧欣')
  const correction = jingxin?.dailyExplanations.find((row) => row.date === '2026-08-24' && row.storeKey === 'chaowai')

  assert.equal(fullStable.attendanceMode, 'EMPLOYEE_ID')
  assert.equal(fullStable.calculationReady, true)
  assert.equal(fullStable.payroll.attendanceCoverage.missing.length, 0)
  assert.equal(fullStable.payroll.employees.length, 10)
  assert.equal(fullTotal, 21423.45)
  assert.equal(substituteSubjects, 0)
  assert.equal(correction?.hours, 11.5)
  assert.equal(correction?.finalPay, 345)

  console.log(JSON.stringify({
    authorityShape: {
      classifiedRows: legacyCompatibleCount + substituteCount,
      legacyCompatible: legacyCompatibleCount,
      substitutes: substituteCount,
      stableAdjustments: 2,
      stableBonuses: 1,
    },
    partial: {
      attendanceMode: partial.attendanceMode,
      calculationReady: partial.calculationReady,
      issueReady: partial.issueReady,
      subjects: partial.payroll.employees.length,
      total: partialTotal,
      coverage: partial.payroll.attendanceCoverage,
      blockers: partial.blockers.map((row) => row.reason),
    },
    fullStable: {
      attendanceMode: fullStable.attendanceMode,
      calculationReady: fullStable.calculationReady,
      issueReady: fullStable.issueReady,
      subjects: fullStable.payroll.employees.length,
      total: fullTotal,
      substituteSubjects,
      missingCoverage: fullStable.payroll.attendanceCoverage.missing.length,
      correction824: { hours: correction.hours, finalPay: correction.finalPay },
    },
    expected: { subjects: 10, total: 21423.45, unexpectedAmountDifference: money(fullTotal - 21423.45), unexpectedSubjectDifference: fullStable.payroll.employees.length - 10 },
  }, null, 2))
} finally {
  await prisma.$disconnect()
}
