// V3-004A 只读工具测试：验证安全约束、检测项与退出码
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tool = path.join('scripts', 'user-migration-inventory.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-004a-test-'))

function runTool(inputFile, extraEnv = {}) {
  return spawnSync(process.execPath, [tool, '--input', inputFile], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  })
}

// 构造测试数据（含重复 username/id、缺失字段、未知角色、legacy 角色、停用、密码）
const sampleUsers = [
  { id: 'u-1', username: 'dev', role: 'developer', storeKeys: [], staffKey: '', status: 'active', passwordHash: 'a'.repeat(32) + ':' + 'b'.repeat(128), createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'u-2', username: 'admin1', role: 'admin', storeKeys: ['store-1'], staffKey: '', status: 'active', permissions: { modules: { 'store-pos': true }, inventoryTransferAll: false }, passwordHash: 'c'.repeat(32) + ':' + 'd'.repeat(128), createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'u-3', username: 'staff1', role: 'staff', storeKeys: ['store-1'], staffKey: 'store-1::张三', status: 'active', passwordHash: 'e'.repeat(32) + ':' + 'f'.repeat(128), createdAt: '2026-01-03T00:00:00.000Z' },
  // 重复 username（大小写冲突）
  { id: 'u-4', username: 'STAFF1', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: '1'.repeat(32) + ':' + '2'.repeat(128), createdAt: '2026-01-04T00:00:00.000Z' },
  // 重复 id
  { id: 'u-1', username: 'dup-id', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: '3'.repeat(32) + ':' + '4'.repeat(128), createdAt: '2026-01-05T00:00:00.000Z' },
  // 缺失 username
  { id: 'u-5', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: '5'.repeat(32) + ':' + '6'.repeat(128), createdAt: '2026-01-06T00:00:00.000Z' },
  // 缺失 passwordHash
  { id: 'u-6', username: 'no-hash', role: 'staff', storeKeys: [], staffKey: '', status: 'active', createdAt: '2026-01-07T00:00:00.000Z' },
  // 未知角色
  { id: 'u-7', username: 'unknown-role', role: 'superadmin', storeKeys: [], staffKey: '', status: 'active', passwordHash: '7'.repeat(32) + ':' + '8'.repeat(128), createdAt: '2026-01-08T00:00:00.000Z' },
  // legacy 角色（owner → developer 迁移）
  { id: 'u-8', username: 'legacy-owner', role: 'owner', storeKeys: [], staffKey: '', status: 'active', passwordHash: '9'.repeat(32) + ':' + '0'.repeat(128), createdAt: '2026-01-09T00:00:00.000Z' },
  // 停用 public
  { id: 'u-9', username: 'public1', role: 'public', storeKeys: [], staffKey: '', status: 'disabled', passwordHash: 'a'.repeat(32) + ':' + 'b'.repeat(128), createdAt: '2026-01-10T00:00:00.000Z' },
  // 前后空格 username
  { id: 'u-10', username: ' spaced ', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: 'c'.repeat(32) + ':' + 'd'.repeat(128), createdAt: '2026-01-11T00:00:00.000Z' },
]

const inputFile = path.join(tmp, 'db.json')
fs.writeFileSync(inputFile, JSON.stringify({ users: sampleUsers }, null, 2))

test('只读模式：不传 --input 时退出码 2 并提示安全用法', () => {
  const r = spawnSync(process.execPath, [tool], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /安全用法/)
})

test('只读模式：输入文件不存在时退出码 2', () => {
  const r = spawnSync(process.execPath, [tool, '--input', path.join(tmp, 'nope.json')], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 2)
})

test('只读模式：不访问 DATABASE_URL / Upstash（父进程带假凭证时工具仍正常运行且不报连接错误）', () => {
  const r = runTool(inputFile, {
    DATABASE_URL: 'postgres://fake-prod',
    UPSTASH_REDIS_REST_URL: 'https://fake-prod',
    UPSTASH_REDIS_REST_TOKEN: 'fake-secret',
  })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.ok(out.sourceUserCount >= 10)
})

test('不写源 JSON：运行后输入文件内容不变', () => {
  const before = fs.readFileSync(inputFile, 'utf8')
  runTool(inputFile)
  const after = fs.readFileSync(inputFile, 'utf8')
  assert.equal(before, after)
})

test('duplicate username 检测（大小写不敏感）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.duplicateUsernames.includes('STAFF1'))
})

test('duplicate id 检测', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.duplicateIds.includes('u-1'))
})

test('missing username / missing id / missing passwordHash 检测', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.missingUsernames.length >= 1)
  assert.ok(out.missingIds.length === 0) // 测试数据全部有 id
  assert.ok(out.missingPasswordHashes.some((n) => n === 'no-hash'))
})

test('unknown role 检测', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.unknownRoles.includes('superadmin'))
})

test('legacy role 检测（owner/store/member）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.legacyRoles.some((r) => r.includes('legacy-owner')))
})

test('schema gap 检测：KV 字段不在 Prisma User', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  const gap = out.schemaGaps.find((g) => g.type === 'kv-field-not-in-prisma')
  assert.ok(gap)
  assert.ok(gap.fields.includes('storeKeys'))
  assert.ok(gap.fields.includes('staffKey'))
  assert.ok(gap.fields.includes('permissions'))
  assert.ok(gap.fields.includes('status'))
  assert.ok(gap.fields.includes('displayName'))
})

test('passwordHash 脱敏：不输出完整 hash', () => {
  const raw = runTool(inputFile).stdout
  assert.ok(!raw.includes('a'.repeat(32) + ':' + 'b'.repeat(128)))
  assert.ok(!raw.includes('c'.repeat(32)))
  const out = JSON.parse(raw)
  assert.ok(out.passwordCheck.recognizedFormat === true)
  assert.match(out.passwordCheck.sample[0], /^\[scrypt-format/)
})

test('staff binding / store scope / permission mapping 风险计数', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.equal(out.staffBindingRisks[0].count, 1)
  assert.equal(out.storeScopeRisks[0].count, 2)
  assert.equal(out.permissionMappingRisks[0].count, 1)
})

test('正确 exit code：正常输入返回 0', () => {
  const r = runTool(inputFile)
  assert.equal(r.status, 0)
})

test('--report 输出 Markdown 文件', () => {
  const md = path.join(tmp, 'report.md')
  const r = spawnSync(process.execPath, [tool, '--input', inputFile, '--report', md], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.ok(fs.existsSync(md))
  const content = fs.readFileSync(md, 'utf8')
  assert.match(content, /# User Migration Inventory/)
  assert.match(content, /Schema Gaps/)
})
