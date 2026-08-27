import assert from 'node:assert/strict'
import { prisma } from '../server/pg.js'
import { signToken } from '../server/auth.js'

const base = process.env.REHEARSAL_API_URL || 'http://127.0.0.1:3000/api'
const secret = process.env.JWT_SECRET
if (!secret) throw new Error('JWT_SECRET_REQUIRED')

const developer = await prisma.user.findFirst({ where: { role: 'developer', status: 'active' } })
assert.ok(developer, 'active developer exists in clone')
const cookie = `budu_token=${signToken(developer, secret)}`
const request = (path, init = {}) => fetch(`${base}${path}`, {
  ...init,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers || {}) },
})

try {
  const staffResponse = await request('/v2/daily-store-staff?month=2026-08')
  assert.equal(staffResponse.status, 200)
  const staffPayload = await staffResponse.json()
  const historical = staffPayload.rows.filter((row) => row.payableHoursSource === 'LEGACY_PAYROLL_HOURS')
  assert.equal(historical.length, 47)
  assert.ok(historical.every((row) => row.actualHours === null && row.historicalPayrollHours != null && row.attendanceStatus === 'HISTORICAL_UNOBSERVED'))

  const beforeCount = await prisma.dailyStoreStaff.count()
  const target = historical.find((row) => row.employeeId)
  const forged = await request('/v2/daily-staff', {
    method: 'PUT',
    body: JSON.stringify({
      storeKey: target.storeId,
      date: target.date,
      items: [{
        employeeId: target.employeeId,
        actualHours: target.historicalPayrollHours,
        historicalPayrollHours: target.historicalPayrollHours,
        payableHoursSource: 'LEGACY_PAYROLL_HOURS',
        attendanceStatus: 'HISTORICAL_UNOBSERVED',
        breakMinutes: 0,
      }],
    }),
  })
  assert.equal(forged.status, 400, 'normal API rejects forged historical source')

  const overwrite = await request('/v2/daily-staff', {
    method: 'PUT',
    body: JSON.stringify({
      storeKey: target.storeId,
      date: target.date,
      items: [{ employeeId: target.employeeId, actualHours: target.historicalPayrollHours, attendanceStatus: 'normal', breakMinutes: 0 }],
    }),
  })
  assert.equal(overwrite.status, 409, 'normal API rejects historical overwrite/delete')
  assert.equal(await prisma.dailyStoreStaff.count(), beforeCount, 'blocked API attempts leave DSS unchanged')

  const shiId = 'emp-58c68115-f0f2-4731-9951-2050d2e7229f'
  const profileResponse = await request(`/v2/employees/${shiId}/summary`)
  assert.equal(profileResponse.status, 200)
  const profile = await profileResponse.json()
  assert.deepEqual(profile.attendance, { days: 1, totalHours: 11.5 }, 'Employee profile attendance remains ACTUAL_HOURS only')

  console.log(JSON.stringify({
    ok: true,
    staffTransport: { historicalRows: historical.length, taggedFieldsPreserved: true },
    forgedHistoricalWrite: 400,
    historicalOverwrite: 409,
    employeeProfileActualOnly: profile.attendance,
  }))
} finally {
  await prisma.$disconnect()
}
