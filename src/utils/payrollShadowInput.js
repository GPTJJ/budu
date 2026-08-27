import { PAYROLL_PARTICIPANT_TYPES } from '../../shared/payrollParticipantAuthority.js'

const participantTypeOf = (row) => {
  if (Object.values(PAYROLL_PARTICIPANT_TYPES).includes(row?.participantType)) return row.participantType
  // Transport compatibility for pre-discriminator test data. Migrated rows always
  // carry participantType, so LEGACY_UNKNOWN is never promoted here.
  if (row?.employeeId) return PAYROLL_PARTICIPANT_TYPES.EMPLOYEE
  return PAYROLL_PARTICIPANT_TYPES.LEGACY_UNKNOWN
}

/** Build Employee.id payroll day inputs without name-based identity inference. */
export function buildEmployeePayrollDayInputs(dailyEntries, dailyStoreStaffRows) {
  const entries = dailyEntries && typeof dailyEntries === 'object' ? dailyEntries : {}
  const staffRows = Array.isArray(dailyStoreStaffRows) ? dailyStoreStaffRows : []
  const entryByStoreDate = new Map()

  for (const [key, value] of Object.entries(entries)) {
    const parts = key.split('|')
    if (parts.length !== 3 || parts[1] === 'all') continue
    const day = String(parts[2]).includes('-') ? String(parts[2]).slice(3) : String(parts[2])
    const fullDate = `${parts[0]}-${day}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fullDate)) continue
    entryByStoreDate.set(`${parts[1]}|${fullDate}`, {
      storeKey: parts[1],
      date: fullDate,
      inc: Number(value?.inc) || 0,
      ord: Number(value?.ord) || 0,
      staffNames: Array.isArray(value?.staff) ? value.staff : [],
      // Pre-Gate pure-function fixtures omitted status and represent confirmed
      // historical inputs. Live `/v2/daily-entries` transport always supplies it.
      status: value?.status === undefined ? 'confirmed' : String(value.status || ''),
    })
  }

  const rowsByStoreDate = new Map()
  for (const row of staffRows) {
    const storeId = row.storeId || row.storeKey || ''
    const date = String(row.date || '').slice(0, 10)
    if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const key = `${storeId}|${date}`
    const group = rowsByStoreDate.get(key) || []
    group.push({ ...row, participantType: participantTypeOf(row) })
    rowsByStoreDate.set(key, group)
  }

  const stableRows = []
  const substituteRows = []
  const legacyCompatibleRows = []
  const legacyUnknownRows = []
  const unresolvedDays = []
  const excludedDraftDays = []

  for (const [key, group] of rowsByStoreDate) {
    const [storeId, date] = key.split('|')
    const entry = entryByStoreDate.get(key)
    if (entry?.status === 'draft') {
      excludedDraftDays.push({ storeId, date, reason: 'DRAFT_DAILY_ENTRY' })
      continue
    }
    if (entry && entry.status !== 'confirmed') {
      unresolvedDays.push({ storeId, date, reason: 'DAILY_ENTRY_STATUS_UNKNOWN' })
      continue
    }

    const participantCount = group.filter((row) => [
      PAYROLL_PARTICIPANT_TYPES.EMPLOYEE,
      PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE,
      PAYROLL_PARTICIPANT_TYPES.LEGACY_EMPLOYEE_COMPATIBLE,
    ].includes(row.participantType)).length

    for (const row of group) {
      const base = {
        employeeId: row.employeeId || null,
        participantUserId: row.participantUserId || null,
        participantType: row.participantType,
        date,
        storeId,
        storeKey: row.storeKey || storeId,
        staffNameSnapshot: row.staffNameSnapshot || '',
        actualHours: row.actualHours == null || row.actualHours === '' ? Number.NaN : Number(row.actualHours),
        scheduledHours: Number(row.scheduledHours) || 0,
        attendanceStatus: row.attendanceStatus || 'normal',
        staffCountForShare: participantCount,
        participantCount,
        dailyRevenueCents: entry ? Math.round(entry.inc * 100) : null,
        orderCount: entry ? entry.ord : null,
        entryStatus: entry ? 'JOINED' : 'MISSING_DAILY_ENTRY',
      }
      if (row.participantType === PAYROLL_PARTICIPANT_TYPES.EMPLOYEE && row.employeeId) stableRows.push(base)
      else if (row.participantType === PAYROLL_PARTICIPANT_TYPES.NON_EMPLOYEE_SUBSTITUTE && row.participantUserId) substituteRows.push(base)
      else if (row.participantType === PAYROLL_PARTICIPANT_TYPES.LEGACY_EMPLOYEE_COMPATIBLE) legacyCompatibleRows.push({ ...base, legacy: 'REVIEWED_COMPATIBLE' })
      else legacyUnknownRows.push({ ...base, participantType: PAYROLL_PARTICIPANT_TYPES.LEGACY_UNKNOWN, legacy: 'UNRESOLVED' })
    }
    if (!entry) unresolvedDays.push({ storeId, date, participantCount, reason: 'MISSING_DAILY_ENTRY' })
  }

  for (const entry of entryByStoreDate.values()) {
    if (rowsByStoreDate.has(`${entry.storeKey}|${entry.date}`)) continue
    if (entry.status === 'draft') {
      excludedDraftDays.push({ storeId: entry.storeKey, date: entry.date, reason: 'DRAFT_DAILY_ENTRY' })
      continue
    }
    if (entry.status !== 'confirmed') {
      unresolvedDays.push({ storeId: entry.storeKey, date: entry.date, reason: 'DAILY_ENTRY_STATUS_UNKNOWN' })
      continue
    }
    if (entry.staffNames.length > 0) {
      unresolvedDays.push({ storeId: entry.storeKey, date: entry.date, reason: 'LEGACY_NAME_ONLY_ENTRY', staffNames: entry.staffNames })
    }
  }

  return {
    stableRows,
    substituteRows,
    legacyCompatibleRows,
    legacyUnknownRows,
    legacyRows: [...legacyCompatibleRows, ...legacyUnknownRows],
    unresolvedDays,
    excludedDraftDays,
  }
}
