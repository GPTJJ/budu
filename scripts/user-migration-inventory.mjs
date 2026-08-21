#!/usr/bin/env node
// V3-004A（Review 修复版）：User KV/JSON → PostgreSQL 迁移前只读事实清单（User Migration Inventory）
// 安全原则：Offline / Local Only
//   - 默认不连接任何远程服务（不读 DATABASE_URL / Upstash / KV / COS / 微信 / 支付 / Sentry）
//   - 不写源 JSON / 不修改任何数据；report 路径不得与 input 指向同一文件（realpath + symlink + inode 硬链接校验）
//   - 必须显式传入本地 JSON 输入：--input <local-json>；未传则退出并提示安全用法
//   - passwordHash 完全脱敏：任何输出（stdout/stderr/JSON/Markdown）不含 hash 的任何片段
// 用法：
//   node scripts/user-migration-inventory.mjs --input /path/to/db.json
//   node scripts/user-migration-inventory.mjs --input /path/to/db.json --report /path/to/report.md
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

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

// 确保不读取远程环境（防御性：即使父进程带生产变量也不使用；与 scripts/run-tests.mjs STRIPPED_ENV_KEYS 对齐）
for (const k of [
  // 数据库
  'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  // Upstash / KV / Redis
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN',
  // 支付
  'PAYMENT_MODE', 'ENABLE_MOCK_CALLBACK_API', 'EMAIL_NOTIFY_ENABLED',
  // COS / 对象存储
  'COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY',
  // OCR
  'TENCENT_OCR_REGION', 'TENCENT_OCR_SECRET_ID', 'TENCENT_OCR_SECRET_KEY',
  // 微信 / 企业微信
  'WXWORK_CORP_ID', 'WXWORK_AGENT_ID', 'WXWORK_SECRET',
  'WXWORK_RECV_TOKEN', 'WXWORK_RECV_AES_KEY',
  'MP_APP_ID', 'MP_APP_SECRET', 'MP_TEMPLATE_ID',
  'WECHAT_WORK_WEBHOOK_URL',
  // Sentry
  'SENTRY_DSN', 'VITE_SENTRY_DSN',
  // 其他外部服务 / 密钥
  'PUBLIC_BASE_URL', 'JWT_SECRET',
]) {
  delete process.env[k]
}

// ---------------- P0：input/report 同路径防护 ----------------
let inputReal = null
try {
  inputReal = fs.realpathSync(inputFile)
} catch {
  console.error(`无法解析输入文件路径：${inputFile}`)
  process.exit(2)
}
function resolveReal(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
if (reportFile) {
  const reportReal = resolveReal(reportFile)
  if (reportReal === inputReal) {
    console.error('拒绝执行：--report 与 --input 指向同一文件（含 symlink 解析后），会覆盖源数据')
    process.exit(2)
  }
  // 硬链接防护：不同路径但同一 inode（realpath 无法区分硬链接）；报告文件尚不存在则无需检查
  let reportStat = null
  let inputStat = null
  try {
    reportStat = fs.statSync(reportFile)
    inputStat = fs.statSync(inputFile)
  } catch {
    /* 报告文件尚不存在 */
  }
  if (reportStat && inputStat && reportStat.ino && inputStat.ino && reportStat.ino === inputStat.ino && reportStat.dev === inputStat.dev) {
    console.error('拒绝执行：--report 与 --input 为同一文件（硬链接，相同 inode），会覆盖源数据')
    process.exit(2)
  }
}

// ---------------- 常量（与当前代码一致） ----------------
// shared/accountPermissions.js ACTIVE_ROLES（六角色）
const ACTIVE_ROLES = new Set(['developer', 'admin', 'finance', 'manager', 'staff', 'cashier'])
// public 为停用角色（app.js：role === 'public' → status disabled），不属于六角色，也不属于 unknown
const PUBLIC_ROLE = 'public'
// legacy 角色（store.js loadDb 自动迁移：owner→developer, store→manager, member→staff）
const LEGACY_ROLES = new Set(['owner', 'store', 'member'])
// Prisma User Model（prisma/schema.prisma line 33-40）
const PRISMA_USER_FIELDS = {
  id: { type: 'String', required: true },
  username: { type: 'String', required: true },
  passwordHash: { type: 'String', required: true },
  role: { type: 'String', required: false, default: 'staff' },
  avatar: { type: 'String', required: false, default: "''" },
  createdAt: { type: 'DateTime', required: false, default: 'now()' },
}
// KV User 持久字段（store.js DEFAULT + loadDb 迁移 + 创建账号/更新逻辑，app.js /api/auth/register、/api/admin/users、/api/admin/users/:id/*）
const KV_PERSISTED_FIELDS = [
  'id', 'username', 'displayName', 'role', 'status', 'disabledAt',
  'storeKeys', 'staffKey', 'permissions', 'assetCenter',
  'bindingLegacyExempt', 'permissionsUpdatedAt', 'permissionsUpdatedBy',
  'passwordHash', 'secondPasswordHash', 'avatar', 'createdAt',
]
// 派生字段（实时计算、不写入记录）：bindingComplete
// 注意：bindingLegacyExempt 是持久字段（store.js loadDb 写入记录；app.js 创建/角色变更时设置），不属于派生字段
const DERIVED_FIELDS = ['bindingComplete']
// 密码哈希格式：scrypt `salt:hash`（auth.js hashPassword：32hex:128hex）
const PASSWORD_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/
// 代码生成规则：crypto.randomUUID() → UUID v4（app.js L617/L671）；读取端不解析格式，此处仅作软异常记录
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// username 真实规则：app.js 创建/改名均 trim 后要求 2-20 字符
const USERNAME_MIN_LEN = 2
const USERNAME_MAX_LEN = 20
// module 权限 key（shared/accountPermissions.js ALL_MODULE_KEYS）
const ALL_MODULE_KEYS = new Set([
  'overview', 'analysis', 'staff', 'staff-payroll',
  'store-entry', 'store-schedule', 'store-mailing', 'store-pos', 'product-center',
  'inventory-transfer', 'inventory-purchase',
  'finance', 'finance-invoice',
  'approval', 'asset-center', 'settings',
])
// User.id 外部引用（经当前代码扫描）
const ID_REFERENCE_MAP = [
  { file: 'server/auth.js', field: 'JWT payload sub', purpose: '登录令牌主体', strong: true, risk: 'JWT 30d 有效期；迁移需保持 id 不变' },
  { file: 'server/pos.js', field: 'Order.cashierId / 支付查询 where.cashierId', purpose: 'POS 收银员归属与订单查询', strong: true, risk: 'PG 字符串存储；迁移需 id 稳定' },
  { file: 'server/daily-entry-upgrade.js', field: 'DailyEntryAuditLog.operatorId', purpose: '业绩录入审计操作人', strong: true, risk: '写入 req.user.id；迁移需 id 稳定' },
  { file: 'server/v2.js', field: 'DailyEntryAuditLog.operatorId（业绩录入 v2 路由 sales_manual）', purpose: '业绩录入审计操作人（v2 统一入口）', strong: true, risk: '写入 req.user.id；迁移需 id 稳定' },
  { file: 'server/asset-center.js', field: 'AssetFile.uploaderId / userId / 操作日志', purpose: '档案上传人/访问人', strong: true, risk: '写入 req.user.id；迁移需 id 稳定' },
  { file: 'server/app.js', field: 'userPublic(id) / cookie 会话', purpose: '会话与账号管理', strong: true, risk: 'id 为账号主键，迁移必须保留原值' },
  { file: 'server/approvals.js', field: 'createdBy（未发现 req.user.id 直接引用）', purpose: '审批单据关联', strong: false, risk: '以 username/自建 id 关联，User.id 迁移影响低' },
  { file: 'server/notifications.js', field: 'target 关联（未发现 req.user.id 直接引用）', purpose: '通知接收人', strong: false, risk: '以 username/自建 id 关联，User.id 迁移影响低' },
  { file: 'server/payroll-notice.js', field: 'targetUsername（未发现 req.user.id 直接引用）', purpose: '工资条接收人', strong: false, risk: '以 username 关联，User.id 迁移影响低' },
  { file: 'src/utils/pos.js', field: 'localStorage key budu-pos:{userId}', purpose: '前端 POS 会话隔离缓存', strong: true, risk: 'id 变化会导致历史会话缓存失效（可重建）' },
]

// ---------------- 工具函数 ----------------
function isIsoString(v) {
  if (v === undefined || v === null || v === '') return { ok: true, note: 'empty' }
  const t = new Date(String(v)).getTime()
  return Number.isNaN(t) ? { ok: false, note: 'unparseable' } : { ok: true, note: 'parseable' }
}

// ---------------- 主流程 ----------------
const runId = `v3-004a-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
const timestamp = new Date().toISOString()
const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
const users = raw.users

// P0：users 必须是数组；缺失/非数组 → 明确报错 exit != 0；空数组合法
if (users === undefined) {
  console.error('输入数据缺少 users 字段（必须为数组；缺失视为数据错误，不是空数据）')
  process.exit(2)
}
if (!Array.isArray(users)) {
  console.error(`users 字段类型非法：期望 Array，实际 ${typeof users}`)
  process.exit(2)
}

const report = {
  runId,
  timestamp,
  sourceType: 'local-json',
  source: inputFile,
  sourceUserCount: users.length,
  validUsers: 0,
  invalidUsers: 0,
  invalidReasons: {},
  exactDuplicateUsernames: [],
  caseFoldCollisions: [],
  whitespaceAnomalies: [],
  typeAnomalies: [],
  duplicateIds: [],
  missingIds: [],
  malformedIds: [],
  nonUuidV4Ids: [],
  missingUsernames: [],
  usernameLengthAnomalies: [],
  missingPasswordHashes: [],
  unknownRoles: [],
  legacyRoles: [],
  publicUsers: [],
  disabledUsers: [],
  fieldPresence: {},
  idCheck: {},
  usernameCheck: {},
  passwordCheck: {},
  permissionsCheck: {},
  staffBindingCheck: {},
  storeBindingCheck: {},
  schemaGaps: [],
  idReferenceMap: ID_REFERENCE_MAP,
}

// 字段存在性统计（持久字段）
for (const f of KV_PERSISTED_FIELDS) report.fieldPresence[f] = 0

const seenExact = new Map()
const seenFold = new Map()
const seenId = new Map()
const invalidReasonsCount = {}

function invalidate(reason) {
  invalidReasonsCount[reason] = (invalidReasonsCount[reason] || 0) + 1
}

for (const u of users) {
  let userInvalid = false
  if (!u || typeof u !== 'object' || Array.isArray(u)) {
    invalidate('non-object entry')
    report.invalidUsers += 1 // 直接计入：continue 前必须落账，否则会被 validUsers 吞掉
    continue
  }
  for (const f of KV_PERSISTED_FIELDS) {
    if (u[f] !== undefined && u[f] !== null && u[f] !== '') report.fieldPresence[f] += 1
  }
  // id：存在/类型/重复
  const id = u.id
  if (id === undefined || id === null || id === '') {
    report.missingIds.push(String(u.username ?? '(no username)'))
    invalidate('missing id')
    userInvalid = true
  } else if (typeof id !== 'string') {
    report.malformedIds.push(String(id))
    invalidate('id not string')
    userInvalid = true
  } else {
    if (seenId.has(id)) {
      report.duplicateIds.push(id)
      invalidate('duplicate id')
      userInvalid = true
    }
    seenId.set(id, (seenId.get(id) || 0) + 1)
    // 代码生成规则为 UUID v4（crypto.randomUUID），读取端不解析格式；非 UUID 仅记软异常（legacy/手工数据）
    if (!UUID_V4_RE.test(id)) report.nonUuidV4Ids.push(id)
  }
  // username：存在/类型/空/空格/大小写
  const uname = u.username
  if (uname === undefined || uname === null || uname === '') {
    report.missingUsernames.push(String(id || '(no id)'))
    invalidate('missing username')
    userInvalid = true
  } else if (typeof uname !== 'string') {
    report.typeAnomalies.push({ id: String(id), username: String(uname).slice(0, 20), issue: 'username not string' })
    invalidate('username not string')
    userInvalid = true
  } else {
    if (uname !== uname.trim()) {
      report.whitespaceAnomalies.push({ id: String(id), username: `[${uname}]`, issue: 'leading/trailing whitespace' })
    }
    if (uname.length < USERNAME_MIN_LEN || uname.length > USERNAME_MAX_LEN) {
      // 创建/改名规则为 2-20 字符（app.js）；越界仅记软异常
      report.usernameLengthAnomalies.push({ id: String(id), username: `[${uname}]` })
    }
    const exactKey = uname
    const foldKey = uname.toLowerCase()
    if (seenExact.has(exactKey)) {
      report.exactDuplicateUsernames.push(uname)
      invalidate('duplicate username')
      userInvalid = true
    }
    if (seenFold.has(foldKey) && seenFold.get(foldKey) !== uname) {
      report.caseFoldCollisions.push({ a: seenFold.get(foldKey), b: uname })
    }
    seenExact.set(exactKey, uname)
    if (!seenFold.has(foldKey)) seenFold.set(foldKey, uname)
  }
  // passwordHash：存在/类型/格式
  const ph = u.passwordHash
  if (ph === undefined || ph === null || ph === '') {
    report.missingPasswordHashes.push(String(uname ?? id ?? '(no username)'))
    invalidate('missing passwordHash')
    userInvalid = true
  } else if (typeof ph !== 'string') {
    invalidate('passwordHash not string')
    userInvalid = true
  } else if (!PASSWORD_HASH_RE.test(ph)) {
    invalidate('passwordHash format invalid')
    userInvalid = true
  }
  // secondPasswordHash：可选字段；存在时按 auth.js hashPassword 格式验证（非字符串 → invalid；格式异常 → 仅记录）
  if (u.secondPasswordHash !== undefined && u.secondPasswordHash !== null && u.secondPasswordHash !== '') {
    if (typeof u.secondPasswordHash !== 'string') {
      invalidate('secondPasswordHash not string')
      userInvalid = true
    } else if (!PASSWORD_HASH_RE.test(u.secondPasswordHash)) {
      invalidate('secondPasswordHash format invalid')
    }
  }
  // role：分类（六角色 / public / legacy / unknown）
  const role = String(u.role ?? '')
  if (ACTIVE_ROLES.has(role)) {
    // 六角色，正常
  } else if (role === PUBLIC_ROLE) {
    report.publicUsers.push(String(uname ?? id ?? '(no username)'))
  } else if (LEGACY_ROLES.has(role)) {
    report.legacyRoles.push(`${uname ?? id}:${role}`)
  } else {
    report.unknownRoles.push(role || '(empty)')
    invalidate('unknown role')
    userInvalid = true
  }
  // status：public 强制 disabled；其余 active/disabled
  if (u.status === 'disabled' || role === PUBLIC_ROLE) report.disabledUsers.push(String(uname ?? id ?? '(no username)'))
  // 时间字段：真正验证可解析性（不可解析 → invalid）
  for (const tf of ['createdAt', 'disabledAt', 'permissionsUpdatedAt']) {
    if (u[tf] !== undefined && u[tf] !== null && u[tf] !== '') {
      const r = isIsoString(u[tf])
      if (!r.ok) {
        invalidate(`unparseable ${tf}`)
        userInvalid = true
      }
    }
  }
  if (userInvalid) report.invalidUsers += 1
}

report.validUsers = users.length - report.invalidUsers
report.invalidReasons = invalidReasonsCount

// 仅对象条目参与后续结构化检查（null/数组/标量条目已在主循环计为 invalid）
const objectUsers = users.filter((u) => u && typeof u === 'object' && !Array.isArray(u))

// ---------------- 密码检查（完全脱敏） ----------------
const hashSamples = objectUsers.map((u) => String(u.passwordHash ?? '')).filter(Boolean)
report.passwordCheck = {
  present: users.length - report.missingPasswordHashes.length,
  type: 'string',
  length: hashSamples.length ? Math.min(...hashSamples.map((h) => h.length)) : 0,
  formatValid: hashSamples.every((h) => PASSWORD_HASH_RE.test(h)),
  compatibleWithCurrentAuth: hashSamples.every((h) => PASSWORD_HASH_RE.test(h)),
  note: 'scrypt salt:hash（32hex:128hex）；不输出任何 hash 片段',
}

// ---------------- ID 检查（按真实代码规则：crypto.randomUUID() 生成，读取端不解析格式） ----------------
report.idCheck = {
  actualType: 'string（crypto.randomUUID() → UUID v4）',
  generation: 'app.js /api/auth/register（L617）与 /api/admin/users（L671）创建时均 crypto.randomUUID()；loadDb/requireAuth 仅按字符串比较，不解析 UUID 格式',
  stable: true,
  duplicateCount: report.duplicateIds.length,
  emptyCount: report.missingIds.length,
  malformedCount: report.malformedIds.length,
  nonUuidV4Count: report.nonUuidV4Ids.length,
  note: '不强制 UUID v4：仅存在/类型/重复判 invalid；非 UUID 格式记为软异常（nonUuidV4Ids，legacy/手工数据可能非 UUID）',
}

// ---------------- Username 检查（登录为大小写敏感精确匹配） ----------------
report.usernameCheck = {
  loginCaseSensitive: true,
  exactDuplicateCount: report.exactDuplicateUsernames.length,
  caseFoldCollisionCount: report.caseFoldCollisions.length,
  whitespaceAnomalyCount: report.whitespaceAnomalies.length,
  typeAnomalyCount: report.typeAnomalies.length,
  usernameLengthAnomalyCount: report.usernameLengthAnomalies.length,
  note: '登录为大小写敏感精确匹配（app.js u.username === username）；case-fold 冲突是迁移风险（PG @unique 大小写敏感），不等同于当前运行重复账号；创建/改名规则为 trim 后 2-20 字符（app.js）',
}

// ---------------- Permissions 检查（按 shared/accountPermissions.js normalizeAccountPermissions 结构） ----------------
const permIssues = { notObject: 0, unknownModuleKeys: [], modulesNotObject: 0, inventoryTransferAllInvalid: 0 }
for (const u of objectUsers) {
  const p = u.permissions
  if (p === undefined || p === null) continue
  if (typeof p !== 'object' || Array.isArray(p)) {
    permIssues.notObject += 1
    continue
  }
  if (p.modules !== undefined) {
    if (typeof p.modules !== 'object' || Array.isArray(p.modules)) permIssues.modulesNotObject += 1
    else {
      for (const k of Object.keys(p.modules)) {
        if (!ALL_MODULE_KEYS.has(k)) permIssues.unknownModuleKeys.push(k)
      }
    }
  }
  if (p.inventoryTransferAll !== undefined && typeof p.inventoryTransferAll !== 'boolean') permIssues.inventoryTransferAllInvalid += 1
}
report.permissionsCheck = {
  structure: 'normalizeAccountPermissions: { modules: {key:bool}, inventoryTransferAll: bool }',
  issues: permIssues,
  fixedCapabilities: {
    developer: '固定全部模块（normalizeModules 对 developer 直接全 true，不受 source 影响）',
    cashier: '固定仅 store-pos（normalizeModules 对 cashier 固定）',
    adminFinance: '默认全模块，但可按账号调整（source ? source[key] === true : defaults.has(key)）',
    managerStaff: '默认集合非全模块（manager=MANAGER_DEFAULTS 14 项，staff=去 product-center 13 项）；显式 permissions 存在时以 source[key]===true 为准',
  },
}

// ---------------- Staff Binding 检查（按真实规则：app.js validateBoundRole L366-374 / validateCashierRole L355-364） ----------------
// validateBoundRole 对 manager/staff：staffKey 必须存在、格式 storeKey::name、门店在 storeKeys 中、员工必须存在于 db.staff 主档
// 输入若为完整 db.json 导出（含 staff 数组），可真正核对员工存在性；否则标记 unverifiable
const staffMaster = Array.isArray(raw.staff) ? raw.staff : null
const staffMasterPresent = staffMaster !== null
const staffKeySet = new Set()
if (staffMasterPresent) {
  for (const s of staffMaster) {
    if (s && typeof s === 'object' && !Array.isArray(s) && typeof s.storeKey === 'string' && typeof s.name === 'string' && s.storeKey && s.name) {
      staffKeySet.add(`${s.storeKey}::${s.name}`)
    }
  }
}
const staffKeys = objectUsers.filter((u) => u.staffKey !== undefined && u.staffKey !== null && u.staffKey !== '')
const staffBindingIssues = []
const unboundManagerStaff = []
for (const u of objectUsers) {
  const role = String(u.role ?? '')
  const hasSk = u.staffKey !== undefined && u.staffKey !== null && u.staffKey !== ''
  // manager/staff 按 validateBoundRole 必须绑定员工；缺绑定属 legacy-exempt 可能态（bindingComplete=false），单列不判 issue
  if (['manager', 'staff'].includes(role) && !hasSk) {
    unboundManagerStaff.push({ id: String(u.id ?? ''), username: String(u.username ?? ''), bindingLegacyExempt: u.bindingLegacyExempt === true })
    continue
  }
  if (!hasSk) continue
  if (typeof u.staffKey !== 'string') { staffBindingIssues.push({ id: String(u.id ?? ''), issue: 'staffKey not string' }); continue }
  const sk = u.staffKey
  if (!['manager', 'staff'].includes(role)) {
    // validateCashierRole 拒绝收银绑定员工；角色变更（app.js L875）会清空非 manager/staff 的 staffKey → 存量携带即脏数据
    staffBindingIssues.push({ id: String(u.id ?? ''), issue: `staffKey 存在于 ${role || '(empty)'} 角色（真实规则仅 manager/staff 可绑定；cashier 禁止，其他角色变更时清空）` })
    continue
  }
  const [storeKey, name] = String(sk).split('::')
  if (!storeKey || !name) staffBindingIssues.push({ id: String(u.id ?? ''), issue: 'staffKey 缺少 storeKey::name 结构' })
  else if (!Array.isArray(u.storeKeys) || !u.storeKeys.includes(storeKey)) {
    staffBindingIssues.push({ id: String(u.id ?? ''), issue: 'staffKey 门店不在 storeKeys 中（validateBoundRole 规则）' })
  } else if (staffMasterPresent && !staffKeySet.has(String(sk))) {
    staffBindingIssues.push({ id: String(u.id ?? ''), issue: 'staffKey 员工不在 staff 主档（validateBoundRole：绑定员工不存在或已离职）' })
  }
}
report.staffBindingCheck = {
  count: staffKeys.length,
  format: 'staffKey = "storeKey::员工名"（名称软关联，非稳定 ID）',
  masterPresent: staffMasterPresent,
  localStaffVerifiable: staffMasterPresent,
  issues: staffBindingIssues,
  unboundManagerStaff,
  unverifiableNote: staffMasterPresent
    ? ''
    : '输入不含 staff 主档；员工是否真实存在无法核对（unverifiable，非 PASS）',
  risk: '员工重命名/门店 key 变化会导致绑定失效；Prisma User 无 staffKey 字段',
}

// ---------------- Store Binding 检查（按真实规则：validateBoundRole/validateCashierRole 门店约束） ----------------
const storeIssues = { notArray: 0, emptyArray: 0, duplicates: [], invalidValues: [] }
const storeUsers = objectUsers.filter((u) => u.storeKeys !== undefined)
for (const u of storeUsers) {
  const sk = u.storeKeys
  if (!Array.isArray(sk)) { storeIssues.notArray += 1; continue }
  if (sk.length === 0) storeIssues.emptyArray += 1
  const seen = new Set()
  for (const v of sk) {
    if (typeof v !== 'string' || !v) storeIssues.invalidValues.push(String(v).slice(0, 30))
    else if (seen.has(v)) storeIssues.duplicates.push(v)
    seen.add(v)
  }
}
report.storeBindingCheck = {
  format: 'storeKeys = string[]（KV 门店 key 引用）',
  issues: storeIssues,
  rules: {
    managerStaff: '必须绑定至少一家门店 + staffKey（validateBoundRole）',
    cashier: '必须且仅绑定一家门店、不得绑定员工（validateCashierRole）',
    developerAdminFinance: '无门店绑定要求（isSuperUser 全量）',
  },
  risk: 'Prisma User 无 storeKeys 字段；迁移后门店范围需独立设计',
}

// ---------------- Schema Gap（字段级） ----------------
const kvRuntimeShape = {
  id: 'string',
  username: 'string',
  passwordHash: 'string',
  role: 'string',
  avatar: 'string',
  createdAt: 'string (ISO)',
  displayName: 'string',
  status: 'string (active|disabled)',
  disabledAt: 'string (ISO)',
  storeKeys: 'string[]',
  staffKey: 'string (storeKey::name)',
  permissions: 'object { modules, inventoryTransferAll }',
  assetCenter: 'boolean',
  secondPasswordHash: 'string',
  permissionsUpdatedAt: 'string (ISO)',
  permissionsUpdatedBy: 'string',
  bindingLegacyExempt: 'boolean',
}
for (const [field, kvType] of Object.entries(kvRuntimeShape)) {
  const pg = PRISMA_USER_FIELDS[field]
  if (!pg) {
    report.schemaGaps.push({
      sourceField: field,
      sourceType: kvType,
      pgField: '(missing)',
      pgType: '-',
      required: '-',
      mappingStatus: 'LOST',
      risk: 'KV 字段在 Prisma User 不存在，迁移将丢失',
    })
    continue
  }
  let mappingStatus = 'OK'
  let risk = ''
  if (kvType.toLowerCase() !== pg.type.toLowerCase() && !(kvType === 'string (ISO)' && pg.type.toLowerCase() === 'datetime')) {
    mappingStatus = 'TYPE-MISMATCH'
    risk = `KV ${kvType} vs PG ${pg.type}`
  }
  report.schemaGaps.push({
    sourceField: field,
    sourceType: kvType,
    pgField: field,
    pgType: pg.type,
    required: pg.required ? 'yes' : 'no',
    mappingStatus,
    risk: risk || 'compatible',
  })
}
// 语义层 Gap
report.schemaGaps.push(
  { sourceField: 'role', sourceType: 'string (6 roles + public + legacy)', pgField: 'role', pgType: 'String', required: 'no', mappingStatus: 'SEMANTIC', risk: 'legacy(owner/store/member) 需先归一化；public 为停用语义，PG 无 status 表达' },
  { sourceField: 'status/disabledAt', sourceType: 'string', pgField: '(missing)', pgType: '-', required: '-', mappingStatus: 'LOST', risk: 'PG User 无 status 字段，停用状态迁移丢失' },
  { sourceField: 'permissions', sourceType: 'object', pgField: '(missing)', pgType: '-', required: '-', mappingStatus: 'LOST', risk: '模块授权与 inventoryTransferAll 迁移丢失' },
  { sourceField: 'storeKeys', sourceType: 'string[]', pgField: '(missing)', pgType: '-', required: '-', mappingStatus: 'LOST', risk: '门店范围迁移丢失' },
  { sourceField: 'staffKey', sourceType: 'string', pgField: '(missing)', pgType: '-', required: '-', mappingStatus: 'LOST', risk: '员工绑定（名称软关联）迁移丢失' },
  { sourceField: 'secondPasswordHash', sourceType: 'string', pgField: '(missing)', pgType: '-', required: '-', mappingStatus: 'LOST', risk: '二次密码哈希迁移丢失' },
)

// ---------------- 输出（JSON + 可选 Markdown） ----------------
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
    `- invalid users: ${report.invalidUsers}`,
    `- invalid reasons: ${JSON.stringify(report.invalidReasons)}`,
    `- exact duplicate usernames: ${report.exactDuplicateUsernames.length}`,
    `- case-fold collisions: ${report.caseFoldCollisions.length}`,
    `- whitespace anomalies: ${report.whitespaceAnomalies.length}`,
    `- duplicate ids: ${report.duplicateIds.length}`,
    `- non-UUID v4 ids: ${report.idCheck.nonUuidV4Count}`,
    `- missing ids: ${report.missingIds.length}`,
    `- missing usernames: ${report.missingUsernames.length}`,
    `- username length anomalies: ${report.usernameLengthAnomalies.length}`,
    `- missing passwordHash: ${report.missingPasswordHashes.length}`,
    `- unknown roles: ${report.unknownRoles.length}`,
    `- legacy roles: ${report.legacyRoles.length}`,
    `- public users: ${report.publicUsers.length}`,
    `- disabled users: ${report.disabledUsers.length}`,
    ``,
    `## 密码检查（完全脱敏）`,
    `- present: ${report.passwordCheck.present}`,
    `- type: ${report.passwordCheck.type}`,
    `- length: ${report.passwordCheck.length}`,
    `- formatValid: ${report.passwordCheck.formatValid}`,
    `- compatibleWithCurrentAuth: ${report.passwordCheck.compatibleWithCurrentAuth}`,
    ``,
    `## Schema Gaps`,
    report.schemaGaps.map((g) => `- **${g.sourceField}** → ${g.pgField}（${g.mappingStatus}）：${g.risk}`).join('\n'),
    ``,
    `## ID / Username / Binding 风险`,
    `- ID: ${report.idCheck.actualType}，重复 ${report.idCheck.duplicateCount}，空 ${report.idCheck.emptyCount}`,
    `- Username 大小写敏感登录；exact 重复 ${report.usernameCheck.exactDuplicateCount}，case-fold ${report.usernameCheck.caseFoldCollisionCount}`,
    `- Staff 绑定: ${report.staffBindingCheck.count} 个（masterPresent=${report.staffBindingCheck.masterPresent}，verifiable=${report.staffBindingCheck.localStaffVerifiable}）`,
    `- Store 绑定规则: ${JSON.stringify(report.storeBindingCheck.rules)}`,
    ``,
    `## User ID 外部引用`,
    report.idReferenceMap.map((r) => `- ${r.file} · ${r.field}：${r.purpose}（强关联=${r.strong}；${r.risk}）`).join('\n'),
    ``,
  ].join('\n')
  fs.writeFileSync(reportFile, md, 'utf8')
  fs.chmodSync(reportFile, 0o600) // 显式 chmod：不依赖 umask，报告仅当前用户可读写
  console.error(`\nMarkdown 报告已写入：${reportFile}（mode 0600）`)
}
