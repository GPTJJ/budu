// Revision is report identity only; V1 retains the historical byte/hash contract.
export const NATURAL_MONTH_TYPES = ['MONTHLY_FULL_TIME_REVIEWED', 'MONTHLY_PART_TIME', 'MONTHLY_NATURAL_SUMMARY']
export function payrollAuditRevision(value, reportType) {
  const revision = value === undefined ? 'V1' : value
  if (typeof revision !== 'string' || !/^V[1-9][0-9]{0,2}$/.test(revision)
    || (revision !== 'V1' && !NATURAL_MONTH_TYPES.includes(reportType))) {
    throw Object.assign(new Error('Invalid natural-month report revision'), { code: 'PAYROLL_AUDIT_REVISION_INVALID' })
  }
  return revision
}
export function payrollAuditRevisionFields(value, reportType) {
  const revision = payrollAuditRevision(value, reportType)
  return revision === 'V1' ? {} : { revision }
}
