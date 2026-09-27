#!/usr/bin/env node
// V3-004A（Review 修复版）：User KV/JSON → PostgreSQL 迁移前只读事实清单（User Migration Inventory）
// 安全原则：Offline / Local Only
//   - 默认不连接任何远程服务（不读 DATABASE_URL / Upstash / KV / COS / 微信 / 支付 / Sentry）
//   - 不写源 JSON / 不修改任何数据；report 路径不得与 input 指向同一文件（realpath + symlink + inode 硬链接校验）
//   - report 目标已存在（普通文件/symlink/硬链接/目录）即拒绝：排他创建（flag 'wx' + mode 0600），绝不覆盖/截断/改权限
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
  'inventory-transfer', 'inventory-purchase', 'partner-supply', 'product-material-management',
  'finance', 'finance-invoice',
  'approval', 'asset-center', 'settings',
])
// storeKey 真实规则：app.js normalizeStoreKeys（L541-553）元素 String(k||'').trim() 后非空、≤30 字符、不重复；
// store 创建路径（L103/L1124）另拒绝 __proto__/constructor/prototype
const STORE_KEY_MAX_LEN = 30
const BAD_STORE_KEY_RE = /^(__proto__|constructor|prototype)$/
// 角色默认模块集（复现 shared/accountPermissions.js defaultModuleKeys / MANAGER_DEFAULTS / STAFF_DEFAULTS）
const MODULE_STORE_POS = 'store-pos'
const MODULE_ASSET_CENTER = 'asset-center'
const MANAGER_DEFAULTS = [
  'overview', 'analysis', 'staff', 'staff-payroll',
  'store-entry', 'store-schedule', 'store-mailing', 'store-pos',
  'product-center', 'inventory-transfer', 'inventory-purchase', 'partner-supply', 'product-material-management',
  'finance-invoice', 'approval', 'settings',
]
const STAFF_DEFAULTS = MANAGER_DEFAULTS.filter((k) => k !== 'product-center')
const SUPER_ROLES = new Set(['developer', 'finance', 'admin'])
/** 复现 defaultModuleKeys(role, legacyAssetCenter)（shared/accountPermissions.js L79-85） */
function defaultModuleKeys(role, legacyAssetCenter) {
  if (role === 'developer' || role === 'admin' || role === 'finance') return [...ALL_MODULE_KEYS]
  if (role === 'cashier') return [MODULE_STORE_POS]
  const base = role === 'manager' ? [...MANAGER_DEFAULTS] : role === 'staff' ? [...STAFF_DEFAULTS] : []
  if (legacyAssetCenter && !base.includes(MODULE_ASSET_CENTER)) base.push(MODULE_ASSET_CENTER)
  return base
}
/** 复现 normalizeModules + hasModuleAccess 的账号级有效模块集（shared/accountPermissions.js L87-109）
 * 真实语义：source ? source[key] === true : defaults.has(key)
 * - 存在合法 permissions.modules source → 保留存储值；对上线后新增且旧记录尚无键的模块按角色默认补齐
 * - 无 source → 才使用 defaultModuleKeys(role, legacyAssetCenter) 默认集
 * - developer / cashier 固定（normalizeModules 对二者不看 source）
 */
function runtimeEffectiveModules(u) {
  const role = String(u.role ?? '')
  const status = u.status || (role === PUBLIC_ROLE ? 'disabled' : 'active') // loadDb 补全语义
  if (status === 'disabled' || role === PUBLIC_ROLE) return { modules: [], basis: 'disabled' }
  if (role === 'developer') return { modules: [...ALL_MODULE_KEYS], basis: 'fixed-all' }
  if (role === 'cashier') return { modules: [MODULE_STORE_POS], basis: 'fixed-pos' }
  if (!ACTIVE_ROLES.has(role)) return { modules: [], basis: 'unknown-role' }
  const p = u.permissions && typeof u.permissions === 'object' && !Array.isArray(u.permissions) ? u.permissions : null
  const source = p && p.modules && typeof p.modules === 'object' && !Array.isArray(p.modules) ? p.modules : null
  if (source) {
    const legacyDefaultKeys = new Set(['partner-supply', 'product-material-management'])
    const defaults = new Set(defaultModuleKeys(role, u.assetCenter === true))
    const modules = [...ALL_MODULE_KEYS].filter((key) => source[key] === true || (legacyDefaultKeys.has(key) && !Object.prototype.hasOwnProperty.call(source, key) && defaults.has(key)))
    return { modules, basis: 'stored' }
  }
  const defaults = defaultModuleKeys(role, u.assetCenter === true)
  return { modules: [...ALL_MODULE_KEYS].filter((key) => defaults.includes(key)), basis: 'defaults' }
}
/** 复现 hasInventoryTransferAll（shared/accountPermissions.js L119-127）：isSuperUser 或存储值；disabled/public 恒 false */
function runtimeInventoryTransferAll(u) {
  const role = String(u.role ?? '')
  const status = u.status || (role === PUBLIC_ROLE ? 'disabled' : 'active')
  if (status === 'disabled' || role === PUBLIC_ROLE) return false
  const p = u.permissions && typeof u.permissions === 'object' && !Array.isArray(u.permissions) ? u.permissions : null
  const stored = Boolean(p && p.inventoryTransferAll === true)
  return (SUPER_ROLES.has(role) || stored)
}
/** 复现 canManageAccounts（shared/accountPermissions.js L134-136）：仅 developer 且 status !== disabled */
function runtimeCanManageAccounts(u) {
  const role = String(u.role ?? '')
  const status = u.status || (role === PUBLIC_ROLE ? 'disabled' : 'active')
  return role === 'developer' && status !== 'disabled'
}
// User.id 外部引用（经当前代码重扫；hardOrSoftReference：hard=直接存 User.id，soft=存 username/自建键）
const ID_REFERENCE_MAP = [
  // ---- hard：直接写入/关联 User.id ----
  { sourceFile: 'server/auth.js', entity: 'JWT token', field: 'sub', usage: '登录令牌主体（signToken { sub: user.id }；requireAuth 按 payload.sub 定位账号）', hardOrSoftReference: 'hard', migrationRisk: 'JWT 30d 有效期；迁移必须保持 id 不变' },
  { sourceFile: 'server/pos.js', entity: 'Order (PG orders)', field: 'cashierId', usage: 'POS 收银员归属与订单查询（写 req.user.id）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/payments/payment-service.js', entity: 'PaymentLog (PG payment_logs)', field: 'cashierId', usage: '支付流水收银员（从 order.cashierId 拷贝）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/daily-entry-upgrade.js', entity: 'DailyEntryAuditLog (PG daily_entry_audit_logs)', field: 'operatorId', usage: '业绩录入审计操作人（写 req.user.id）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/v2.js', entity: 'DailyEntryAuditLog (PG daily_entry_audit_logs)', field: 'operatorId', usage: '业绩录入 v2 路由审计操作人（sales_manual，写 req.user.id）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/asset-center.js', entity: 'AssetFileVersion (PG asset_file_versions)', field: 'uploaderId', usage: '档案版本上传人（写 req.user.id）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/asset-center.js', entity: 'AssetAccessGrant (PG asset_access_grants)', field: 'userId', usage: '档案授权账号（写 req.user.id，@unique）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/asset-center.js', entity: 'AssetOperationLog (PG asset_operation_logs)', field: 'userId', usage: '档案操作账号（写 user.id）', hardOrSoftReference: 'hard', migrationRisk: 'PG 字符串存储；迁移需 id 稳定' },
  { sourceFile: 'server/app.js', entity: 'cookie 会话 / 账号管理路由', field: 'sub（JWT）/ :id', usage: '登录态会话；账号管理按 id 定位目标账号', hardOrSoftReference: 'hard', migrationRisk: 'id 为账号主键，迁移必须保留原值' },
  { sourceFile: 'src/utils/userData.js', entity: 'localStorage', field: 'MIRROR_OWNER_KEY（budu-os-cloud-mirror-owner-v1）', usage: '云端数据镜像 ownership key（值=userId，防止切换账号串显上一账号数据）', hardOrSoftReference: 'hard', migrationRisk: 'id 变化导致镜像归属失效（可重建）' },
  { sourceFile: 'src/utils/pos.js', entity: 'sessionStorage', field: 'budu-pos:{userId} 系列 key', usage: 'POS 会话/购物车用户隔离缓存（sessionStorage）', hardOrSoftReference: 'hard', migrationRisk: 'id 变化导致历史会话缓存失效（可重建）' },
  { sourceFile: 'src/components/PosPage.jsx', entity: 'sessionStorage', field: 'budu-pos-products:{userId}（productsCacheKey L29）', usage: 'POS 商品缓存用户隔离（读/写 sessionStorage）', hardOrSoftReference: 'hard', migrationRisk: 'id 变化导致商品缓存失效（可重建）' },
  // ---- soft：username 软引用（User.id 迁移影响低，username 必须保持唯一） ----
  { sourceFile: 'server/approvals.js', entity: 'ApprovalRequest (PG approval_requests)', field: 'submitterUsername', usage: '审批单提交人（req.user.username）', hardOrSoftReference: 'soft', migrationRisk: 'username 关联；改名后历史单据归属变化' },
  { sourceFile: 'server/approvals.js', entity: 'ApprovalNode (PG approval_nodes)', field: 'approverUsername', usage: '审批节点审批人（按 username 匹配）', hardOrSoftReference: 'soft', migrationRisk: 'username 关联；改名后待办匹配失效' },
  { sourceFile: 'server/approvals.js', entity: 'ApprovalCc (PG approval_ccs)', field: 'ccUsername', usage: '审批抄送人', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/approvals.js', entity: 'ApprovalComment (PG approval_comments)', field: 'username', usage: '审批意见作者（userRole 一并快照）', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/approvals.js', entity: 'ApprovalLog (PG approval_logs)', field: 'username', usage: '审批操作日志操作人', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/approvals.js', entity: 'ApprovalNotification (PG approval_notifications)', field: 'username', usage: '审批通知接收人', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/approvals.js', entity: 'ApprovalAttachment (PG approval_attachments)', field: 'uploaderUsername', usage: '审批附件上传人', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/notifications.js', entity: 'Notification (PG notifications)', field: 'username', usage: '站内通知接收人（target 为业务跳转目标，非用户引用）', hardOrSoftReference: 'soft', migrationRisk: 'username 关联；改名后通知归属变化' },
  { sourceFile: 'server/wechat-bind.js', entity: 'WechatBinding (PG wechat_bindings)', field: 'username', usage: '微信/企微绑定账号（@unique [username, channel]）', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/payroll-notice.js', entity: 'PayrollNotice (PG payroll_notices)', field: 'targetUsername', usage: '工资条接收人', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
  { sourceFile: 'server/pos.js', entity: 'Order (PG orders)', field: 'cashierNameSnapshot', usage: '收银员姓名快照（req.user.username）', hardOrSoftReference: 'soft', migrationRisk: '快照，无关联性' },
  { sourceFile: 'server/daily-entry-upgrade.js', entity: 'DailyEntryAuditLog', field: 'operatorName', usage: '操作人姓名快照（req.user.username）', hardOrSoftReference: 'soft', migrationRisk: '快照，无关联性' },
  { sourceFile: 'server/asset-center.js', entity: 'AssetFile (PG asset_files)', field: 'createdBy / updatedBy', usage: '档案创建/更新人（req.user.username）', hardOrSoftReference: 'soft', migrationRisk: 'username 关联' },
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
let raw
try {
  raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
} catch (err) {
  // 明确、脱敏的输入错误：不打印文件内容与原生异常栈
  console.error(`输入文件不是合法 JSON（${inputFile}）：${err.message}`)
  process.exit(2)
}
// P0：根节点必须是 plain object（null / 数组 / 字符串 / 数字 / 布尔 一律拒绝）
if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
  console.error('Invalid input structure: root must be an object.')
  process.exit(2)
}
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
  perAccountPermissions: [],
  accountValidations: [],
  accountAdminCheck: {},
  persistenceNotes: [],
  idReferenceMap: ID_REFERENCE_MAP,
}

// 字段存在性统计（持久字段）
for (const f of KV_PERSISTED_FIELDS) report.fieldPresence[f] = 0

const seenExact = new Map()
const seenFold = new Map()
const seenId = new Map()
const invalidReasonsCount = {}
const warningReasonsCount = {}
// permissions 问题计数（在主循环内累积，严重结构错误同时判 invalid）
const permIssues = { notObject: 0, unknownModuleKeys: [], modulesNotObject: 0, nonBooleanModuleValues: 0, inventoryTransferAllInvalid: 0 }

function invalidate(reason) {
  invalidReasonsCount[reason] = (invalidReasonsCount[reason] || 0) + 1
}
function warn(reason) {
  warningReasonsCount[reason] = (warningReasonsCount[reason] || 0) + 1
}

// stores / staff 主档准备（输入为完整 db.json 导出时可用；缺失 → unverifiable）
const storeMaster = Array.isArray(raw.stores) ? raw.stores : null
const storeMasterKeys = new Set()
if (storeMaster) {
  for (const s of storeMaster) {
    if (s && typeof s === 'object' && !Array.isArray(s) && typeof s.key === 'string' && s.key.trim()) {
      storeMasterKeys.add(s.key.trim())
    }
  }
}
const storeMasterPresent = storeMaster !== null
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
// staffKey 分类统计（bound / legacyExempt / unboundInvalid）
const staffKeyCategories = { bound: [], legacyExempt: [], unboundInvalid: [] }

const accountValidations = []

for (const u of users) {
  const accountErrors = []
  const accountWarnings = []
  const pushError = (reason) => {
    invalidate(reason)
    accountErrors.push(reason)
  }
  const pushWarn = (reason) => {
    warn(reason)
    accountWarnings.push(reason)
  }
  if (!u || typeof u !== 'object' || Array.isArray(u)) {
    pushError('non-object entry')
    accountValidations.push({ id: null, username: '(non-object entry)', valid: false, errors: accountErrors, warnings: accountWarnings })
    continue
  }
  for (const f of KV_PERSISTED_FIELDS) {
    if (u[f] !== undefined && u[f] !== null && u[f] !== '') report.fieldPresence[f] += 1
  }
  // id：存在/类型/重复
  const id = u.id
  if (id === undefined || id === null || id === '') {
    report.missingIds.push(String(u.username ?? '(no username)'))
    pushError('missing id')
  } else if (typeof id !== 'string') {
    report.malformedIds.push(String(id))
    pushError('id not string')
  } else {
    if (seenId.has(id)) {
      report.duplicateIds.push(id)
      pushError('duplicate id')
    }
    seenId.set(id, (seenId.get(id) || 0) + 1)
    // 代码生成规则为 UUID v4（crypto.randomUUID），读取端不解析格式；非 UUID 仅记软异常（legacy/手工数据）
    if (!UUID_V4_RE.test(id)) {
      report.nonUuidV4Ids.push(id)
      pushWarn('non-UUID v4 id')
    }
  }
  // username：存在/类型/空/空格/大小写
  const uname = u.username
  if (uname === undefined || uname === null || uname === '') {
    report.missingUsernames.push(String(id || '(no id)'))
    pushError('missing username')
  } else if (typeof uname !== 'string') {
    report.typeAnomalies.push({ id: String(id), username: String(uname).slice(0, 20), issue: 'username not string' })
    pushError('username not string')
  } else {
    if (uname !== uname.trim()) {
      report.whitespaceAnomalies.push({ id: String(id), username: `[${uname}]`, issue: 'leading/trailing whitespace' })
      pushWarn('username whitespace anomaly')
    }
    if (uname.length < USERNAME_MIN_LEN || uname.length > USERNAME_MAX_LEN) {
      // 创建/改名规则为 2-20 字符（app.js）；越界仅记软异常
      report.usernameLengthAnomalies.push({ id: String(id), username: `[${uname}]` })
      pushWarn('username length anomaly')
    }
    const exactKey = uname
    const foldKey = uname.toLowerCase()
    if (seenExact.has(exactKey)) {
      report.exactDuplicateUsernames.push(uname)
      pushError('duplicate username')
    }
    if (seenFold.has(foldKey) && seenFold.get(foldKey) !== uname) {
      report.caseFoldCollisions.push({ a: seenFold.get(foldKey), b: uname })
      pushWarn('case-fold collision')
    }
    seenExact.set(exactKey, uname)
    if (!seenFold.has(foldKey)) seenFold.set(foldKey, uname)
  }
  // passwordHash：存在/类型/格式
  const ph = u.passwordHash
  if (ph === undefined || ph === null || ph === '') {
    report.missingPasswordHashes.push(String(uname ?? id ?? '(no username)'))
    pushError('missing passwordHash')
  } else if (typeof ph !== 'string') {
    pushError('passwordHash not string')
  } else if (!PASSWORD_HASH_RE.test(ph)) {
    pushError('passwordHash format invalid')
  }
  // secondPasswordHash：可选字段；存在时按 auth.js hashPassword 格式验证（非字符串/格式错误 → invalid）
  if (u.secondPasswordHash !== undefined && u.secondPasswordHash !== null && u.secondPasswordHash !== '') {
    if (typeof u.secondPasswordHash !== 'string') {
      pushError('secondPasswordHash not string')
    } else if (!PASSWORD_HASH_RE.test(u.secondPasswordHash)) {
      pushError('secondPasswordHash format invalid')
    }
  }
  // permissions：结构与值类型（normalizeAccountPermissions 语义；严重结构错误 → invalid）
  const p = u.permissions
  if (p !== undefined && p !== null && p !== '') {
    if (typeof p !== 'object' || Array.isArray(p)) {
      permIssues.notObject += 1
      pushError('permissions not object')
    } else {
      if (p.modules !== undefined && p.modules !== null && p.modules !== '') {
        if (typeof p.modules !== 'object' || Array.isArray(p.modules)) {
          permIssues.modulesNotObject += 1
          pushError('permissions.modules not object')
        } else {
          for (const [k, v] of Object.entries(p.modules)) {
            if (!ALL_MODULE_KEYS.has(k)) {
              permIssues.unknownModuleKeys.push(k)
              pushWarn('unknown module key') // normalizeModules 会忽略未知 key，不进入 effective modules
            }
            if (typeof v !== 'boolean') {
              permIssues.nonBooleanModuleValues += 1
              pushError('permissions.modules value not boolean')
            }
          }
        }
      }
      if (p.inventoryTransferAll !== undefined && p.inventoryTransferAll !== null && p.inventoryTransferAll !== '') {
        if (typeof p.inventoryTransferAll !== 'boolean') {
          permIssues.inventoryTransferAllInvalid += 1
          pushError('inventoryTransferAll not boolean')
        }
      }
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
    pushError('unknown role')
  }
  // status：真实取值 active|disabled（app.js 创建 'active'；store.js loadDb 对 public 强制 'disabled'）
  if (u.status !== undefined && u.status !== null && u.status !== '') {
    if (!['active', 'disabled'].includes(u.status)) {
      pushError('invalid status')
    } else if (role === PUBLIC_ROLE && u.status !== 'disabled') {
      pushError('public role must be disabled')
    }
  }
  if (u.status === 'disabled' || role === PUBLIC_ROLE) report.disabledUsers.push(String(uname ?? id ?? '(no username)'))
  // storeKeys 结构与元素校验（真实规则：app.js normalizeStoreKeys L541-553；元素必须 string、trim 非空、
  // ≤30 字符、不重复、数量 ≤50；store 创建路径另拒绝 __proto__/constructor/prototype）—— 对所有账号执行
  const storeKeysVal = u.storeKeys
  let skValid = { ok: false, keys: [] }
  if (storeKeysVal === undefined || storeKeysVal === null || storeKeysVal === '') {
    skValid = { ok: true, keys: [] } // loadDb 会补 []，视为空数组
  } else if (!Array.isArray(storeKeysVal)) {
    pushError('storeKeys not array')
  } else if (storeKeysVal.length > 50) {
    pushError('too many storeKeys') // normalizeStoreKeys：raw.length > 50 → 整体拒绝
  } else {
    const seen = new Set()
    const keys = []
    let structOk = true
    for (const v of storeKeysVal) {
      if (typeof v !== 'string') {
        pushError('storeKeys element not string')
        structOk = false
        break
      }
      const t = v.trim()
      if (!t) {
        pushError('empty storeKey')
        structOk = false
        break
      }
      if (t.length > STORE_KEY_MAX_LEN || BAD_STORE_KEY_RE.test(t)) {
        pushError('storeKey format invalid')
        structOk = false
        break
      }
      if (seen.has(t)) {
        pushError('duplicate storeKeys')
        structOk = false
        break
      }
      seen.add(t)
      keys.push(t)
    }
    if (structOk) skValid = { ok: true, keys }
  }
  // 角色门店硬约束（validateBoundRole / validateCashierRole 语义，基于有效 storeKeys）
  if (role === 'cashier') {
    if (skValid.ok && skValid.keys.length !== 1) {
      pushError('cashier storeKeys violation')
    }
    if (u.staffKey !== undefined && u.staffKey !== null && u.staffKey !== '') {
      pushError('cashier staffKey violation')
    }
  } else if (role === 'manager' || role === 'staff') {
    if (skValid.ok && skValid.keys.length < 1) {
      pushError('manager/staff storeKeys violation')
    }
  }
  // stores 主档存在性核验（输入含 stores 时逐 key 核对；缺失 → unverifiable，不判 invalid）
  if (skValid.ok && skValid.keys.length > 0 && storeMasterPresent) {
    for (const k of skValid.keys) {
      if (!storeMasterKeys.has(k)) {
        pushError('storeKey not in stores master')
      }
    }
  }
  // staffKey 统一规则（manager/staff）——分类互斥：任何相关 ERROR（含 storeKeys 结构/数量）都不得进入 bound
  if (role === 'manager' || role === 'staff') {
    const hasSk = u.staffKey !== undefined && u.staffKey !== null && u.staffKey !== ''
    if (hasSk) {
      let skOk = true
      if (typeof u.staffKey !== 'string') {
        pushError('staffKey not string')
        skOk = false
      } else {
        const [skStore, skName] = u.staffKey.split('::')
        if (!skStore || !skName) {
          pushError('staffKey malformed')
          skOk = false
        } else if (!skValid.ok) {
          // storeKeys 结构无效 → 归属无法验证 → 不 bound（storeKeys 错误已单独记录）
          skOk = false
        } else if (!skValid.keys.includes(skStore)) {
          pushError('staffKey store not in storeKeys')
          skOk = false
        } else if (staffMasterPresent && !staffKeySet.has(u.staffKey)) {
          pushError('staffKey staff not in master')
          skOk = false
        }
      }
      if (skOk && skValid.ok && skValid.keys.length >= 1) {
        staffKeyCategories.bound.push(String(u.id ?? ''))
      }
    } else if (u.bindingLegacyExempt === true) {
      if (skValid.ok && skValid.keys.length >= 1) {
        pushWarn('legacy exempt binding')
        staffKeyCategories.legacyExempt.push({ id: String(u.id ?? ''), username: String(uname ?? '') })
      }
    } else {
      pushError('missing staffKey non-exempt')
      staffKeyCategories.unboundInvalid.push({ id: String(u.id ?? ''), username: String(uname ?? '') })
    }
  }
  // 时间字段：真正验证可解析性（不可解析 → invalid）
  for (const tf of ['createdAt', 'disabledAt', 'permissionsUpdatedAt']) {
    if (u[tf] !== undefined && u[tf] !== null && u[tf] !== '') {
      const r = isIsoString(u[tf])
      if (!r.ok) pushError(`unparseable ${tf}`)
    }
  }
  accountValidations.push({
    id: String(u.id ?? ''),
    username: String(uname ?? ''),
    valid: accountErrors.length === 0,
    errors: accountErrors,
    warnings: accountWarnings,
  })
}

// 唯一有效性来源：accountValidations（valid === errors.length === 0）
report.accountValidations = accountValidations
report.invalidUsers = accountValidations.filter((a) => !a.valid).length
report.validUsers = accountValidations.filter((a) => a.valid).length
report.invalidReasons = invalidReasonsCount
// 统一验证原则：唯一有效性来源是 accountValidations（valid === errors.length === 0）
report.validation = {
  errors: invalidReasonsCount,
  warnings: warningReasonsCount,
  errorReasonCount: Object.keys(invalidReasonsCount).length,
  warningReasonCount: Object.keys(warningReasonsCount).length,
  consistencyNote: 'validUsers/invalidUsers 完全从 accountValidations 汇总（valid === errors.length === 0）；WARNINGS（case-fold/legacy exempt/unverifiable/软异常）不判 invalid',
}

// 仅对象条目参与后续结构化检查（null/数组/标量条目已在主循环计为 invalid）
const objectUsers = users.filter((u) => u && typeof u === 'object' && !Array.isArray(u))

// ---------------- 密码检查（完全脱敏；type/types 反映实际混合类型） ----------------
const hashSamples = objectUsers.map((u) => u.passwordHash).filter((v) => v !== undefined && v !== null && v !== '')
const stringHashes = hashSamples.filter((v) => typeof v === 'string')
const hashTypeCounts = {}
for (const v of hashSamples) hashTypeCounts[typeof v] = (hashTypeCounts[typeof v] || 0) + 1
const hashTypeKeys = Object.keys(hashTypeCounts)
report.passwordCheck = {
  present: users.length - report.missingPasswordHashes.length,
  type: hashTypeKeys.length <= 1 ? (hashTypeKeys[0] || 'string') : 'mixed',
  types: hashTypeCounts,
  length: stringHashes.length ? Math.min(...stringHashes.map((h) => h.length)) : 0,
  formatValid: stringHashes.length === hashSamples.length && stringHashes.every((h) => PASSWORD_HASH_RE.test(h)),
  compatibleWithCurrentAuth: stringHashes.length === hashSamples.length && stringHashes.every((h) => PASSWORD_HASH_RE.test(h)),
  note: 'scrypt salt:hash（32hex:128hex）；不输出任何 hash 片段；非字符串 hash 计入 types 并使 formatValid=false',
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

// ---------------- Permissions 检查（结构问题已在主循环账号级执行并判 invalid） ----------------
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

// 每账号有效权限盘点：严格复现运行时 normalizeModules + hasModuleAccess + hasInventoryTransferAll + canManageAccounts
report.perAccountPermissions = objectUsers.map((u) => {
  const role = String(u.role ?? '')
  const status = u.status || (role === PUBLIC_ROLE ? 'disabled' : 'active') // loadDb 补全语义
  const eff = runtimeEffectiveModules(u)
  const p = u.permissions && typeof u.permissions === 'object' && !Array.isArray(u.permissions) ? u.permissions : null
  const itaStored = Boolean(p && p.inventoryTransferAll === true)
  return {
    id: String(u.id ?? ''),
    username: String(u.username ?? ''),
    role,
    status,
    effectiveModules: eff.modules,
    effectiveBasis: eff.basis,
    // assetCenter 存储标志（真实运行时仅「无 source」时经 defaultModuleKeys 生效为 fallback）
    assetCenterStored: u.assetCenter === true,
    inventoryTransferAllStored: itaStored,
    inventoryTransferAllEffective: runtimeInventoryTransferAll(u), // 跨门店调拨范围能力，非模块访问权
    canManageAccounts: runtimeCanManageAccounts(u),
  }
})

// 账号治理能力判定：hasPageAccess('account-admin') = canManageAccounts = developer && status !== disabled
report.accountAdminCheck = {
  rule: 'canManageAccounts：仅 developer 且 status !== disabled（shared/accountPermissions.js canManageAccounts L134-136；hasPageAccess(account-admin) 同规则）；public 恒 false（status=disabled）',
  accounts: objectUsers.map((u) => {
    const role = String(u.role ?? '')
    const status = u.status || (role === PUBLIC_ROLE ? 'disabled' : 'active') // loadDb 补全语义
    return {
      id: String(u.id ?? ''),
      username: String(u.username ?? ''),
      role,
      status,
      canManageAccounts: runtimeCanManageAccounts(u),
    }
  }),
}

// ---------------- Staff Binding 检查（真实规则：app.js validateBoundRole L366-374 / validateCashierRole L355-364） ----------------
// 分类统计已在主循环完成（bound / legacyExempt / unboundInvalid）；此处仅保留诊断级 issues
const staffKeys = objectUsers.filter((u) => u.staffKey !== undefined && u.staffKey !== null && u.staffKey !== '')
const staffBindingIssues = []
for (const u of objectUsers) {
  const role = String(u.role ?? '')
  const hasSk = u.staffKey !== undefined && u.staffKey !== null && u.staffKey !== ''
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
  bound: staffKeyCategories.bound,
  legacyExempt: staffKeyCategories.legacyExempt,
  unboundInvalid: staffKeyCategories.unboundInvalid,
  issues: staffBindingIssues,
  unverifiableNote: staffMasterPresent
    ? ''
    : '输入不含 staff 主档；员工是否真实存在无法核对（unverifiable，非 PASS）',
  risk: '员工重命名/门店 key 变化会导致绑定失效；Prisma User 无 staffKey 字段',
}

// ---------------- Store Binding 检查（结构诊断 + 主档存在性状态） ----------------
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
  storeExistence: storeMasterPresent ? 'verified' : 'unverifiable',
  storeMasterCount: storeMaster ? storeMaster.length : 0,
  rules: {
    managerStaff: '必须绑定至少一家门店 + staffKey（validateBoundRole；已账号级执行，违反 → invalidUsers）',
    cashier: '必须且仅绑定一家门店、不得绑定员工（validateCashierRole；已账号级执行，违反 → invalidUsers）',
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
// 持久化说明（真实代码核对）
report.persistenceNotes = [
  'KV User 当前不存在统一持久化 updatedAt：仅 permissionsUpdatedAt 记录授权变更；账号资料（用户名/头像/二级密码）变更时间不可追溯',
  'PG User（prisma/schema.prisma L33-40）亦无 updatedAt 字段；KV→PG 迁移无该字段问题，但迁移后需自行设计资料变更审计',
]

// ---------------- 输出（JSON + 可选 Markdown） ----------------
const output = JSON.stringify(report, null, 2)
console.log(output)

if (reportFile) {
  // 排他安全创建：目标已存在（普通文件/symlink/硬链接/目录，含损坏 symlink）一律拒绝，绝不覆盖/截断/修改已有文件
  let reportExists = false
  try {
    fs.lstatSync(reportFile)
    reportExists = true
  } catch {
    /* 目标不存在，可安全创建 */
  }
  if (reportExists) {
    console.error(`拒绝执行：--report 目标已存在（${reportFile}），不会覆盖/截断/修改任何已有文件；请删除或更换路径`)
    process.exit(2)
  }
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
    `- type: ${report.passwordCheck.type}（types=${JSON.stringify(report.passwordCheck.types)}）`,
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
    `- Staff 绑定: bound=${report.staffBindingCheck.bound.length} / legacyExempt=${report.staffBindingCheck.legacyExempt.length} / unboundInvalid=${report.staffBindingCheck.unboundInvalid.length}（masterPresent=${report.staffBindingCheck.masterPresent}）`,
    `- Store 存在性: ${report.storeBindingCheck.storeExistence}（stores 主档 ${report.storeBindingCheck.storeMasterCount} 条）`,
    `- Store 绑定规则: ${JSON.stringify(report.storeBindingCheck.rules)}`,
    ``,
    `## User ID 外部引用（hard=直接存 User.id / soft=username 软引用）`,
    report.idReferenceMap.map((r) => `- **${r.sourceFile}** · ${r.entity}.${r.field}（${r.hardOrSoftReference}）：${r.usage} → ${r.migrationRisk}`).join('\n'),
    ``,
    `## 账号治理 / 持久化说明`,
    `- 可管理账号（canManageAccounts，仅 developer 且未停用）: ${report.accountAdminCheck.accounts.filter((a) => a.canManageAccounts).length} 个`,
    report.persistenceNotes.map((n) => `- ${n}`).join('\n'),
    ``,
  ].join('\n')
  try {
    // flag 'wx'：排他创建（O_CREAT|O_EXCL），目标不存在才成功；mode 0600 创建即生效
    fs.writeFileSync(reportFile, md, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.chmodSync(reportFile, 0o600) // 文件为本轮创建，强制 0600 不依赖 umask
    console.error(`\nMarkdown 报告已写入：${reportFile}（mode 0600，排他创建）`)
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      console.error(`拒绝执行：--report 目标已存在（${reportFile}），不会覆盖/截断/修改任何已有文件；请删除或更换路径`)
      process.exit(2)
    }
    console.error(`无法写入报告文件 ${reportFile}：${err.message}`)
    process.exit(2)
  }
}
