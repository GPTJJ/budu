import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Router } from 'express'
import { listPayrollAuditJobs } from './payroll-audit-job-store.js'
import { payrollAuditEmailConfigured } from './payroll-audit-email.js'

const exec = promisify(execFile)
export const payrollAuditAdminRouter = Router()
export const canManagePayrollAudit = (user) => Boolean(user?.id && user.status === 'active' && ['developer', 'admin'].includes(user.role))
const wrap = (fn) => async (req, res) => {
  try {
    if (!canManagePayrollAudit(req.user)) return res.status(403).json({ error: 'PAYROLL_AUDIT_FORBIDDEN' })
    await fn(req, res)
  } catch (error) {
    if (error.stderr) console.error('[payroll-audit-admin]', 'RUNNER_FAILED')
    res.status(error.code === 'PAYROLL_AUDIT_JOB_NOT_FOUND' ? 404 : 409).json({ error: error.code || 'PAYROLL_AUDIT_FAILED', message: error.message })
  }
}
const run = async (args) => {
  const { stdout } = await exec(process.execPath, ['scripts/payroll-audit-scheduler.mjs', ...args], { cwd: process.cwd(), env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(stdout)
}

payrollAuditAdminRouter.get('/payroll-audits', wrap(async (_req, res) => res.json({ rows: listPayrollAuditJobs().slice(0, 100), emailConfigured: payrollAuditEmailConfigured() })))
payrollAuditAdminRouter.post('/payroll-audits/run', wrap(async (req, res) => {
  const body = req.body || {}
  const args = ['--report-type', String(body.reportType || ''), '--period-start', String(body.periodStart || ''), '--period-end', String(body.periodEnd || ''), '--actor-id', req.user.id]
  if (body.dryRun === true) args.push('--dry-run')
  if (body.testEmail === true) args.push('--test-email')
  res.json(await run(args))
}))
payrollAuditAdminRouter.post('/payroll-audits/resend', wrap(async (req, res) => {
  res.json(await run(['--resend', String(req.body?.jobKey || ''), '--actor-id', req.user.id]))
}))
