import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import {
  P0_R3B_ACTOR,
  P0_R3B_MANIFEST,
  P0_R3B_REASON,
} from './p0-r3b-historical-manifest.mjs'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED')

const args = new Set(process.argv.slice(2))
const mode = args.has('--apply') ? 'apply' : args.has('--rollback') ? 'rollback' : 'dry-run'
if (args.has('--apply') && args.has('--rollback')) throw new Error('CHOOSE_EXACTLY_ONE_MODE')

const prisma = new PrismaClient()
const iso = (value) => new Date(value).toISOString().slice(0, 10)
const allParticipants = P0_R3B_MANIFEST.flatMap((entry) => entry.participants.map((row) => ({ ...row, entry })))
const targetStaffIds = allParticipants.map((row) => row.dailyStoreStaffId)
const targetAuditIds = P0_R3B_MANIFEST.map((row) => row.statusAuditId)

const jsonBefore = (entry) => ({
  status: entry.status,
  confirmedAt: entry.confirmedAt ? entry.confirmedAt.toISOString() : null,
  confirmedBy: entry.confirmedBy,
  version: entry.version,
  updatedBy: entry.updatedBy,
  updatedAt: entry.updatedAt.toISOString(),
})

async function databaseGuard() {
  const [row] = await prisma.$queryRawUnsafe('SELECT current_database() AS name')
  const dbName = String(row?.name || '')
  const cloneLike = /(clone|rehears|test|gate)/i.test(dbName)
  if (mode !== 'dry-run' && !cloneLike && !args.has('--production-reviewed')) {
    throw new Error(`WRITE_REFUSED_FOR_NON_CLONE_DATABASE:${dbName}`)
  }
  return dbName
}

async function validateManifest(client, expectedStatus) {
  assert.equal(P0_R3B_MANIFEST.length, 40, 'manifest DailyEntry count')
  assert.equal(allParticipants.length, 47, 'manifest participation count')
  assert.equal(allParticipants.filter((row) => row.participantType === 'EMPLOYEE').length, 45)
  assert.equal(allParticipants.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').length, 2)
  assert.equal(allParticipants.filter((row) => row.participantType === 'EMPLOYEE').reduce((sum, row) => sum + row.historicalPayrollHours, 0), 470)
  assert.equal(allParticipants.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').reduce((sum, row) => sum + row.historicalPayrollHours, 0), 23)

  const entries = await client.dailyEntry.findMany({ where: { id: { in: P0_R3B_MANIFEST.map((row) => row.dailyEntryId) } } })
  assert.equal(entries.length, 40, 'all fixed DailyEntry PKs exist')
  const byId = new Map(entries.map((row) => [row.id, row]))
  for (const target of P0_R3B_MANIFEST) {
    const row = byId.get(target.dailyEntryId)
    assert.equal(iso(row.date), target.date, `${target.dailyEntryId} date`)
    assert.equal(row.storeKey, target.storeKey, `${target.dailyEntryId} store`)
    assert.equal(row.status, expectedStatus, `${target.dailyEntryId} status`)
    assert.deepEqual(row.staffNames, target.expectedStaffNames, `${target.dailyEntryId} staff snapshot`)
  }

  const employeeTargets = [...new Map(allParticipants.filter((row) => row.employeeId).map((row) => [row.employeeId, row])).values()]
  const employeeRows = await client.employee.findMany({ where: { id: { in: employeeTargets.map((row) => row.employeeId) } }, select: { id: true, name: true } })
  assert.equal(employeeRows.length, employeeTargets.length, 'all fixed Employee PKs exist')
  const employeeById = new Map(employeeRows.map((row) => [row.id, row]))
  for (const target of employeeTargets) assert.equal(employeeById.get(target.employeeId)?.name, target.staffNameSnapshot)

  const substituteTargets = [...new Map(allParticipants.filter((row) => row.participantUserId).map((row) => [row.participantUserId, row])).values()]
  const userRows = await client.user.findMany({ where: { id: { in: substituteTargets.map((row) => row.participantUserId) } }, select: { id: true, username: true, operationalIdentityType: true } })
  assert.equal(userRows.length, substituteTargets.length, 'all fixed substitute User PKs exist')
  assert.ok(userRows.every((row) => row.operationalIdentityType === 'NON_EMPLOYEE_OPERATIONAL_SUBSTITUTE'))
}

async function applyRemediation() {
  await prisma.$transaction(async (tx) => {
    await validateManifest(tx, 'draft')
    assert.equal(await tx.dailyStoreStaff.count({ where: { id: { in: targetStaffIds } } }), 0, 'target DSS PKs absent')
    assert.equal(await tx.dailyEntryAuditLog.count({ where: { id: { in: targetAuditIds } } }), 0, 'target audit PKs absent')
    assert.equal(await tx.dailyStoreStaff.count({ where: { date: { gte: new Date('2026-08-01T00:00:00.000Z'), lt: new Date('2026-08-11T00:00:00.000Z') } } }), 0, 'locked period has no existing participation rows')

    for (const target of P0_R3B_MANIFEST) {
      const before = await tx.dailyEntry.findUniqueOrThrow({ where: { id: target.dailyEntryId } })
      const confirmedAt = new Date()
      const after = await tx.dailyEntry.update({
        where: { id: target.dailyEntryId },
        data: {
          status: 'confirmed',
          confirmedAt,
          confirmedBy: P0_R3B_ACTOR,
          updatedBy: P0_R3B_ACTOR,
          version: { increment: 1 },
        },
      })
      await tx.dailyEntryAuditLog.create({
        data: {
          id: target.statusAuditId,
          storeId: target.storeKey,
          date: new Date(`${target.date}T00:00:00.000Z`),
          module: 'daily_status',
          fieldName: 'status',
          beforeValue: jsonBefore(before),
          afterValue: jsonBefore(after),
          reason: P0_R3B_REASON,
          operatorId: P0_R3B_ACTOR,
          operatorName: P0_R3B_ACTOR,
        },
      })

      for (const participant of target.participants) {
        const identity = participant.employeeId || participant.participantUserId
        await tx.dailyStoreStaff.create({
          data: {
            id: participant.dailyStoreStaffId,
            storeId: target.storeKey,
            date: new Date(`${target.date}T00:00:00.000Z`),
            employeeId: participant.employeeId,
            participantType: participant.participantType,
            participantUserId: participant.participantUserId,
            staffId: participant.employeeId ? `employee:${identity}` : `user:${identity}`,
            staffNameSnapshot: participant.staffNameSnapshot,
            actualHours: null,
            historicalPayrollHours: participant.historicalPayrollHours,
            payableHoursSource: 'LEGACY_PAYROLL_HOURS',
            attendanceStatus: 'HISTORICAL_UNOBSERVED',
            source: 'historical_authority_remediation',
            createdBy: P0_R3B_ACTOR,
            updatedBy: P0_R3B_ACTOR,
          },
        })
      }
    }

    await validateManifest(tx, 'confirmed')
    const created = await tx.dailyStoreStaff.findMany({ where: { id: { in: targetStaffIds } } })
    assert.equal(created.length, 47)
    assert.ok(created.every((row) => row.actualHours === null && row.historicalPayrollHours != null && row.payableHoursSource === 'LEGACY_PAYROLL_HOURS' && row.attendanceStatus === 'HISTORICAL_UNOBSERVED'))
    assert.equal(created.filter((row) => row.participantType === 'EMPLOYEE').reduce((sum, row) => sum + row.historicalPayrollHours, 0), 470)
    assert.equal(created.filter((row) => row.participantType === 'NON_EMPLOYEE_SUBSTITUTE').reduce((sum, row) => sum + row.historicalPayrollHours, 0), 23)
  }, { timeout: 120000 })
}

async function rollbackRemediation() {
  await prisma.$transaction(async (tx) => {
    await validateManifest(tx, 'confirmed')
    const audits = await tx.dailyEntryAuditLog.findMany({ where: { id: { in: targetAuditIds } } })
    assert.equal(audits.length, 40, 'all fixed status audits exist')
    const auditById = new Map(audits.map((row) => [row.id, row]))
    const staff = await tx.dailyStoreStaff.findMany({ where: { id: { in: targetStaffIds } } })
    assert.equal(staff.length, 47, 'all fixed DSS rows exist')
    assert.ok(staff.every((row) => row.payableHoursSource === 'LEGACY_PAYROLL_HOURS' && row.createdBy === P0_R3B_ACTOR))

    for (const target of P0_R3B_MANIFEST) {
      const before = auditById.get(target.statusAuditId).beforeValue
      await tx.dailyEntry.update({
        where: { id: target.dailyEntryId },
        data: {
          status: before.status,
          confirmedAt: before.confirmedAt ? new Date(before.confirmedAt) : null,
          confirmedBy: before.confirmedBy,
          version: before.version,
          updatedBy: before.updatedBy,
          updatedAt: new Date(before.updatedAt),
        },
      })
    }
    assert.equal((await tx.dailyStoreStaff.deleteMany({ where: { id: { in: targetStaffIds } } })).count, 47)
    assert.equal((await tx.dailyEntryAuditLog.deleteMany({ where: { id: { in: targetAuditIds } } })).count, 40)
    await validateManifest(tx, 'draft')
  }, { timeout: 120000 })
}

try {
  const database = await databaseGuard()
  if (mode === 'apply') await applyRemediation()
  else if (mode === 'rollback') await rollbackRemediation()
  else await validateManifest(prisma, 'draft')
  console.log(JSON.stringify({
    ok: true,
    mode,
    database,
    dailyEntries: 40,
    employeeParticipations: 45,
    substituteParticipations: 2,
    employeeHistoricalPayrollHours: 470,
    substituteHistoricalPayrollHours: 23,
  }))
} finally {
  await prisma.$disconnect()
}
