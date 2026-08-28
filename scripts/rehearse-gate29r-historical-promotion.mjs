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
  const [dailyEntries, staffRows, adjustments, bonuses, employees, users, notices] = await Promise.all([
    prisma.dailyEntry.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }] }),
    prisma.dailyStoreStaff.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { id: 'asc' }] }),
    prisma.dailyPayAdjustment.findMany({ where: { date: { gte: start, lt: end }, active: true }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    prisma.bigOrderBonus.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    prisma.employee.findMany({ select: { id: true, name: true, status: true } }),
    prisma.user.findMany({ select: { id: true, username: true, employeeId: true, status: true } }),
    prisma.payrollNotice.findMany({ orderBy: { id: 'asc' } }),
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

  const employeeRows = attendance.filter((row) => row.participantType === 'EMPLOYEE')
  const substituteRows = attendance.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE')
  const unknownRows = attendance.filter((row) => ['LEGACY_EMPLOYEE_COMPATIBLE', 'LEGACY_UNKNOWN'].includes(row.participantType))
  assert.equal(employeeRows.length, 64)
  assert.equal(substituteRows.length, 6)
  assert.equal(unknownRows.length, 0)
  assert.ok(employeeRows.every((row) => row.employeeId && !row.participantUserId))
  assert.ok(substituteRows.every((row) => !row.employeeId && row.participantUserId === '96d3615a-32b5-44f8-b362-39a48fee5f8c'))

  const result = resolvePayrollCalculation({
    month,
    dailyEntries: entries,
    dailyStoreStaffRows: attendance,
    dailyPayAdjustments: adjustmentRows,
    bigOrderBonuses: bonusRows,
    employees,
    users,
  })

  const total = money(result.payroll.employees.reduce((sum, row) => sum + Number(row.salary || 0), 0))
  const employeeIds = new Set(employees.map((row) => row.id))
  const substituteSubjects = result.payroll.employees.filter((row) => !employeeIds.has(row.employeeId))
  const draftKeys = new Set(staffRows
    .filter((row) => {
      const entry = dailyEntries.find((item) => item.storeKey === row.storeId && isoDate(item.date) === isoDate(row.date))
      return entry?.status !== 'confirmed' && row.participantType === 'EMPLOYEE'
    })
    .map((row) => `${row.employeeId}|${row.storeId}|${isoDate(row.date)}`))
  const draftContributions = result.payroll.employees
    .flatMap((employee) => (employee.dailyExplanations || []).map((day) => ({ employeeId: employee.employeeId, day })))
    .filter(({ employeeId, day }) => draftKeys.has(`${employeeId}|${day.storeKey}|${day.date}`))
  const jingxin = result.payroll.employees.find((row) => row.employeeId === 'emp-5b890d14-35ca-4b4b-a8a9-90eb69403687')
  const correction = jingxin?.dailyExplanations.find((row) => row.date === '2026-08-24' && row.storeKey === 'chaowai')
  const substituteDates = new Set(substituteRows.map((row) => `${row.storeId}|${isoDate(row.date)}`))
  const substituteDayExplanations = result.payroll.employees
    .flatMap((employee) => employee.dailyExplanations || [])
    .filter((day) => substituteDates.has(`${day.storeKey}|${day.date}`))
    .map((day) => ({
      employeeId: day.employeeId,
      date: day.date,
      storeKey: day.storeKey,
      participantCount: day.explanation?.participantCount,
      rawStoreRevenue: day.explanation?.rawStoreRevenue,
      displayWorkedRevenue: day.explanation?.displayWorkedRevenue,
      commissionBasis: day.explanation?.commissionBasis,
    }))

  assert.equal(result.attendanceMode, 'EMPLOYEE_ID')
  assert.equal(result.calculationReady, true)
  assert.equal(result.issueReady, true)
  assert.equal(result.payroll.attendanceCoverage.missing.length, 0)
  assert.equal(result.payroll.employees.length, 10)
  assert.equal(total, 21423.45)
  assert.equal(substituteSubjects.length, 0)
  assert.equal(draftKeys.size, 6)
  assert.equal(draftContributions.length, 0)
  assert.equal(correction?.hours, 11.5)
  assert.equal(correction?.finalPay, 345)
  assert.equal(adjustmentRows.reduce((sum, row) => sum + row.adjustedPayCents, 0), 28000)
  assert.equal(bonusRows.reduce((sum, row) => sum + row.bonusCents, 0), 6045)
  assert.equal(bonusRows.reduce((sum, row) => sum + row.amountCents, 0), 120900)
  assert.ok(substituteDayExplanations.every((day) => day.participantCount >= 2))

  console.log(JSON.stringify({
    authorityShape: {
      employeeRows: employeeRows.length,
      substituteRows: substituteRows.length,
      unknownRows: unknownRows.length,
      draftEmployeeRows: draftKeys.size,
      historicalNoticeRows: notices.length,
    },
    readiness: {
      attendanceMode: result.attendanceMode,
      calculationReady: result.calculationReady,
      issueReady: result.issueReady,
      blockers: result.blockers.map((row) => row.reason),
      coverage: result.payroll.attendanceCoverage,
    },
    payroll: {
      realSubjects: result.payroll.employees.length,
      substituteSubjects: substituteSubjects.length,
      total,
      adjustmentCents: adjustmentRows.reduce((sum, row) => sum + row.adjustedPayCents, 0),
      bonusCents: bonusRows.reduce((sum, row) => sum + row.bonusCents, 0),
      bonusOrderAmountCents: bonusRows.reduce((sum, row) => sum + row.amountCents, 0),
      subjects: result.payroll.employees.map(({ dailyExplanations, ...row }) => row),
    },
    draftSafety: {
      stableIdentityRows: draftKeys.size,
      salaryContributionRows: draftContributions.length,
    },
    correction824: { hours: correction.hours, finalPay: correction.finalPay },
    substituteDays: {
      observableSharedEmployeeDays: substituteDayExplanations.length,
      explanations: substituteDayExplanations,
    },
    expected: {
      subjects: 10,
      total: 21423.45,
      unexpectedAmountDifference: money(total - 21423.45),
      unexpectedSubjectDifference: result.payroll.employees.length - 10,
    },
  }, null, 2))
} finally {
  await prisma.$disconnect()
}
