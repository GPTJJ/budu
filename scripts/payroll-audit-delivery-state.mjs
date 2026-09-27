#!/usr/bin/env node
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { markEmailDelivery } from '../server/payroll-audit-run-store.js'

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    parsed[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[index + 1]
    index += 1
  }
  return parsed
}

export function readDeliveryState(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return {
    runId: manifest.runId,
    canonicalHash: manifest.canonicalHash,
    recipient: manifest.email.recipient,
    status: manifest.email.status,
    attempts: manifest.email.attempts.length,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (!options.manifest) throw new Error('--manifest is required')
  if (options.status) {
    if (!['SENT', 'FAILED', 'PENDING'].includes(options.status)) throw new Error('Unsupported email status')
    markEmailDelivery(options.manifest, {
      status: options.status,
      messageId: options.messageId,
      errorCode: options.errorCode,
    })
  }
  process.stdout.write(`${JSON.stringify(readDeliveryState(options.manifest))}\n`)
}
