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
    { id: 'x1', username: 'bob', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x') },
    { id: 'x2', username: 'bob', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('y') },
  ] }))
  const out = JSON.parse(runTool(dup).stdout)
  assert.ok(out.exactDuplicateUsernames.includes('bob'))
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['duplicate username'])
})

test('case-fold collision 检测（大小写不同不算 exact duplicate）', () => {
  const cf = path.join(tmp, 'casefold.json')
  fs.writeFileSync(cf, JSON.stringify({ users: [
    { id: 'x1', username: 'Admin', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x') },
    { id: 'x2', username: 'admin', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('y') },
  ] }))
  const out = JSON.parse(runTool(cf).stdout)
  assert.equal(out.exactDuplicateUsernames.length, 0)
  assert.equal(out.caseFoldCollisions.length, 1)
  assert.equal(out.invalidUsers, 0) // case-fold 是迁移风险，不是当前运行重复
})

test('whitespace anomaly 检测', () => {
  const ws = path.join(tmp, 'ws.json')
  fs.writeFileSync(ws, JSON.stringify({ users: [
    { id: 'x1', username: ' bob ', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x') },
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

test('invalid user → invalidUsers 计数（缺 id/username/hash/unknown role/重复 id/角色门店约束）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.equal(out.invalidUsers, 6) // u-5 缺 username, u-6 缺 hash, u-7 unknown role, u-1 重复 id, u-4/u-10 staff 无门店
  assert.equal(out.validUsers, out.sourceUserCount - out.invalidUsers)
  assert.ok(out.invalidReasons['missing username'])
  assert.ok(out.invalidReasons['missing passwordHash'])
  assert.ok(out.invalidReasons['unknown role'])
  assert.ok(out.invalidReasons['duplicate id'])
  assert.ok(out.invalidReasons['manager/staff storeKeys violation'])
  assert.ok(out.invalidReasons['missing id'] === undefined || out.invalidReasons['missing id'] === 0) // 测试数据都有 id
})

test('ID reference map 输出（完整性：PaymentLog/AssetFileVersion/资产 userId/sessionStorage）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(Array.isArray(out.idReferenceMap))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('auth.js') && r.field.includes('sub')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('pos.js') && r.field.includes('cashierId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('payment-service.js') && r.field.includes('PaymentLog.cashierId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('daily-entry-upgrade.js')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('v2.js') && r.field.includes('operatorId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('asset-center.js') && r.field.includes('AssetFileVersion.uploaderId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('asset-center.js') && r.field.includes('AssetAccessGrant.userId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('asset-center.js') && r.field.includes('AssetOperationLog.userId')))
  assert.ok(out.idReferenceMap.some((r) => r.file.includes('pos.js') && r.field.includes('sessionStorage')))
})

test('bindingComplete 不在持久字段（派生）；bindingLegacyExempt 是持久字段', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(!('bindingComplete' in out.fieldPresence))
  assert.ok('bindingLegacyExempt' in out.fieldPresence) // store.js loadDb 写入记录，非派生
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

test('P0: report 为 input 的硬链接（同 inode）→ exit 2', { skip: process.platform === 'win32' }, () => {
  const link = path.join(tmp, 'db-hardlink.json')
  try {
    fs.linkSync(inputFile, link)
  } catch {
    return // 文件系统不支持硬链接则跳过
  }
  const r = runTool(inputFile, ['--report', link])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /inode/)
})

test('P0: users 含 null 条目 → exit 0、invalidUsers 计入（不崩溃不吞计数）', () => {
  const bad = path.join(tmp, 'null-entry.json')
  fs.writeFileSync(bad, JSON.stringify({ users: [
    null,
    { id: 'x1', username: 'ok', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    'not-an-object',
  ] }))
  const r = runTool(bad)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.invalidUsers, 2)
  assert.equal(out.validUsers, 1)
  assert.equal(out.invalidReasons['non-object entry'], 2)
})

test('User ID：非 UUID v4 仅记软异常，不判 invalid（代码不强制 UUID 解析）', () => {
  const f = path.join(tmp, 'ids.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'c8f1c2b0-0000-4000-8000-000000000000', username: 'uuid-user', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'legacy-1', username: 'legacy', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.deepEqual(out.nonUuidV4Ids, ['legacy-1'])
  assert.equal(out.invalidUsers, 0)
  assert.equal(out.idCheck.nonUuidV4Count, 1)
  assert.match(out.idCheck.generation, /crypto\.randomUUID/)
})

test('重复 id → 后续记录 invalid（duplicate id）', () => {
  const f = path.join(tmp, 'dup-id.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'same', username: 'a1', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'same', username: 'a2', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.deepEqual(out.duplicateIds, ['same'])
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['duplicate id'])
})

test('username 长度异常（真实规则 2-20 字符）仅记软异常', () => {
  const f = path.join(tmp, 'ulen.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 'x', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 'a'.repeat(21), role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.usernameLengthAnomalies.length, 2)
  assert.equal(out.usernameCheck.usernameLengthAnomalyCount, 2)
  assert.equal(out.invalidUsers, 0) // 异常不判 invalid（仅记录）
})

test('P0: --report 目标为已存在普通文件 → exit 2 且内容不变（排他创建）', () => {
  const exist = path.join(tmp, 'exist.md')
  fs.writeFileSync(exist, 'PRECIOUS')
  const r = runTool(inputFile, ['--report', exist])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /已存在/)
  assert.equal(fs.readFileSync(exist, 'utf8'), 'PRECIOUS') // 未被覆盖/截断
})

test('P0: --report 为 symlink（含损坏 symlink）→ exit 2 且目标不变', { skip: process.platform === 'win32' }, () => {
  const target = path.join(tmp, 'sym-target.md')
  fs.writeFileSync(target, 'TARGET')
  const link = path.join(tmp, 'sym-link.md')
  try {
    fs.symlinkSync(target, link)
  } catch {
    return
  }
  let r = runTool(inputFile, ['--report', link])
  assert.equal(r.status, 2)
  assert.equal(fs.readFileSync(target, 'utf8'), 'TARGET')
  // 损坏 symlink（指向不存在的目标）同样拒绝
  const broken = path.join(tmp, 'sym-broken.md')
  try {
    fs.symlinkSync(path.join(tmp, 'no-such-target.md'), broken)
  } catch {
    return
  }
  r = runTool(inputFile, ['--report', broken])
  assert.equal(r.status, 2)
})

test('角色约束：Cashier 多门店 → invalid（validateCashierRole）', () => {
  const f = path.join(tmp, 'cashier-multi.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 'c1', role: 'cashier', storeKeys: ['s1', 's2'], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 'c2', role: 'cashier', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['cashier storeKeys violation'])
  assert.ok(out.invalidReasons['cashier staffKey violation'] === undefined)
})

test('角色约束：Manager/Staff 无门店 → invalid（validateBoundRole）', () => {
  const f = path.join(tmp, 'mgr-nostore.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 'm1', role: 'manager', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 's1', role: 'staff', storeKeys: ['s1'], staffKey: 's1::张三', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['manager/staff storeKeys violation'])
})

test('permissions.modules 非布尔值 / inventoryTransferAll 非布尔 → invalid', () => {
  const f = path.join(tmp, 'perm-bool.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 'p1', role: 'manager', storeKeys: ['s1'], staffKey: 's1::n', status: 'active', permissions: { modules: { overview: 'yes', finance: true }, inventoryTransferAll: 1 }, passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['permissions.modules value not boolean'])
  assert.ok(out.invalidReasons['inventoryTransferAll not boolean'])
  assert.equal(out.permissionsCheck.issues.nonBooleanModuleValues, 1)
})

test('非法 status → invalid；public 必须 disabled（loadDb 语义）', () => {
  const f = path.join(tmp, 'status.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 's1', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'weird', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 'p1', role: 'public', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'x3', username: 'p2', role: 'public', storeKeys: [], staffKey: '', status: 'disabled', passwordHash: h('z'), createdAt: '2026-01-03T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.invalidUsers, 2)
  assert.ok(out.invalidReasons['invalid status'])
  assert.ok(out.invalidReasons['public role must be disabled'])
})

test('secondPasswordHash 格式错误 → invalid', () => {
  const f = path.join(tmp, 'sec-hash.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 's1', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', secondPasswordHash: 'not-a-hash', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.invalidUsers, 1)
  assert.ok(out.invalidReasons['secondPasswordHash format invalid'])
})

test('非法 JSON 输入 → exit 2 明确报错（不打印原生栈/文件内容）', () => {
  const bad = path.join(tmp, 'bad-json.json')
  fs.writeFileSync(bad, '{ not valid json')
  const r = runTool(bad)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /不是合法 JSON/)
  assert.ok(!r.stderr.includes('user-migration-inventory.mjs')) // 无原生异常栈
})

test('每账号有效权限盘点（developer/cashier 固定能力）', () => {
  const f = path.join(tmp, 'eff-perm.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 'dev', role: 'developer', storeKeys: [], staffKey: '', status: 'active', permissions: { modules: { overview: false } }, passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 'cash', role: 'cashier', storeKeys: ['s1'], staffKey: '', status: 'active', permissions: { modules: { finance: true } }, passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'x3', username: 'adm', role: 'admin', storeKeys: [], staffKey: '', status: 'active', permissions: { modules: { 'store-pos': true } }, passwordHash: h('z'), createdAt: '2026-01-03T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  const dev = out.perAccountPermissions.find((a) => a.username === 'dev')
  assert.equal(dev.effective.basis, 'fixed')
  assert.equal(dev.effective.modules.length, 16) // ALL_MODULE_KEYS
  const cash = out.perAccountPermissions.find((a) => a.username === 'cash')
  assert.equal(cash.effective.basis, 'fixed')
  assert.deepEqual(cash.effective.modules, ['store-pos'])
  const adm = out.perAccountPermissions.find((a) => a.username === 'adm')
  assert.equal(adm.effective.basis, 'stored')
  assert.deepEqual(adm.effective.modules, ['store-pos'])
})

test('accountAdminCheck：仅 developer 且未停用可管理账号', () => {
  const f = path.join(tmp, 'account-admin.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 'dev1', role: 'developer', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 'dev2', role: 'developer', storeKeys: [], staffKey: '', status: 'disabled', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'x3', username: 'adm', role: 'admin', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('z'), createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'x4', username: 'pub', role: 'public', storeKeys: [], staffKey: '', status: 'disabled', passwordHash: h('w'), createdAt: '2026-01-04T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  const byName = Object.fromEntries(out.accountAdminCheck.accounts.map((a) => [a.username, a.canManageAccounts]))
  assert.equal(byName.dev1, true)
  assert.equal(byName.dev2, false)
  assert.equal(byName.adm, false)
  assert.equal(byName.pub, false)
})

test('passwordCheck.types 反映混合 hash 类型', () => {
  const f = path.join(tmp, 'hash-types.json')
  fs.writeFileSync(f, JSON.stringify({ users: [
    { id: 'x1', username: 's1', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'x2', username: 's2', role: 'staff', storeKeys: ['s1'], staffKey: '', status: 'active', passwordHash: 12345, createdAt: '2026-01-02T00:00:00.000Z' },
  ] }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.passwordCheck.type, 'mixed')
  assert.deepEqual(out.passwordCheck.types, { string: 1, number: 1 })
  assert.equal(out.passwordCheck.formatValid, false)
})

test('staff binding：输入含 staff 主档时按真实规则核对（validateBoundRole）', () => {
  const f = path.join(tmp, 'staff-master.json')
  fs.writeFileSync(f, JSON.stringify({
    users: [
      { id: 'x1', username: 's1', role: 'staff', storeKeys: ['store-1'], staffKey: 'store-1::张三', status: 'active', passwordHash: h('x'), createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'x2', username: 's2', role: 'staff', storeKeys: ['store-1'], staffKey: 'store-1::李四', status: 'active', passwordHash: h('y'), createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'x3', username: 'm1', role: 'manager', storeKeys: ['store-1'], staffKey: '', status: 'active', passwordHash: h('z'), createdAt: '2026-01-03T00:00:00.000Z' },
      { id: 'x4', username: 'cash', role: 'cashier', storeKeys: ['store-1'], staffKey: 'store-1::张三', status: 'active', passwordHash: h('w'), createdAt: '2026-01-04T00:00:00.000Z' },
    ],
    staff: [
      { id: 'st-1', name: '张三', storeKey: 'store-1' },
      { id: 'st-2', name: '王五', storeKey: 'store-1' },
    ],
  }))
  const out = JSON.parse(runTool(f).stdout)
  assert.equal(out.staffBindingCheck.masterPresent, true)
  assert.equal(out.staffBindingCheck.localStaffVerifiable, true)
  // 李四不在主档 → issue；cashier 携带 staffKey → issue
  assert.ok(out.staffBindingCheck.issues.some((i) => /主档/.test(i.issue)))
  assert.ok(out.staffBindingCheck.issues.some((i) => /cashier/.test(i.issue)))
  // manager 未绑定员工 → 单列 legacy-exempt 可能态
  assert.ok(out.staffBindingCheck.unboundManagerStaff.some((e) => e.id === 'x3'))
})

test('secondPasswordHash 与时间字段真实验证（非字符串/不可解析 → invalid）', () => {
  const bad = path.join(tmp, 'fields.json')
  fs.writeFileSync(bad, JSON.stringify({ users: [
    { id: 'x1', username: 'f1', role: 'staff', storeKeys: [], staffKey: '', status: 'active', passwordHash: h('x'), secondPasswordHash: 123, createdAt: 'not-a-date' },
  ] }))
  const out = JSON.parse(runTool(bad).stdout)
  assert.ok(out.invalidReasons['secondPasswordHash not string'])
  assert.ok(out.invalidReasons['unparseable createdAt'])
  assert.equal(out.invalidUsers, 1)
})

test('schema gap 字段级输出（LOST / SEMANTIC / OK，含 assetCenter）', () => {
  const out = JSON.parse(runTool(inputFile).stdout)
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'storeKeys' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'permissions' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'status' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'assetCenter' && g.mappingStatus === 'LOST'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'id' && g.mappingStatus === 'OK'))
  assert.ok(out.schemaGaps.some((g) => g.sourceField === 'role' && g.mappingStatus === 'SEMANTIC'))
})

test('fake env 隔离：父进程带假凭证，stdout/stderr 不打印任何 fake 值', () => {
  const r = runTool(inputFile, [], {
    DATABASE_URL: 'postgres://fake-prod',
    UPSTASH_REDIS_REST_URL: 'https://fake-prod',
    UPSTASH_REDIS_REST_TOKEN: 'fake-secret-abc',
    KV_REST_API_URL: 'https://fake-kv',
    KV_REST_API_TOKEN: 'fake-token-xyz',
    KV_REST_API_READ_ONLY_TOKEN: 'fake-ro-token',
    COS_SECRET_KEY: 'fake-cos-key',
    TENCENT_OCR_SECRET_KEY: 'fake-ocr-key',
    WXWORK_SECRET: 'fake-wxwork-secret',
    MP_APP_SECRET: 'fake-mp-secret',
    SENTRY_DSN: 'https://fake@sentry.example/1',
    JWT_SECRET: 'fake-jwt-secret',
  })
  assert.equal(r.status, 0)
  assert.ok(!r.stdout.includes('fake-secret-abc'))
  assert.ok(!r.stdout.includes('fake-token-xyz'))
  assert.ok(!r.stdout.includes('fake-ro-token'))
  assert.ok(!r.stdout.includes('fake-cos-key'))
  assert.ok(!r.stdout.includes('fake-wxwork-secret'))
  assert.ok(!r.stdout.includes('fake-jwt-secret'))
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
