#!/usr/bin/env node
// V3-004A：User KV/JSON → PostgreSQL 迁移前只读事实清单（User Migration Inventory）
// 安全原则：Offline / Local Only
//   - 默认不连接任何远程服务（不读 DATABASE_URL / Upstash / KV / COS / 微信 / 支付 / Sentry）
//   - 不写源 JSON / 不修改任何数据
//   - 必须显式传入本地 JSON 输入：--input <local-json>；未传则退出并提示安全用法
// 用法：
//   node scripts/user-migration-inventory.mjs --input /path/to/db.json
//   node scripts/user-migration-inventory.mjs --input /path/to/db.json --report /path/to/report.md
// 输出：控制台 JSON 报告（runId/timestamp/统计/gaps/风险）；可选 --report 写 Markdown 文件
import fs from 'node:fs'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const inputIdx = args.indexOf('--input')
const reportIdx = args.indexOf('--report')
const inputFile = inputIdx >= 0 ? args[inputIdx + 1] : null
const reportFile = reportIdx >= 0 ? args[reportIdx + 1] : null

// ---------------- 安全启动 ----------------
if (!inputFile) {
  console.error('安全用法：必须显式传入本地 JSON 输入文件')
  console.error('  node scripts/user-migration-inventory.mjs --input <local-json> [--report <md-file>]')
  console.error('本工具为只读：不连接 DATABASE_URL / Upstash / KV / 任何远程服务，不修改任何数据。')
  process.exit(2)
}
if (!fs.existsSync(inputFile)) {
  console.error(`输入文件不存在：${inputFile}`)
  process.exit(2)
}

// 确保不读取远程环境（防御性：即使父进程带生产变量也不使用）
for (const k of ['DATABASE_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
  delete process.env[k]
}

// ---------------- 常量（与当前代码一致） ----------------
// shared/accountPermissions.js ACTIVE_ROLES
const ACTIVE_ROLES = new Set(['developer', 'admin', 'finance', 'manager', 'staff', 'cashier'])
// public 为停用角色（app.js：role === 'public' → status disabled）
const LEGACY_ROLES = new Set(['owner', 'store', 'member'])
// Prisma User Model（prisma/schema.prisma line 33-40）
const PRISMA_USER_FIELDS = ['id', 'username', 'passwordHash', 'role', 'avatar', 'createdAt']
// KV User 已知字段（server/store.js loadDb 迁移 + server/app.js userPublic + 创建账号）
const KV_USER_FIELDS = [
  'id', 'username', 'displayName', 'role', 'status', 'disabledAt',
  'storeKeys', 'staffKey', 'permissions', 'assetCenter',
  'bindingComplete', 'bindingLegacyExempt',
  'permissionsUpdatedAt', 'permissionsUpdatedBy',
  'passwordHash', 'secondPasswordHash', 'avatar', 'createdAt',
]
// 密码哈希格式：scrypt，`salt:hash`（auth.js hashPassword，salt 32 hex + ':' + hash 128 hex）
const PASSWORD_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/

// ---------------- 工具函数 ----------------
function maskPasswordHash(h) {
  if (!h) return '(missing)'
  return `[scrypt-format ${h.length} chars] ${h.slice(0, 8)}…`
}
function isIsoOrEmpty(v) {
  if (v === undefined || v === null || v === '') return true
  return !Number.isNaN(new Date(String(v)).getTime())
}

// ---------------- 主流程 ----------------
const runId = `v3-004a-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
const timestamp = new Date().toISOString()
const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
const users = Array.isArray(raw.users) ? raw.users : []

const report = {
  runId,
  timestamp,
  sourceType: 'local-json',
  source: inputFile,
  sourceUserCount: users.length,
  validUsers: 0,
  invalidUsers: [],
  duplicateUsernames: [],
  duplicateIds: [],
  missingIds: [],
  missingUsernames: [],
  missingPasswordHashes: [],
  unknownRoles: [],
  legacyRoles: [],
  disabledUsers: [],
  fieldPresence: {},
  schemaGaps: [],
  staffBindingRisks: [],
  storeScopeRisks: [],
  permissionMappingRisks: [],
  idCheck: {},
  usernameCheck: {},
  passwordCheck: {},
  sampleMasked: [],
}

// 字段存在性统计
for (const f of KV_USER_FIELDS) report.fieldPresence[f] = 0

const seenUsername = new Map()
const seenId = new Map()
const usernameIssues = new Map()
const idIssues = new Map()
const invalid = []

for (const u of users) {
  if (!u || typeof u !== 'object') {
    invalid.push('(non-object entry)')
    continue
  }
  for (const f of KV_USER_FIELDS) {
    if (u[f] !== undefined && u[f] !== null && u[f] !== '') report.fieldPresence[f] += 1
  }
  // id
  const id = String(u.id ?? '')
  if (!id) report.missingIds.push(u.username ?? '(no username)')
  else {
    if (seenId.has(id)) report.duplicateIds.push(id)
    seenId.set(id, (seenId.get(id) || 0) + 1)
  }
  // username
  const uname = String(u.username ?? '')
  if (!uname) report.missingUsernames.push(id || '(no id)')
  else {
    const key = uname.toLowerCase()
    if (seenUsername.has(key)) {
      if (!report.duplicateUsernames.includes(uname)) report.duplicateUsernames.push(uname)
      usernameIssues.set(uname, 'duplicate (case-insensitive)')
    } else {
      seenUsername.set(key, uname)
      if (uname !== uname.trim()) usernameIssues.set(uname, 'whitespace')
    }
  }
  // passwordHash
  if (!u.passwordHash) report.missingPasswordHashes.push(uname || id)
  // role
  const role = String(u.role ?? '')
  if (!ACTIVE_ROLES.has(role) && !LEGACY_ROLES.has(role)) report.unknownRoles.push(role || '(empty)')
  if (LEGACY_ROLES.has(role)) report.legacyRoles.push(`${uname}:${role}`)
  // 停用
  if (u.status === 'disabled' || role === 'public') report.disabledUsers.push(uname || id)
}

report.validUsers = users.length - invalid.length
report.invalidUsers = invalid

// ---------------- Schema Gap ----------------
// 1. KV 有但 Prisma User 没有
const kvOnly = KV_USER_FIELDS.filter((f) => !PRISMA_USER_FIELDS.includes(f))
report.schemaGaps.push({
  type: 'kv-field-not-in-prisma',
  fields: kvOnly,
  note: 'Prisma User 仅有 id/username/passwordHash/role/avatar/createdAt；以下 KV 字段迁移时会丢失：' + kvOnly.join(', '),
})
// 2. Prisma 必填但 KV 可能为空
const prismaRequired = ['id', 'username', 'passwordHash', 'role']
const missingRequired = prismaRequired.filter((f) => {
  if (f === 'id') return report.missingIds.length > 0
  if (f === 'username') return report.missingUsernames.length > 0
  if (f === 'passwordHash') return report.missingPasswordHashes.length > 0
  if (f === 'role') return users.some((u) => !u.role)
  return false
})
if (missingRequired.length) {
  report.schemaGaps.push({ type: 'prisma-required-may-be-empty', fields: missingRequired, note: '存在 KV 用户缺少 Prisma 必填字段' })
}
// 3. role 表达差异
report.schemaGaps.push({
  type: 'role-mapping',
  note: 'KV 支持 legacy roles owner/store/member（loadDb 自动迁移为 developer/manager/staff）与 public（停用）；Prisma User.role 为 String 默认 staff。迁移需先做 legacy 归一化。',
})
// 4. permissions 表达差异
report.schemaGaps.push({
  type: 'permissions-mapping',
  note: 'KV User.permissions 为对象 { modules: {...}, inventoryTransferAll: bool }（normalizeAccountPermissions）；Prisma User 无 permissions 字段 → 迁移会丢失模块授权与库存调拨全权限。',
})
// 5. store scope / staff binding 表达差异
report.schemaGaps.push({
  type: 'store-staff-binding-mapping',
  note: 'KV User.storeKeys 为数组、staffKey 为 "storeKey::员工名" 字符串（名称软关联）；Prisma User 无 storeKeys/staffKey 字段 → 迁移会丢失门店范围与员工绑定。',
})
// 6. status / disabled 表达差异
report.schemaGaps.push({
  type: 'status-mapping',
  note: 'KV User.status = active|disabled + disabledAt，public 角色强制 disabled；Prisma User 无 status 字段 → 迁移会丢失停用状态。',
})

// ---------------- 密码检查（脱敏） ----------------
const hashSamples = users.map((u) => String(u.passwordHash ?? '')).filter(Boolean)
report.passwordCheck = {
  present: users.length - report.missingPasswordHashes.length,
  missing: report.missingPasswordHashes.length,
  recognizedFormat: hashSamples.every((h) => PASSWORD_HASH_RE.test(h)),
  sample: hashSamples.slice(0, 3).map(maskPasswordHash),
  note: 'scrypt 格式 salt:hash（32hex:128hex），与 server/auth.js hashPassword/verifyPassword 兼容',
}

// ---------------- ID 检查 ----------------
report.idCheck = {
  type: 'crypto.randomUUID() (V4 string)',
  generation: 'server/app.js 创建账号时 crypto.randomUUID()；注册同理',
  stable: true,
  duplicateCount: report.duplicateIds.length,
  emptyCount: report.missingIds.length,
  referencedBy: 'KV 软引用（createdBy 等字符串字段）；Prisma User.id 为 @id 主键；Approval/Notification/Payroll 等模块以 username 或自建 id 关联，未发现以 User.id 为外键的运行时依赖（见 CURRENT_ARCHITECTURE.md）',
}

// ---------------- Username 检查 ----------------
report.usernameCheck = {
  duplicateCount: report.duplicateUsernames.length,
  duplicates: report.duplicateUsernames.slice(0, 20),
  issues: [...usernameIssues.entries()].slice(0, 20).map(([n, i]) => ({ username: n, issue: i })),
  note: 'Prisma User.username 为 @unique（大小写敏感）；KV 无唯一约束。迁移前需处理大小写冲突与空格。',
}

// ---------------- Staff Binding 风险 ----------------
const staffBound = users.filter((u) => u.staffKey)
report.staffBindingRisks.push({
  count: staffBound.length,
  format: 'staffKey = "storeKey::员工名"（名称软关联，非稳定 ID）',
  risk: '员工重命名/门店 key 变化会导致绑定失效；Prisma User 无 staffKey 字段，迁移需独立设计员工外键',
})

// ---------------- Store Scope 风险 ----------------
const storeBound = users.filter((u) => Array.isArray(u.storeKeys) && u.storeKeys.length > 0)
report.storeScopeRisks.push({
  count: storeBound.length,
  format: 'storeKeys = string[]（KV 门店 key 引用）',
  risk: 'Prisma User 无 storeKeys 字段；迁移后门店范围需通过关联表或 User 扩展字段表达，本轮只记录',
})

// ---------------- Permission Mapping 风险 ----------------
const withPerms = users.filter((u) => u.permissions && typeof u.permissions === 'object')
report.permissionMappingRisks.push({
  count: withPerms.length,
  format: 'permissions = { modules: {...}, inventoryTransferAll: bool }',
  risk: 'Prisma User 无 permissions 字段；迁移会丢失模块授权与库存调拨全权限（hasInventoryTransferAll）',
})

// ---------------- 输出 ----------------
const output = JSON.stringify(report, null, 2)
console.log(output)

if (reportFile) {
  const md = [
    `# User Migration Inventory（V3-004A）`,
    ``,
    `- runId: ${report.runId}`,
    `- timestamp: ${report.timestamp}`,
    `- source: ${report.source}`,
    `- source user count: ${report.sourceUserCount}`,
    ``,
    `## 统计`,
    `- valid users: ${report.validUsers}`,
    `- invalid users: ${report.invalidUsers.length}`,
    `- duplicate usernames: ${report.duplicateUsernames.length}`,
    `- duplicate ids: ${report.duplicateIds.length}`,
    `- missing ids: ${report.missingIds.length}`,
    `- missing usernames: ${report.missingUsernames.length}`,
    `- missing passwordHash: ${report.missingPasswordHashes.length}`,
    `- unknown roles: ${report.unknownRoles.length}`,
    `- legacy roles: ${report.legacyRoles.length}`,
    `- disabled users: ${report.disabledUsers.length}`,
    ``,
    `## Schema Gaps`,
    report.schemaGaps.map((g) => `- **${g.type}**：${g.note}`).join('\n'),
    ``,
    `## 密码检查（脱敏）`,
    `- 格式识别: ${report.passwordCheck.recognizedFormat}`,
    `- 样例: ${report.passwordCheck.sample.join(', ')}`,
    ``,
    `## ID / Username / Binding 风险`,
    `- ID: ${report.idCheck.type}，重复 ${report.idCheck.duplicateCount}，空 ${report.idCheck.emptyCount}`,
    `- Username 重复: ${report.usernameCheck.duplicateCount}`,
    `- Staff 绑定: ${report.staffBindingRisks[0].count} 个（名称软关联）`,
    `- Store 绑定: ${report.storeScopeRisks[0].count} 个`,
    `- 权限对象: ${report.permissionMappingRisks[0].count} 个`,
    ``,
  ].join('\n')
  fs.writeFileSync(reportFile, md, 'utf8')
  console.error(`\nMarkdown 报告已写入：${reportFile}`)
}
