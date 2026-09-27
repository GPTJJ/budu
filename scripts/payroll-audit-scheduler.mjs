#!/usr/bin/env node
import { duePayrollAuditJobs, resendPayrollAuditJob, runDuePayrollAuditJobs, runPayrollAuditJob } from '../server/payroll-audit-scheduler-core.js'
import { checkPayrollAuditEmailTransport, payrollAuditEmailFailureDiagnostic } from '../server/payroll-audit-email.js'

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--scheduled' || key === '--dry-run' || key === '--test-email' || key === '--email-health') out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true
    else if (key.startsWith('--')) { out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i] }
  }
  return out
}

const options = args(process.argv.slice(2))
const actualModel = options.actualModel || process.env.PAYROLL_AUDIT_ACTUAL_MODEL
const actualReasoning = options.actualReasoning || process.env.PAYROLL_AUDIT_ACTUAL_REASONING
let result
if (options.emailHealth) {
  try { result = { ok: true, ...(await checkPayrollAuditEmailTransport()) } }
  catch (error) { result = { ok: false, diagnostic: payrollAuditEmailFailureDiagnostic(error) }; process.exitCode = 1 }
} else if (options.scheduled) result = await runDuePayrollAuditJobs(options.at ? new Date(options.at) : new Date(), { actualModel, actualReasoning })
else if (options.resend) result = await resendPayrollAuditJob(options.resend, options.actorId || 'manual:developer')
else {
  const input = { reportType: options.reportType, periodStart: options.periodStart, periodEnd: options.periodEnd,
    actorId: options.actorId || 'manual:developer', email: options.dryRun ? false : true, test: options.testEmail === true,
    allowNonProduction: options.allowNonProduction === 'true', actualModel, actualReasoning }
  result = await runPayrollAuditJob(input)
}
process.stdout.write(`${JSON.stringify(result)}\n`)
