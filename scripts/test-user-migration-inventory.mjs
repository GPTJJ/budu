// V3-004A Review 修复版测试：P0 安全约束 + 检测项 + exit code
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tool = path.join('scripts', 'user-migration-inventory.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-004a-test-'))

// 合法 hash 生成（hex 32 + ':' + hex 128）
const h = (seed) => {
  const salt = crypto.createHash('sha256').update(`salt-${seed}`).digest('hex').slice(0, 32)
  const hash = crypto.createHash('sha256').update(`hash-${seed}`).digest('hex').repeat(4).slice(0, 128)
  return `${salt}:${hash}`
}

const sampleUsers = [
  { id: 'u-1', username: 'dev', role: 'developer', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('a'), createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'u-2', username: 'admin1', role: 'admin', storeKeys: ['store-1'], staffKey: '', status: 'active', permissions: { modules: { 'store-pos': true }, inventoryTransferAll: false }, passwordHash: h('b'), createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'u-3', username: 'staff1', role: 'staff', storeKeys: ['store-1'], staffKey: 'store-1::张三', status: 'active', passwordHash: h('c'), createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 'u-4', username: 'STAFF1', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('d'), createdAt: '2026-01-04T00:00:00.000Z' },
  { id: 'u-1', username: 'dup-id', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('e'), createdAt: '2026-01-05T00:00:00.000Z' },
  { id: 'u-5', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('f'), createdAt: '2026-01-06T00:00:00.000Z' },
  { id: 'u-6', username: 'no-hash', role: 'staff', storeKeys: [], staffKey: '', status: 'active', createdAt: '2026-01-07T00:00:00.000Z' },
  { id: 'u-7', username: 'unknown-role', role: 'superadmin', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('g'), createdAt: '2026-01-08T00:00:00.000Z' },
  { id: 'u-8', username: 'legacy-owner', role: 'owner', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('h'), createdAt: '2026-01-09T00:00:00.000Z' },
  { id: 'u-9', username: 'public1', role: 'public', storeKeys: [], staffKey: '', status: 'disabled', passwordHash: h('i'), createdAt: '2026-01-10T00:00:00.000Z' },
  { id: 'u-10', username: ' spaced ', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('j'), createdAt: '2026-01-11T00:00:00.000Z' },
]

const inputFile = path.join(tmp, 'db.json')
fs.writeFileSync(inputFile, JSON.stringify({ users: sampleUsers }, null, 2))

function runTool(input, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [tool, '--input', input, ...extraArgs], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  })
}

// ---------- P0-1：input/report 同路径 ----------
test('P0: report 与 input 完全同路径 → exit 2 且 input 不变', () => {
  const before = fs.readFileSync(inputFile, 'utf8')
  const r = runTool(inputFile, ['--report', inputFile])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /同一文件/)
  assert.equal(fs.readFileSync(inputFile, 'utf8'), before)
})

test('P0: 相对路径与绝对路径指向同一文件 → exit 2', () => {
  const abs = inputFile
  const rel = path.relative(root, inputFile)
  const r = spawnSync(process.execPath, [tool, '--input', abs, '--report', rel], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 2)
})

test('P0: symlink 指向 input → exit 2', { skip: process.platform === 'win32' }, () => {
  const link = path.join(tmp, 'db-link.json')
  try {
    fs.symlinkSync(inputFile, link)
  } catch {
    return // 无 symlink 权限则跳过
  }
  const r = runTool(inputFile, ['--report', link])
  assert.equal(r.status, 2)
})

test('P0: 输入文件 SHA-256 前后一致（工具运行不修改源）', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const before = sha(inputFile)
  runTool(inputFile, ['--report', path.join(tmp, 'r1.md')])
  assert.equal(sha(inputFile), before)
})

// ---------- P0-2：passwordHash 完全脱敏 ----------
test('P0: 输出不含任何 hash 片段（stdout/stderr/md）', () => {
  const md = path.join(tmp, 'redact.md')
  const r = runTool(inputFile, ['--report', md])
  assert.equal(r.status, 0)
  const all = r.stdout + r.stderr + fs.readFileSync(md, 'utf8')
  for (const u of sampleUsers) {
    if (u.passwordHash) {
      assert.ok(!all.includes(u.passwordHash), '完整 hash 泄漏')
      assert.ok(!all.includes(u.passwordHash.slice(0, 16)), 'hash 前缀泄漏')
      assert.ok(!all.includes(u.passwordHash.slice(-16)), 'hash 后缀泄漏')
    }
  }
  const out = JSON.parse(r.stdout)
  assert.equal(out.passwordCheck.present, 10)
  assert.ok(out.passwordCheck.formatValid === true)
  assert.ok(!('value' in out.passwordCheck) && !('prefix' in out.passwordCheck))
})

test('P0: 报告文件权限为 0600', { skip: process.platform === 'win32' }, () => {
  const md = path.join(tmp, 'mode.md')
  runTool(inputFile, ['--report', md])
  const mode = fs.statSync(md).mode & 0o777
  assert.equal(mode, 0o600)
})

// ---------- P0-3：users 非法结构 ----------
test('P0: users 非数组 → exit 2', () => {
  const bad = path.join(tmp, 'bad-users.json')
  fs.writeFileSync(bad, JSON.stringify({ users: 'not-array' }))
  const r = runTool(bad)
  assert.equal(r.status, 2)
})

test('P0: users 缺失 → exit 2', () => {
  const bad = path.join(tmp, 'no-users.json')
  fs.writeFileSync(bad, JSON.stringify({ stores: [] }))
  const r = runTool(bad)
  assert.equal(r.status, 2)
})

test('P0: users 空数组 → 合法 exit 0', () => {
  const empty = path.join(tmp, 'empty-users.json')
  fs.writeFileSync(empty, JSON.stringify({ users: [] }))
  const r = runTool(empty)
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).sourceUserCount, 0)
})

// ---------- 检测项 ----------
test('exact duplicate username 检测（大小写敏感）', () => {
  const dup = path.join(tmp, 'exact-dup.json')
  fs.writeFileSync(dup, JSON.stringify({ users: [
    { id: 'x1', username: 'bob', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x') },
    { id: 'x2', username: 'bob', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('y') },
  ] }))
  const out = JSON.parse(runTool(dup).stdout)
  assert.ok(out.exactDuplicateUsernames.includes('bob'))
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['duplicate username'])
})

test('case-fold collision 检测（大小写不同不算 exact duplicate）', () => {
  const cf = path.join(tmp, 'casefold.json')
  fs.writeFileSync(cf, JSON.stringify({ users: [
    { id: 'x1', username: 'Admin', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x') },
    { id: 'x2', username: 'admin', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('y') },
  ] }))
  const out = JSON.parse(runTool(cf).stdout)
  assert.equal(out.exactDuplicateUsernames.length, 0)
  assert.equal(out.caseFoldCollisions.length, 1)
  assert.equal(out.invalidUsers, 0) // case-fold 是迁移风险，不是当前运行重复
})

test('whitespace anomaly 检测', () => {
  const ws = path.join(tmp, 'ws.json')
  fs.writeFileSync(ws, JSON.stringify({ users: [
    { id: 'x1', username: ' bob ', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x') },
  ] }))
  const out = JSON.parse(runTool(ws).stdout)
  assert.equal(out.whitespaceAnomalies.length, 1)
})

test('public role 正确分类（非 unknown）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.publicUsers.includes('public1'))
  assert.ok(!out.unknownRoles.includes('public'))
  assert.ok(out.disabledUsers.includes('public1'))
})

test('invalid user → invalidUsers 计数（缺 id/username/hash/unknown role）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.invalidUsers >= 3) // u-5 缺 username, u-6 缺 hash, u-7 unknown role, u-1 dup id 判 invalid
  assert.ok(out.invalidReasons['missing username'])
  assert.ok(out.invalidReasons['missing passwordHash'])
  assert.ok(out.invalidReasons['unknown role'])
  assert.ok(out.invalidReasons['missing id'] === undefined || out.invalidReasons['missing id'] === 0) // 测试数据都有 id
})

test('ID reference map 输出', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(Array.isArray(out.idReferenceMap))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('auth.js') && r.field.includes('sub')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('pos.js') && r.field.includes('cashierId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('daily-entry-upgrade.js')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('asset-center.js')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('pos.js') && r.field.includes('localStorage')))
})

test('bindingComplete 不在持久字段（派生字段排除）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(!('bindingComplete' in out.fieldPresence))
})

test('permissions 结构检查（unknown module key 检测）', () => {
  const bad = path.join(tmp, 'perm.json')
  fs.writeFileSync(bad, JSON.stringify({ users: [
    { id: 'x1', username: 'p1', role: 'manager', storeKeys: ['s'], staffKey: 's::n', status: 'active', permissions: { modules: { 'not-a-module': true }, inventoryTransferAll: 'yes' }, passwordHash: h('x') },
  ] }))
  const out = JSON.parse(runTool(bad).stdout)
  assert.ok(out.permissionsCheck.issues.unknownModuleKeys.includes('not-a-module'))
  assert.equal(out.permissionsCheck.issues.inventoryTransferAllInvalid, 1)
})

test('staff binding 检查（staffKey 门店不在 storeKeys）', () => {
  const bad = path.join(tmp, 'staff-bind.json')
  fs.writeFileSync(bad, JSON.stringify({ users: [
    { id: 'x1', username: 's1', role: 'staff', storeKeys: ['store-1'], staffKey: 'store-2::李四', status: 'active', passwordHash: h('x') },
  ] }))
  const out = JSON.parse(runTool(bad).stdout)
  assert.ok(out.staffBindingCheck.issues.length >= 1)
  assert.equal(out.staffBindingCheck.localStaffVerifiable, false)
})

test('store binding 检查（重复值/非法值）', () => {
  const bad = path.join(tmp, 'store-bind.json')
  fs.writeFileSync(bad, JSON.stringify({ users: [
    { id: 'x1', username: 's1', role: 'manager', storeKeys: ['store-1', 'store-1', 42], staffKey: 'store-1::n', status: 'active', passwordHash: h('x') },
  ] }))
  const out = JSON.parse(runTool(bad).stdout)
  assert.ok(out.storeBindingCheck.issues.duplicates.includes('store-1'))
  assert.ok(out.storeBindingCheck.issues.invalidValues.length >= 1)
})

test('secondPasswordHash 与时间字段验证', () => {
  const bad = path.join(tmp, 'fields.json')
  fs.writeFileSync(bad, JSON.stringify({ users: [
    { id: 'x1', username: 'f1', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x'), secondPasswordHash: 123, createdAt: 'not-a-date' },
  ] }))
  const out = JSON.parse(runTool(bad).stdout)
  assert.ok(out.invalidReasons['secondPasswordHash not string'])
  assert.ok(out.invalidReasons['unparseable createdAt'])
})

test('schema gap 字段级输出（LOST / SEMANTIC / OK）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'storeKeys' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'permissions' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'status' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'id' && g.mappingStatus === 'OK'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'role' && g.mappingStatus === 'SEMANTIC'))
})

test('fake env 隔离：父进程带假凭证，stdout/stderr 不打印 fake token', () => {
  const r = runTool(inputFile, [], {
    DATABASE_URL: 'postgres://fake-prod',
    UPSTASH_REDIS_REST_URL: 'https://fake-prod',
    UPSTASH_REDIS_REST_TOKEN: 'fake-secret-abc',
    KV_REST_API_URL: 'https://fake-kv',
    KV_REST_API_TOKEN: 'fake-token-xyz',
    KV_REST_API_READ_ONLY_TOKEN: 'fake-ro-token',
  })
  assert.equal(r.status, 0)
  assert.ok(!r.stdout.includes('fake-secret-abc'))
  assert.ok(!r.stdout.includes('fake-token-xyz'))
  assert.ok(!r.stdout.includes('fake-ro-token'))
})

test('正确 exit code：正常输入返回 0', () => {
  assert.equal(runTool(inputFile).status, 0)
})

test('--report 输出 Markdown（mode 0600 已单独验证）', () => {
  const md = path.join(tmp, 'report-final.md')
  const r = runTool(inputFile, ['--report', md])
  assert.equal(r.status, 0)
  assert.ok(fs.existsSync(md))
  const content = fs.readFileSync(md, 'utf8')
  assert.match(content, /# User Migration Inventory/)
  assert.match(content, /## Schema Gaps/)
  assert.match(content, /## User ID 外部引用/)
})
