#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { previousMonthPeriod, stableAuditJson } from '../server/payroll-audit-report.js'
import { runPayrollAuditFromSnapshot } from './payroll-audit-runner.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const extractor = fs.readFileSync(path.join(root, 'scripts/payroll-audit-extract.mjs'), 'utf8')

function parseArgs(argv) {
  const parsed = {
    user: 'root', container: '', appRoot: '/app', mode: 'FINAL', scope: 'ALL',
    outputRoot: path.join(root, 'output/payroll-audits'), email: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--email') parsed.email = true
    else if (key === '--previous-month') Object.assign(parsed, previousMonthPeriod())
    else if (key.startsWith('--')) {
      const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      parsed[name] = argv[index + 1]
      index += 1
    }
  }
  return parsed
}

function extractRemote(options, digestOnly = false) {
  return new Promise((resolve, reject) => {
    const target = `${options.user}@${options.host}`
    const remote = [
      'docker', 'exec', '-i',
      '-e', `AUDIT_PERIOD_START=${options.periodStart}`,
      '-e', `AUDIT_PERIOD_END=${options.periodEnd}`,
      '-e', `AUDIT_DIGEST_ONLY=${digestOnly ? '1' : '0'}`,
      '-e', `BUDU_APP_ROOT=${options.appRoot}`,
      options.container,
      'node', '--input-type=module',
    ].join(' ')
    const child = spawn('ssh', ['-i', options.key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, remote], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Production read-only extraction failed (${code}): ${stderr.slice(0, 500)}`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('Production extraction did not return valid JSON')) }
    })
    child.stdin.end(extractor)
  })
}

export async function runRemotePayrollAudit(options) {
  for (const required of ['host', 'key', 'container', 'periodStart', 'periodEnd']) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`)
  }
  const before = await extractRemote(options, false)
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-payroll-audit-'))
  const snapshotPath = path.join(tempDirectory, 'snapshot.json')
  fs.writeFileSync(snapshotPath, JSON.stringify(before), { mode: 0o600 })
  try {
    const result = await runPayrollAuditFromSnapshot({ ...options, snapshot: snapshotPath })
    const after = await extractRemote(options, true)
    if (before.productionSha !== after.productionSha || before.authorityDigest !== after.authorityDigest || stableAuditJson(before.digests) !== stableAuditJson(after.digests)) {
      throw Object.assign(new Error('Payroll authority changed during read-only audit'), { code: 'PAYROLL_AUDIT_DIGEST_DRIFT' })
    }
    return { ...result, reconciliation: { before: before.authorityDigest, after: after.authorityDigest, noDrift: true } }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const result = await runRemotePayrollAudit(options)
  process.stdout.write(`${JSON.stringify({
    runId: result.model.runId,
    period: result.model.metadata.requestedPeriod,
    result: result.model.summary.finalResult,
    employeeCount: result.model.summary.employeeCount,
    issueCount: result.model.summary.issueCount,
    reused: result.reused,
    noDrift: result.reconciliation.noDrift,
    artifactPaths: { markdown: result.paths.markdown, pdf: result.paths.pdf, email: result.paths.email, manifest: result.paths.manifest },
  })}\n`)
}
