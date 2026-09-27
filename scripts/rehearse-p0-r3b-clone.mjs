import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')

const prisma = new PrismaClient()
const month = '2026-08'
const start = new Date('2026-08-01T00:00:00.000Z')
const frozenEnd = new Date('2026-08-27T00:00:00.000Z')
const cutover = new Date('2026-08-11T00:00:00.000Z')
const isoDate = (value) => new Date(value).toISOString().slice(0, 10)
const money = (value) => Math.round(Number(value || 0) * 100) / 100

function transportEntries(rows) {
  return Object.fromEntries(rows.map((row) => [
    `${month}|${row.storeKey}|${isoDate(row.date).slice(5)}`,
    { inc: Number(row.incCents) / 100, ord: row.ord, staff: row.staffNames, status: row.status },
  ]))
}

try {
  const [dailyEntries, staffRows, adjustments, bonuses, employees, users, notices] = await Promise.all([
    prisma.dailyEntry.findMany({ where: { date: { gte: start, lt: frozenEnd } }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }] }),
    prisma.dailyStoreStaff.findMany({ where: { date: { gte: start, lt: frozenEnd } }, orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { id: 'asc' }] }),
    prisma.dailyPayAdjustment.findMany({ where: { date: { gte: start, lt: frozenEnd }, active: true } }),
    prisma.bigOrderBonus.findMany({ where: { date: { gte: start, lt: frozenEnd } } }),
    prisma.employee.findMany({ select: { id: true, name: true, status: true } }),
    prisma.user.findMany({ select: { id: true, username: true, employeeId: true, status: true } }),
    prisma.payrollNotice.findMany({ orderBy: { id: 'asc' } }),
  ])

  const attendance = staffRows.map((row) => ({ ...row, date: isoDate(row.date) }))
  const adjustmentRows = adjustments.map((row) => ({ ...row, date: isoDate(row.date), autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot), adjustedPayCents: Number(row.adjustedPayCents) }))
  const bonusRows = bonuses.map((row) => ({ ...row, date: isoDate(row.date), amountCents: Number(row.amountCents), bonusCents: Number(row.bonusCents) }))
  const historicalEmployeeRows = attendance.filter((row) => row.payableHoursSource === 'LEGACY_PAYROLL_HOURS' && row.participantType === 'EMPLOYEE')
  const historicalSubstituteRows = attendance.filter((row) => row.payableHoursSource === 'LEGACY_PAYROLL_HOURS' && row.participantType === 'NON_EMPLOYEE_SUBSTITUTE')
  const actualRows = attendance.filter((row) => row.payableHoursSource === 'ACTUAL_HOURS')

  assert.equal(historicalEmployeeRows.length, 45)
  assert.equal(historicalSubstituteRows.length, 2)
  assert.equal(historicalEmployeeRows.reduce((sum, row) => sum + row.historicalPayrollHours, 0), 470)
  assert.equal(historicalSubstituteRows.reduce((sum, row) => sum + row.historicalPayrollHours, 0), 23)
  assert.ok(historicalEmployeeRows.concat(historicalSubstituteRows).every((row) => row.actualHours === null && row.attendanceStatus === 'HISTORICAL_UNOBSERVED'))
  assert.ok(actualRows.every((row) => row.actualHours != null && row.historicalPayrollHours === null))

  const result = resolvePayrollCalculation({
    month,
    dailyEntries: transportEntries(dailyEntries),
    dailyStoreStaffRows: attendance,
    dailyPayAdjustments: adjustmentRows,
    bigOrderBonuses: bonusRows,
    employees,
    users,
  })
  const total = money(result.payroll.employees.reduce((sum, row) => sum + Number(row.salary || 0), 0))
  const payableHours = money(result.payroll.employees.reduce((sum, row) => sum + Number(row.payableHours || 0), 0))
  assert.equal(result.payroll.employees.length, 10)
  assert.equal(payableHours, 1098)
  assert.equal(total, 37104.45)
  assert.equal(result.calculationReady, true)

  const employeeIds = new Set(employees.map((row) => row.id))
  assert.equal(result.payroll.employees.filter((row) => !employeeIds.has(row.employeeId)).length, 0, 'substitute is not a payroll subject')

  const draftFacts = [
    ['2026-08-12', 'tongying', '李飞燕', 12],
    ['2026-08-13', 'tongying', '李飞燕', 12],
    ['2026-08-14', 'xidan', '陈文慧', 12],
    ['2026-08-22', 'xidan', '陈文慧', 12],
    ['2026-08-24', 'guanshe', '隋晓', 11],
    ['2026-08-24', 'xidan', '陈文慧', 12],
  ]
  for (const [date, storeKey, name, hours] of draftFacts) {
    const entry = dailyEntries.find((row) => isoDate(row.date) === date && row.storeKey === storeKey)
    const staff = actualRows.find((row) => row.date === date && row.storeId === storeKey && row.staffNameSnapshot === name)
    assert.equal(entry?.status, 'draft', `${date}/${storeKey} remains draft`)
    assert.equal(staff?.actualHours, hours, `${date}/${storeKey}/${name} actualHours preserved`)
  }

  const jingxin = result.payroll.employees.find((row) => row.employeeId === 'emp-5b890d14-35ca-4b4b-a8a9-90eb69403687')
  const correction = jingxin?.dailyExplanations.find((row) => row.date === '2026-08-24' && row.storeKey === 'chaowai')
  assert.equal(correction?.payableHours, 11.5)
  assert.equal(correction?.payableHoursSource, 'ACTUAL_HOURS')
  assert.equal(correction?.finalPay, 345)

  const postCutoverEntries = dailyEntries.filter((row) => row.date >= cutover)
  const postCutover = resolvePayrollCalculation({
    month,
    dailyEntries: transportEntries(postCutoverEntries),
    dailyStoreStaffRows: actualRows,
    dailyPayAdjustments: adjustmentRows,
    bigOrderBonuses: bonusRows,
    employees,
    users,
  })
  const postCutoverTotal = money(postCutover.payroll.employees.reduce((sum, row) => sum + Number(row.salary || 0), 0))
  assert.equal(postCutover.payroll.employees.length, 10)
  assert.equal(postCutoverTotal, 21423.45, 'existing post-cutover formula and subjects frozen')

  console.log(JSON.stringify({
    ok: true,
    migrationCount: 46,
    databaseRows: { dailyStoreStaff: staffRows.length, actual: actualRows.length, historicalEmployee: 45, historicalSubstitute: 2 },
    historicalHours: { employee: 470, substitute: 23 },
    frozenPayroll: { subjects: 10, payableHours, total, calculationReady: result.calculationReady },
    existingPayrollFreeze: { subjects: postCutover.payroll.employees.length, total: postCutoverTotal },
    correction824: { employee: '马婧欣', payableHours: correction.payableHours, source: correction.payableHoursSource, finalPay: correction.finalPay },
    untouchedDrafts: draftFacts.length,
    payrollNoticeRows: notices.length,
  }))
} finally {
  await prisma.$disconnect()
}
