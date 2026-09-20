#!/usr/bin/env node
import { duePayrollAuditJobs, resendPayrollAuditJob, runDuePayrollAuditJobs, runPayrollAuditJob } from '../server/payroll-audit-scheduler-core.js'

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--scheduled' || key === '--dry-run' || key === '--test-email') out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true
    else if (key.startsWith('--')) { out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i] }
  }
  return out
}

const options = args(process.argv.slice(2))
let result
if (options.scheduled) result = await runDuePayrollAuditJobs(options.at ? new Date(options.at) : new Date())
else if (options.resend) result = await resendPayrollAuditJob(options.resend, options.actorId || 'manual:developer')
else {
  const input = { reportType: options.reportType, periodStart: options.periodStart, periodEnd: options.periodEnd,
    actorId: options.actorId || 'manual:developer', email: options.dryRun ? false : true, test: options.testEmail === true,
    allowNonProduction: options.allowNonProduction === 'true' }
  result = await runPayrollAuditJob(input)
}
process.stdout.write(`${JSON.stringify(result)}\n`)
