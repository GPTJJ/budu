#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPayrollAuditReportModel,
  previousMonthPeriod,
  renderPayrollAuditEmail,
  renderPayrollAuditHtml,
  renderPayrollAuditMarkdown,
} from '../server/payroll-audit-report.js'
import {
  auditArtifactPaths,
  loadReusableAuditRun,
  withAuditRunLock,
  writeAuditManifest,
} from '../server/payroll-audit-run-store.js'
import { renderPayrollAuditPdf } from './render-payroll-audit-pdf.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function args(argv) {
  const parsed = { mode: 'FINAL', scope: 'ALL', outputRoot: path.join(root, 'output/payroll-audits'), email: false }
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

export async function runPayrollAuditFromSnapshot(options) {
  const snapshot = typeof options.snapshot === 'string' ? JSON.parse(fs.readFileSync(options.snapshot, 'utf8')) : options.snapshot
  const period = { periodStart: options.periodStart, periodEnd: options.periodEnd }
  if (!period.periodStart || !period.periodEnd) throw new Error('periodStart and periodEnd are required')
  if (snapshot.database && snapshot.database !== 'budu_bj006' && options.allowNonProduction !== true) throw new Error('Unexpected payroll database authority')
  const model = buildPayrollAuditReportModel({
    period,
    authority: snapshot.authority,
    schedules: snapshot.schedules,
    attendanceRows: snapshot.attendanceRows,
    cardAmountCentsById: snapshot.cardAmountCentsById,
    generatedAt: snapshot.generatedAt,
    productionSha: snapshot.productionSha,
    authorityDigest: snapshot.authorityDigest,
    auditMode: options.mode || 'FINAL',
    scope: options.scope || 'ALL',
  })
  const paths = auditArtifactPaths(options.outputRoot, model)
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
  const existing = loadReusableAuditRun(paths.manifest, model.canonicalHash)
  if (existing) return { model, paths, manifest: existing, reused: true }

  return withAuditRunLock(paths.lock, async () => {
    const secondCheck = loadReusableAuditRun(paths.manifest, model.canonicalHash)
    if (secondCheck) return { model, paths, manifest: secondCheck, reused: true }
    const markdown = renderPayrollAuditMarkdown(model)
    const html = renderPayrollAuditHtml(model)
    const emailPayload = { ...renderPayrollAuditEmail(model), attachments: [paths.pdf, paths.markdown] }
    fs.writeFileSync(paths.model, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 })
    fs.writeFileSync(paths.markdown, markdown, { mode: 0o600 })
    fs.writeFileSync(paths.html, html, { mode: 0o600 })
    await renderPayrollAuditPdf(html, paths.pdf)
    fs.chmodSync(paths.pdf, 0o600)
    fs.rmSync(paths.html, { force: true })
    fs.writeFileSync(paths.email, `${JSON.stringify(emailPayload, null, 2)}\n`, { mode: 0o600 })
    const manifest = writeAuditManifest(paths, model, emailPayload)
    return { model, paths, manifest, reused: false }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = args(process.argv.slice(2))
  if (!options.snapshot) throw new Error('--snapshot is required')
  const result = await runPayrollAuditFromSnapshot(options)
  process.stdout.write(`${JSON.stringify({
    runId: result.model.runId,
    period: result.model.metadata.requestedPeriod,
    result: result.model.summary.finalResult,
    employeeCount: result.model.summary.employeeCount,
    issueCount: result.model.summary.issueCount,
    reused: result.reused,
    artifactPaths: { markdown: result.paths.markdown, pdf: result.paths.pdf, email: result.paths.email, manifest: result.paths.manifest },
    artifactHashes: result.manifest.artifacts,
  })}\n`)
}
