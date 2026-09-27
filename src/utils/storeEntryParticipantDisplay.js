function dateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  return String(value || '').slice(0, 10)
}

function cleanLabel(value) {
  return String(value || '').trim()
}

/**
 * Resolve the duty-staff labels shown in StoreEntry's performance-detail list.
 *
 * Stable DailyStoreStaff rows are authoritative whenever the exact store/date
 * has at least one row. DailyEntry.staffNames remains a display-only fallback
 * after the month DSS authority is known to be loaded and exact DSS is absent.
 */
export function resolvePerformanceDutyStaff({
  monthRows,
  monthLoaded,
  storeKey,
  date,
  legacyStaffNames,
  employeeDirectory,
}) {
  if (!monthLoaded || !Array.isArray(monthRows)) {
    return { source: 'unresolved', participants: [] }
  }

  const exactRows = monthRows.filter((row) => (
    String(row?.storeKey || row?.storeId || '') === String(storeKey || '')
    && dateKey(row?.date) === dateKey(date)
  ))

  if (exactRows.length > 0) {
    const employeesById = new Map(
      (Array.isArray(employeeDirectory) ? employeeDirectory : [])
        .filter((row) => cleanLabel(row?.id))
        .map((row) => [String(row.id), row]),
    )
    return {
      source: 'dss',
      participants: exactRows.map((row, index) => {
        const employeeId = cleanLabel(row?.employeeId)
        const participantUserId = cleanLabel(row?.participantUserId)
        const identityType = row?.participantType
          || (employeeId ? 'EMPLOYEE' : participantUserId ? 'NON_EMPLOYEE_SUBSTITUTE' : 'LEGACY_UNKNOWN')
        const stableId = identityType === 'EMPLOYEE' ? employeeId : participantUserId
        const canonicalEmployeeName = employeeId ? cleanLabel(employeesById.get(employeeId)?.name) : ''
        const label = identityType === 'EMPLOYEE'
          ? canonicalEmployeeName || cleanLabel(row?.staffName) || cleanLabel(row?.staffNameSnapshot) || '—'
          : cleanLabel(row?.displayName) || cleanLabel(row?.staffName) || cleanLabel(row?.staffNameSnapshot) || '—'
        return {
          key: stableId ? `${identityType}:${stableId}` : `DSS:${cleanLabel(row?.id) || index}`,
          label,
          identityType,
          stableId,
          dssId: cleanLabel(row?.id),
          payableHoursSource: cleanLabel(row?.payableHoursSource),
        }
      }),
    }
  }

  return {
    source: 'legacy',
    participants: (Array.isArray(legacyStaffNames) ? legacyStaffNames : [])
      .map(cleanLabel)
      .filter(Boolean)
      .map((label, index) => ({
        key: `LEGACY_DISPLAY_ONLY:${index}`,
        label,
        identityType: 'LEGACY_NAME_ONLY',
        stableId: '',
        dssId: '',
        payableHoursSource: '',
      })),
  }
}
