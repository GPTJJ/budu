import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { resolvePayrollCalculation } from '../src/utils/payrollResolver.js'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')

const prisma = new PrismaClient()
const isoDate = (value) => new Date(value).toISOString().slice(0, 10)
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100
const startDate = '2026-08-01'
const frozenEnd = '2026-08-26'
const auditEnd = process.env.AUDIT_END || new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

assert.match(auditEnd, /^2026-08-(2[7-9]|3[01])$/, 'AUDIT_END must be an August 2026 date on/after 8/27')

const queryStart = new Date(`${startDate}T00:00:00.000Z`)
const queryEnd = new Date('2026-09-01T00:00:00.000Z')

function transportEntries(rows) {
  return Object.fromEntries(rows.map((row) => {
    const date = isoDate(row.date)
    return [
      `${date.slice(0, 7)}|${row.storeKey}|${date.slice(5)}`,
      { inc: Number(row.incCents) / 100, ord: row.ord, staff: row.staffNames, status: row.status },
    ]
  }))
}

function total(result) {
  return round2((result.payroll.employees || []).reduce((sum, row) => sum + Number(row.salary || 0), 0))
}

function hours(result) {
  return round2((result.payroll.employees || []).reduce((sum, row) => sum + Number(row.payableHours || 0), 0))
}

function sourceHours(result, source) {
  return round2((result.payroll.employees || []).flatMap((row) => row.dailyExplanations || [])
    .filter((row) => row.payableHoursSource === source)
    .reduce((sum, row) => sum + Number(row.payableHours || 0), 0))
}

function signature(result) {
  return (result.payroll.employees || []).map((row) => ({
    employeeId: row.employeeId,
    payableHours: round2(row.payableHours),
    salary: round2(row.salary),
    days: (row.dailyExplanations || []).map((day) => ({
      date: day.date,
      storeKey: day.storeKey || '',
      payableHours: round2(day.payableHours),
      payableHoursSource: day.payableHoursSource,
      basePay: round2(day.basePay),
      commission: round2(day.commission),
      transferSubsidy: round2(day.transferSubsidy),
      bigBonus: round2(day.bigBonus),
      salaryAdjustment: round2(day.salaryAdjustment),
      finalPay: round2(day.finalPay),
    })).sort((a, b) => `${a.date}|${a.storeKey}`.localeCompare(`${b.date}|${b.storeKey}`)),
  })).sort((a, b) => a.employeeId.localeCompare(b.employeeId))
}

function calculationInput(period, data) {
  return {
    ...period,
    dailyEntries: transportEntries(data.dailyEntries),
    dailyStoreStaffRows: data.staffRows,
    dailyPayAdjustments: data.adjustments,
    bigOrderBonuses: data.bonuses,
    employees: data.employees,
    users: data.users,
    storeNames: data.storeNames,
  }
}

function deltaDetails(result) {
  return (result.payroll.employees || []).flatMap((employee) =>
    (employee.dailyExplanations || []).map((day) => ({
      date: day.date,
      store: day.storeKey || '',
      employeeId: employee.employeeId,
      payableHours: round2(day.payableHours),
      payableHoursSource: day.payableHoursSource,
      basePay: round2(day.basePay),
      commission: round2(day.commission),
      transferSubsidy: round2(day.transferSubsidy),
      bigBonus: round2(day.bigBonus),
      salaryAdjustment: round2(day.salaryAdjustment),
      finalPay: round2(day.finalPay),
    })),
  ).sort((a, b) => `${a.date}|${a.store}|${a.employeeId}`.localeCompare(`${b.date}|${b.store}|${b.employeeId}`))
}

try {
  const [dailyEntriesRaw, staffRowsRaw, adjustmentsRaw, bonusesRaw, employees, users, stores, migrationCount] = await Promise.all([
    prisma.dailyEntry.findMany({ where: { date: { gte: queryStart, lt: queryEnd } }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }] }),
    prisma.dailyStoreStaff.findMany({ where: { date: { gte: queryStart, lt: queryEnd } }, orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { id: 'asc' }] }),
    prisma.dailyPayAdjustment.findMany({ where: { date: { gte: queryStart, lt: queryEnd }, active: true }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    prisma.bigOrderBonus.findMany({ where: { date: { gte: queryStart, lt: queryEnd } }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    prisma.employee.findMany({ select: { id: true, employeeNo: true, name: true, status: true } }),
    prisma.user.findMany({ select: { id: true, username: true, employeeId: true, status: true } }),
    prisma.store.findMany({ select: { key: true, name: true } }),
    prisma.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  ])

  assert.equal(migrationCount[0]?.count, 47)
  const data = {
    dailyEntries: dailyEntriesRaw.map((row) => ({ ...row, date: isoDate(row.date) })),
    staffRows: staffRowsRaw.map((row) => ({
      ...row,
      date: isoDate(row.date),
      actualHours: row.actualHours == null ? null : Number(row.actualHours),
      historicalPayrollHours: row.historicalPayrollHours == null ? null : Number(row.historicalPayrollHours),
    })),
    adjustments: adjustmentsRaw.map((row) => ({
      ...row, date: isoDate(row.date), autoPayCentsSnapshot: Number(row.autoPayCentsSnapshot), adjustedPayCents: Number(row.adjustedPayCents),
    })),
    bonuses: bonusesRaw.map((row) => ({
      ...row, date: isoDate(row.date), amountCents: Number(row.amountCents), bonusCents: Number(row.bonusCents),
    })),
    employees,
    users,
    storeNames: Object.fromEntries(stores.map((row) => [row.key, row.name])),
  }

  const oldMonthPath = resolvePayrollCalculation(calculationInput({ month: '2026-08' }, data))
  const canonicalMonthPath = resolvePayrollCalculation(calculationInput({
    periodType: 'month', periodStart: '2026-08-01', periodEnd: '2026-08-31',
  }, data))
  assert.deepEqual(signature(canonicalMonthPath), signature(oldMonthPath), 'MONTH formula/subject/day freeze')

  const frozen = resolvePayrollCalculation(calculationInput({ periodType: 'custom', periodStart: startDate, periodEnd: frozenEnd }, data))
  assert.equal(frozen.calculationReady, true)
  assert.equal(frozen.payroll.employees.length, 10)
  assert.equal(hours(frozen), 1169)
  assert.equal(sourceHours(frozen, 'ACTUAL_HOURS'), 699)
  assert.equal(sourceHours(frozen, 'LEGACY_PAYROLL_HOURS'), 470)
  assert.equal(total(frozen), 39436.45)
  assert.equal(frozen.payroll.attendanceCoverage?.missing?.length || 0, 0)
  assert.equal((frozen.payroll.unresolvedDays || []).length, 0)

  const confirmedStoreDays = new Set(data.dailyEntries
    .filter((row) => row.date >= startDate && row.date <= frozenEnd && row.status === 'confirmed')
    .map((row) => `${row.storeKey}|${row.date}`))
  const operationalRows = data.staffRows.filter((row) => (
    row.date >= startDate && row.date <= frozenEnd && confirmedStoreDays.has(`${row.storeId}|${row.date}`)
  ))
  const unknownRows = operationalRows.filter((row) => (
    (row.participantType === 'EMPLOYEE' && !row.employeeId)
    || (row.participantType === 'NON_EMPLOYEE_SUBSTITUTE' && (!row.participantUserId || row.employeeId))
    || !['EMPLOYEE', 'NON_EMPLOYEE_SUBSTITUTE'].includes(row.participantType)
  ))
  assert.equal(confirmedStoreDays.size, 104)
  assert.equal(operationalRows.length, 117)
  assert.equal(unknownRows.length, 0)
  const substituteHours = round2(operationalRows
    .filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE' && row.payableHoursSource === 'LEGACY_PAYROLL_HOURS')
    .reduce((sum, row) => sum + Number(row.historicalPayrollHours ?? row.actualHours ?? 0), 0))
  assert.equal(substituteHours, 23)

  const delta = resolvePayrollCalculation(calculationInput({ periodType: 'custom', periodStart: '2026-08-27', periodEnd: auditEnd }, data))
  const currentMtd = resolvePayrollCalculation(calculationInput({ periodType: 'custom', periodStart: startDate, periodEnd: auditEnd }, data))
  assert.equal(currentMtd.calculationReady, true)
  assert.equal(round2(total(frozen) + total(delta)), total(currentMtd), 'frozen + 8/27+ must reconcile to current MTD')

  console.log(JSON.stringify({
    ok: true,
    migration: 47,
    frozen: {
      periodStart: startDate,
      periodEnd: frozenEnd,
      storeDays: confirmedStoreDays.size,
      operationalParticipations: operationalRows.length,
      missing: frozen.payroll.attendanceCoverage?.missing?.length || 0,
      partial: (frozen.payroll.unresolvedDays || []).length,
      unknown: unknownRows.length,
      subjects: frozen.payroll.employees.length,
      payableHours: hours(frozen),
      actualHours: sourceHours(frozen, 'ACTUAL_HOURS'),
      historicalPayrollHours: sourceHours(frozen, 'LEGACY_PAYROLL_HOURS'),
      historicalSubstituteHours: substituteHours,
      total: total(frozen),
      unexpectedDifference: round2(total(frozen) - 39436.45),
    },
    monthFormulaFreeze: {
      subjectDifference: canonicalMonthPath.payroll.employees.length - oldMonthPath.payroll.employees.length,
      amountDifference: round2(total(canonicalMonthPath) - total(oldMonthPath)),
      dayMembershipDifference: 0,
    },
    currentMtd: {
      periodStart: startDate,
      periodEnd: auditEnd,
      frozenBaseline: total(frozen),
      deltaStart: '2026-08-27',
      delta: total(delta),
      total: total(currentMtd),
      deltaFullyExplained: true,
      details: deltaDetails(delta),
    },
  }, null, 2))
} finally {
  await prisma.$disconnect()
}
