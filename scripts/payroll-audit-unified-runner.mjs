import fs from 'node:fs'

import {
  buildUnifiedMonthlyPayrollSummary,
  renderUnifiedMonthlyEmail,
  renderUnifiedMonthlyHtml,
  renderUnifiedMonthlyMarkdown,
} from '../server/payroll-audit-unified-summary.js'
import { auditArtifactPaths, loadReusableAuditRun, withAuditRunLock, writeAuditManifest } from '../server/payroll-audit-run-store.js'
import { renderPayrollAuditPdf } from './render-payroll-audit-pdf.mjs'

export async function runUnifiedSummaryFromSources(options) {
  const model = buildUnifiedMonthlyPayrollSummary(options)
  const paths = auditArtifactPaths(options.outputRoot, model)
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
  const existing = loadReusableAuditRun(paths.manifest, model.canonicalHash)
  if (existing) return { model, paths, manifest: existing, reused: true }
  return withAuditRunLock(paths.lock, async () => {
    const secondCheck = loadReusableAuditRun(paths.manifest, model.canonicalHash)
    if (secondCheck) return { model, paths, manifest: secondCheck, reused: true }
    const markdown = renderUnifiedMonthlyMarkdown(model)
    const html = renderUnifiedMonthlyHtml(model)
    const emailPayload = { ...renderUnifiedMonthlyEmail(model), attachments: [paths.pdf, paths.markdown] }
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
