import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withAuditRunLock } from './payroll-audit-run-store.js'

export const payrollAuditDataRoot = () => process.env.PAYROLL_AUDIT_DATA_DIR
  || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'server/data'), 'payroll-audits')

const keyHash = (key) => crypto.createHash('sha256').update(key).digest('hex')
export const payrollAuditJobPath = (key) => path.join(payrollAuditDataRoot(), 'jobs', `${keyHash(key)}.json`)
export const payrollAuditJobLock = (key) => path.join(payrollAuditDataRoot(), 'locks', `${keyHash(key)}.lock`)

export function readPayrollAuditJob(key) {
  const filePath = payrollAuditJobPath(key)
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null
}

export function writePayrollAuditJob(job) {
  const filePath = payrollAuditJobPath(job.jobKey)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, filePath)
  return job
}

export function listPayrollAuditJobs() {
  const directory = path.join(payrollAuditDataRoot(), 'jobs')
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) } catch { return null }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export const withPayrollAuditJobLock = (key, fn) => withAuditRunLock(payrollAuditJobLock(key), fn)
