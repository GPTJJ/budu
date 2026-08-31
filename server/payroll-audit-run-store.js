import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function auditArtifactPaths(root, model) {
  const month = model.metadata.requestedPeriod.start.slice(0, 7)
  const base = `budu_${month}_薪酬审查报告`
  const directory = path.join(root, model.runId)
  return {
    directory,
    model: path.join(directory, 'canonical-report-model.json'),
    markdown: path.join(directory, `${base}.md`),
    html: path.join(directory, `${base}.html`),
    pdf: path.join(directory, `${base}.pdf`),
    email: path.join(directory, 'email-payload.json'),
    manifest: path.join(directory, 'manifest.json'),
    lock: path.join(root, `${model.runId}.lock`),
  }
}

export async function withAuditRunLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  let descriptor
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Payroll audit run is already active'), { code: 'AUDIT_RUN_LOCKED' })
    throw error
  }
  try { return await fn() } finally { fs.closeSync(descriptor); fs.rmSync(lockPath, { force: true }) }
}

export function writeAuditManifest(paths, model, emailPayload) {
  const manifest = {
    runId: model.runId,
    canonicalHash: model.canonicalHash,
    period: model.metadata.requestedPeriod,
    auditMode: model.metadata.auditMode,
    productionSha: model.metadata.productionSha,
    result: model.summary.finalResult,
    employeeCount: model.summary.employeeCount,
    issueCount: model.summary.issueCount,
    artifacts: {
      model: { path: paths.model, sha256: hashFile(paths.model) },
      markdown: { path: paths.markdown, sha256: hashFile(paths.markdown) },
      pdf: { path: paths.pdf, sha256: hashFile(paths.pdf) },
    },
    email: { recipient: emailPayload.recipient, subject: emailPayload.subject, status: 'PENDING', attempts: [] },
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return manifest
}

export function markEmailDelivery(manifestPath, update) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.email.status === 'SENT' && update.status === 'SENT') return manifest
  manifest.email.attempts.push({ at: new Date().toISOString(), status: update.status, messageId: update.messageId || '', errorCode: update.errorCode || '' })
  manifest.email.status = update.status
  if (update.messageId) manifest.email.messageId = update.messageId
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return manifest
}

export function loadReusableAuditRun(manifestPath, expectedCanonicalHash) {
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.canonicalHash !== expectedCanonicalHash) return null
  for (const artifact of Object.values(manifest.artifacts || {})) {
    if (!fs.existsSync(artifact.path) || hashFile(artifact.path) !== artifact.sha256) return null
  }
  return manifest
}
