import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const appRoot = process.env.BUDU_APP_ROOT || '/app'
const periodStart = process.env.AUDIT_PERIOD_START || ''
const periodEnd = process.env.AUDIT_PERIOD_END || ''
const digestOnly = process.env.AUDIT_DIGEST_ONLY === '1'
if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
  throw new Error('AUDIT_PERIOD_START and AUDIT_PERIOD_END are required')
}

const [{ prisma }, { loadAuthoritativePayrollRange }, { personnelMonthlyComponents }] = await Promise.all([
  import(pathToFileURL(`${appRoot}/server/pg.js`).href),
  import(pathToFileURL(`${appRoot}/server/payroll-authority.js`).href),
  import(pathToFileURL(`${appRoot}/src/utils/payrollDisplay.js`).href),
])

function normalize(value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
  }
  return value
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

const dbDate = (value) => new Date(`${value}T00:00:00.000Z`)
const dateWhere = { gte: dbDate(periodStart), lte: dbDate(periodEnd) }

const snapshot = await prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
  const [authority, schedules, attendanceRows, dailyEntries, adjustments, bonuses, employees, payrollNotices, databaseRows] = await Promise.all([
    loadAuthoritativePayrollRange(tx, { periodType: 'custom', periodStart, periodEnd }),
    tx.schedule.findMany({ where: { date: { gte: periodStart, lte: periodEnd } }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }, { id: 'asc' }] }),
    tx.dailyStoreStaff.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { storeId: 'asc' }, { id: 'asc' }] }),
    tx.dailyEntry.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { storeKey: 'asc' }] }),
    tx.dailyPayAdjustment.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    tx.bigOrderBonus.findMany({ where: { date: dateWhere }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    tx.employee.findMany({ orderBy: { id: 'asc' } }),
    tx.payrollNotice.findMany({ where: { periodStart: { lte: dbDate(periodEnd) }, periodEnd: { gte: dbDate(periodStart) } }, orderBy: [{ periodStart: 'asc' }, { id: 'asc' }] }),
    tx.$queryRawUnsafe('SELECT current_database() AS name'),
  ])
  const digests = {
    DailyEntry: { count: dailyEntries.length, sha256: hash(dailyEntries) },
    DailyStoreStaff: { count: attendanceRows.length, sha256: hash(attendanceRows) },
    Employee: { count: employees.length, sha256: hash(employees) },
    DailyPayAdjustment: { count: adjustments.length, sha256: hash(adjustments) },
    BigOrderBonus: { count: bonuses.length, sha256: hash(bonuses) },
    Schedule: { count: schedules.length, sha256: hash(schedules) },
    PayrollNotice: { count: payrollNotices.length, sha256: hash(payrollNotices) },
  }
  const authorityDigest = hash(digests)
  if (digestOnly) return { authorityDigest, digests, productionSha: process.env.GIT_SHA || '', database: databaseRows[0]?.name || '' }
  const cardAmountCentsById = Object.fromEntries((authority.result.payroll?.employees || []).map((record) => {
    const projected = personnelMonthlyComponents(record)
    return [record.employeeId, String(Math.round(Number(projected.salary || 0) * 100))]
  }))
  return {
    generatedAt: new Date().toISOString(),
    productionSha: process.env.GIT_SHA || '',
    database: databaseRows[0]?.name || '',
    authorityDigest,
    digests,
    authority,
    schedules,
    attendanceRows,
    cardAmountCentsById,
  }
}, { isolationLevel: 'RepeatableRead', timeout: 30000 })

process.stdout.write(`${JSON.stringify(normalize(snapshot))}\n`)
await prisma.$disconnect()
