#!/usr/bin/env node
// Existing CI runs this ordinary script from run-tests.mjs. Docker and all writes
// are confined to the hosted runner's disposable PostgreSQL 16 container.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.env.NODE_ENV, 'test', 'isolated test mode required')
assert.equal(process.env.APP_ENV, 'test', 'isolated test mode required')
assert.equal(process.env.TEST_APPROVAL_NATIVE_CI, '1', 'native test requires the hosted CI entry')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sourcePath = path.join(root, 'server', 'approvals.js')
const original = fs.readFileSync(sourcePath, 'utf8')
const databaseName = 'budu_test_approval_cas'
const container = `budu-approval-cas-${process.pid}`
const password = 'approval_cas_ephemeral_ci_only'
const port = '55432'
const databaseUrl = `postgresql://budu_test:${password}@127.0.0.1:${port}/${databaseName}`
const databaseTarget = new URL(databaseUrl)
assert.equal(databaseTarget.hostname, '127.0.0.1')
assert.equal(databaseTarget.pathname.slice(1), databaseName)
assert.notEqual(databaseName, 'budu_bj006')

function command(bin, args, { env = process.env, timeout = 180000 } = {}) {
  const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 })
  const output = `${result.stdout || ''}${result.stderr || ''}`.replaceAll(password, '[EPHEMERAL_PASSWORD_REDACTED]')
  return { status: result.status, output, error: result.error }
}

function required(bin, args, options) {
  const result = command(bin, args, options)
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status}): ${result.output.slice(-5000) || result.error?.message}`)
  return result.output.trim()
}

function replaceOnce(source, oldText, newText, label) {
  assert.equal(source.split(oldText).length, 2, `${label}: exact source anchor changed`)
  return source.replace(oldText, newText)
}

const claim = `    const claimed = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'withdrawn' },
    })
    if (claimed.count !== 1) throw httpError('单据状态已变化，请刷新后重试', 409)`
const log = `    await tx.approvalLog.create({ data: { id: \`al-\${crypto.randomUUID()}\`, requestId: request.id, action: 'withdraw', username: req.user.username, detail: '撤回申请' } })`
const oldUpdate = `    await tx.approvalRequest.update({ where: { id: request.id }, data: { status: 'withdrawn' } })`

function harness(caseName = 'ALL') {
  return command(process.execPath, ['--test', 'scripts/test-approval-withdraw-native.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      TEST_APPROVAL_DATABASE_URL: databaseUrl,
      TEST_APPROVAL_CASE: caseName,
    },
    timeout: 90000,
  })
}

let started = false
try {
  console.log(`TEST_DB_NAME=${databaseName}`)
  console.log('DB_HOST_CLASSIFICATION=localhost')
  console.log(`SCHEMA_TARGET host=127.0.0.1 database=${databaseName}`)
  required('docker', [
    'run', '--rm', '-d', '--name', container,
    '-p', `127.0.0.1:${port}:5432`,
    '-e', 'POSTGRES_USER=budu_test',
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${databaseName}`,
    'postgres:16',
  ], { timeout: 120000 })
  started = true
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = command('docker', ['exec', container, 'pg_isready', '-U', 'budu_test', '-d', databaseName])
    if (probe.status === 0) { ready = true; break }
    required('docker', ['exec', container, 'sh', '-c', 'sleep 1'])
  }
  assert.equal(ready, true, 'PostgreSQL 16 did not become ready')
  const version = required('docker', ['exec', container, 'psql', '-U', 'budu_test', '-d', databaseName, '-Atqc', 'SHOW server_version'])
  assert.match(version, /^16\./, 'native PostgreSQL major version must be 16')
  console.log(`POSTGRES_VERSION=${version}`)

  const testEnv = { ...process.env, DATABASE_URL: databaseUrl }
  required(path.join(root, 'node_modules', '.bin', 'prisma'), ['generate'], { env: testEnv })
  console.log(`SCHEMA_COMMAND=prisma migrate deploy host=127.0.0.1 database=${databaseName}`)
  required(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], { env: testEnv })

  const normal = harness()
  process.stdout.write(normal.output)
  assert.equal(normal.status, 0, 'NATIVE_PG_TESTS failed')
  console.log('NATIVE_PG_TESTS=PASS')

  const mutations = [
    {
      name: 'M1', marker: 'N1_WITHDRAW_CONFLICT',
      source: replaceOnce(original, claim, oldUpdate, 'M1 id-only update'),
    },
    {
      name: 'M2', marker: 'N1_CROSS_TABLE_LOGS',
      source: replaceOnce(
        replaceOnce(original, `  await prisma.$transaction(async (tx) => {\n${claim}`, `${log.trimStart()}\n  await prisma.$transaction(async (tx) => {\n${claim}`, 'M2 pre-CAS log'),
        `${claim}\n${log}`, claim, 'M2 remove transactional log',
      ),
    },
  ]
  for (const mutation of mutations) {
    try {
      fs.writeFileSync(sourcePath, mutation.source)
      const result = harness('N1')
      assert.notEqual(result.status, 0, `${mutation.name} unexpectedly passed`)
      assert.ok(result.output.includes(mutation.marker), `${mutation.name} failed without the expected race assertion: ${result.output.slice(-5000)}`)
      console.log(`MUTATION_${mutation.name}=PASS detected=${mutation.marker}`)
    } finally {
      fs.writeFileSync(sourcePath, original)
    }
  }
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), original, 'mutation source must be restored')
  console.log('MUTATION_SOURCE_RESTORED=YES')
} finally {
  if (fs.readFileSync(sourcePath, 'utf8') !== original) fs.writeFileSync(sourcePath, original)
  if (started) {
    const stopped = command('docker', ['rm', '-f', container], { timeout: 30000 })
    if (stopped.status !== 0) throw new Error(`ephemeral container cleanup failed: ${stopped.output.slice(-1000)}`)
    console.log('TEMP_TEST_RESOURCES_LEFT=0')
  }
}
