import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./payroll-audit-scheduler.mjs', import.meta.url))
const common = [
  '--prepare-natural-month', '--period-start', '2026-09-01', '--period-end', '2026-09-30',
  '--actual-model', 'GPT-5.6 Sol', '--actual-reasoning', 'Medium',
  '--preparation-thread-id', 'cli-child', '--parent-review-thread-id', 'cli-parent',
]

test('actual CLI rejects explicit revision errors before extraction; omitted V1 and explicit V2 generate isolated reports', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-revision-cli-'))
  const marker = path.join(root, 'snapshot-calls.txt')
  // The actual scheduler spawns this isolated extractor from cwd. No database/client exists here.
  const snapshot = {
    generatedAt: '2026-10-01T01:00:00Z', productionSha: 'cli-fixture', authorityDigest: 'cli-fixture',
    schedules: [], attendanceRows: [], cardAmountCentsById: {},
    authority: {
      period: { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, employees: [], storeNames: {},
      result: { calculationReady: true, payroll: { employees: [] }, readiness: { employees: [] }, blockers: [] },
    },
  }
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts/payroll-audit-extract.mjs'),
    `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(marker)}, 'snapshot\\n')\nprocess.stdout.write(${JSON.stringify(JSON.stringify(snapshot))})\n`)
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  env.PAYROLL_AUDIT_DATA_DIR = path.join(root, 'data')
  const run = extra => spawnSync(process.execPath, [cli, ...common, ...extra], { cwd: root, env, encoding: 'utf8', timeout: 30000 })
  try {
    for (const [name, extra] of [
      ['trailing --revision', ['--revision']],
      ['next token is a flag', ['--revision', '--dry-run']],
      ['explicit empty string', ['--revision', '']],
      ['illegal revision/path', ['--revision', '../V2']],
      ['repeated revision ends without value', ['--revision', 'V2', '--revision']],
    ]) await t.test(name, () => {
      const result = run(extra)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /PAYROLL_AUDIT_REVISION_INVALID/)
      assert.equal(result.stdout, '')
      assert.equal(fs.existsSync(marker), false, 'snapshot extractor must not run')
      assert.equal(fs.existsSync(env.PAYROLL_AUDIT_DATA_DIR), false, 'jobs/artifacts must not be written')
    })
    let original
    await t.test('omitted flag retains default V1 and completes the actual prepare pipeline', () => {
      const result = run([])
      assert.equal(result.status, 0, result.stderr)
      original = JSON.parse(result.stdout)
      assert.equal(original.results.length, 3)
      for (const row of original.results) {
        assert.match(row.job.jobKey, /_V1:2026-09-01:2026-09-30$/)
        assert.equal(row.job.revision, undefined)
        assert.equal(row.job.emailStatus, 'NOT_SENT')
        assert.ok(fs.existsSync(row.job.artifacts.pdf))
      }
      assert.equal(fs.readFileSync(marker, 'utf8'), 'snapshot\n')
    })
    await t.test('legal V2 completes actual prepare with independent job/run/PDF identity', () => {
      const result = run(['--revision', 'V2'])
      assert.equal(result.status, 0, result.stderr)
      const revised = JSON.parse(result.stdout)
      assert.equal(revised.results.length, 3)
      for (const [i, row] of revised.results.entries()) {
        assert.match(row.job.jobKey, /_V2:2026-09-01:2026-09-30$/)
        assert.equal(row.job.revision, 'V2')
        assert.equal(row.job.emailStatus, 'NOT_SENT')
        assert.notEqual(row.job.runId, original.results[i].job.runId)
        assert.notEqual(row.job.artifacts.pdf, original.results[i].job.artifacts.pdf)
        assert.ok(fs.existsSync(row.job.artifacts.pdf))
      }
      assert.equal(fs.readFileSync(marker, 'utf8'), 'snapshot\nsnapshot\n')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
