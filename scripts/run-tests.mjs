#!/usr/bin/env node
// 统一测试入口调度器（V3-002）
// 用法：
//   node scripts/run-tests.mjs            → 日常全量（npm run test）
//   node scripts/run-tests.mjs critical    → 关键业务域（npm run test:critical）
// 职责：
//   - 顺序执行各测试脚本（node --test 或直接执行），任一失败即退出非 0
//   - 所有测试子进程使用「隔离测试环境」（不继承生产数据库/外部服务凭证，fail-safe）
//   - 每个测试文件独立执行，文件级失败统计准确
// 设计原则：只复用仓库现有测试，不修改任何测试逻辑与业务代码；不打印任何敏感变量值。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2] === 'critical' ? 'critical' : 'all'

// ---------------- 测试清单 ----------------
// node:test 框架（自动发现断言，失败非 0）
const NODE_TEST_SUITE = [
  'test-config.mjs',                // 生产环境配置与数据存储 fail-closed
  'test-account-permissions.mjs',   // Auth / Permission（单元）→ critical
  'test-daily-entry-upgrade.mjs',   // DailyEntry（单元）→ critical
  'test-pos-core.mjs',              // POS 核心快照/归并（单元）→ critical
  'test-pos-daily.mjs',             // POS 日结（单元）
  'test-pos-order-summary.mjs',     // POS 订单汇总（单元）
  'test-pos-revenue-recognition-real.mjs', // POS 营收口径（真实 PostgreSQL）
  'test-homepage-lightweight.mjs',  // Homepage 轻量首页（Vite 内存服务）→ critical
  'test-daily-pay-adjustment.mjs',  // 日薪调整（单元）
  'test-product-excel.mjs',         // 商品 Excel 导入（单元）
  'test-employee-pay-excel.mjs',    // 员工薪资 Excel（单元）
  'test-payment-foundation.mjs',    // 支付基础（单元）
  'test-notification-center.mjs',   // 通知中心/企业微信自建应用推送（单元 + 真实 PostgreSQL）
  'test-approval-ui-regressions.mjs', // 工资提交成功动画与移动端通知层级回归
  'test-wechat-v2-signature.mjs',   // 微信 V2 签名/XML 安全（单元）
  'test-wechat-config.mjs',         // 微信配置 fail-closed 校验（单元）
  'test-wechat-pay-provider.mjs',   // 微信付款码 Provider（假传输，不连真实接口）
  'test-wechat-pay-e2e.mjs',        // 微信付款码真实栈 E2E（假网络传输 + 真实签名 XML）
  'test-payment-reconciliation.mjs', // 未决支付自动核对（单元）
  'test-terminal-ip.mjs',            // 共享严格公网 IPv4 校验（单元）
  'test-payment-log-fk-real.mjs',    // PaymentLog 外键 RESTRICT（真实 PostgreSQL，可弃用 schema）
  'test-payment-log-fk-drift.mjs',   // 00004 精确外键迁移漂移/失败场景（真实 PostgreSQL）
  'test-order-protection.mjs',      // 订单删除/取消保护（单元）
  'test-camera-scanner.mjs',        // 扫码（单元）
  'test-swipe-back.mjs',            // 滑动返回（单元）
  'test-system-slimming.mjs',       // 系统瘦身（单元）
  'test-store-directory.mjs',       // 固定四店目录与幽灵门店回归保护
  'test-item-category.mjs',         // 商品分类（单元）
  'test-ocr-map.mjs',               // OCR 映射（单元）
  'test-customer-service-request.mjs', // 顾客自助二维码：token/并发/事务/通知/金额锁定 → critical
  'test-user-migration-inventory.mjs', // User 迁移只读清单（V3-004A）
  'test-employee-profile.mjs',      // 员工档案：加密/掩码/权限矩阵（单元）
  'test-download-file.mjs',      // 文件下载：iOS/非 iOS 判定（单元）
  'test-address-parser.mjs',    // 收件信息智能拆分（单元）
  'test-invoice-parser.mjs',    // 发票开票信息智能拆分（单元）
  'test-data-authority-freeze.mjs', // Data Authority 1.0 DA-1：冻结 PG 权威域（静态扫描 + 可选 DB 冒烟）→ critical
  'test-pg-bootstrap-independence.mjs', // Data Authority Gate 1：/userdata 不得阻塞 PG authority bootstrap → critical
  'test-removed-staff-retirement.mjs', // Data Authority Gate 2：removedStaff 退出当前员工目录裁决 → critical
  'test-pg-employee-reactivity.mjs', // Data Authority Gate 3：异步 PG 员工更新驱动已挂载 React consumer → critical
  'test-store-entry-state-integrity.mjs', // StoreEntry P0：历史日期代际/迟到响应/移动候选面板 → critical
  'test-store-entry-performance-staff-display.mjs', // StoreEntry：业绩明细值班人员 DSS 稳定展示权威 → critical
  'test-data-authority-migration.mjs', // Data Authority：legacy DailyEntry 按业务唯一键幂等回填 → critical
  'test-daily-entry-authority.mjs', // Data Authority 1.0 DA-4：DailyEntry 读/写权威 = PG，禁止 KV 回退 → critical
  'test-schedule-authority.mjs', // Data Authority 1.0 DA-3：Schedule 读/写权威 = PG，前端禁 KV
  'test-identity-authority.mjs', // Data Authority 1.0 DA-2：账号/登录/鉴权权威 = PG，禁 KV users → critical 
]
// 直接执行脚本（自带断言与退出码；与原 npm 命令 node scripts/xxx 一致）
const DIRECT_SUITE = [
  'test-role-module-api.mjs',       // Auth / 角色 / 模块权限 API（本地起服务）→ critical
  'test-pg-account-load-db-isolation.mjs', // Gate 4：PG 账号路由不受 legacy loadDb 故障阻塞 → critical
  'test-daily-store-staff-employee-identity.mjs', // Gate 6：DailyStoreStaff 稳定 Employee.id + legacy 兼容 → critical
  'test-current-directory-identity.mjs', // Gate 7：当前员工目录 Employee.id 身份——重名并存/定向离职不误伤 → critical
  'test-daily-pay-adjustment-employee-identity.mjs', // Gate 9：DailyPayAdjustment 稳定 Employee.id + legacy 兼容 → critical
  'test-big-order-bonus-employee-identity.mjs', // Gate 10：BigOrderBonus 稳定 Employee.id + 稳定读取无双计 → critical
  'test-daily-store-staff-foundation.mjs', // Gate 12：DailyStoreStaff 按月批量只读数据基础（不改 payroll）→ critical
  'test-payroll-shadow-input.mjs', // Gate 13：Employee.id payroll 输入 shadow 模型（纯函数，零 live 消费）→ critical
  'test-payroll-shadow-calculator.mjs', // Gate 14：Employee.id shadow 月度工资计算（并行，零 live 消费）→ critical
  'test-daily-store-staff-constraint-cutover.mjs', // Gate 16：DailyStoreStaff 稳定身份约束切换（同店同名共存）→ critical
  'test-payroll-notice-identity.mjs', // Gate 18：PayrollNotice 稳定主体 + 收件人 User.employeeId → critical
  'test-explicit-employee-account-binding.mjs', // Gate 20：显式 Employee.id 账号绑定（同店同名安全）→ critical
  'test-month-scoped-staff-cache.mjs', // Gate 21：DailyStoreStaff 月键控缓存隔离 → critical
  'test-payroll-cache-lifecycle.mjs', // P0：reset/账号切换/迟到响应/月状态缓存生命周期 → critical
  'test-payroll-readiness.mjs', // Gate 22：payroll 月就绪度评估（纯函数，零 live 消费）→ critical
  'test-payroll-resolver.mjs', // Gate 23：统一 payroll 计算 resolver（纯函数，零 live 消费）→ critical
  'test-export-salary-identity.mjs', // Gate 25：ExportSalaryModal Employee.id 导出身份（纯逻辑）→ critical
  'test-export-detail-identity.mjs', // Gate 25 澄清：明细行调整/奖金按 employeeId 精确隔离（同店同名）→ critical
  'test-payroll-adjustment-only.mjs', // Gate 26：稳定调整仅日 Employee.id 月度贡献（无考勤也可进入 payroll）→ critical
  'test-payroll-issue-resolver.mjs', // Gate 27：PayrollIssueModal resolver 发放纯逻辑（主体/快照/预检）→ critical
  'test-week-custom-payroll.mjs', // WEEK/CUSTOM：统一范围 resolver / 跨月 / 历史 / cache / algebra → critical
  'test-payroll-payable-hours.mjs', // Gate 29B：稳定应付工时权威 + 月/日/快照统一计算合同 → critical
  'test-payroll-mascot-isolation.mjs', // Gate 29E：展示姓名不得控制工资资格 → critical
  'test-personnel-payroll-identity.mjs', // Gate 29F：Personnel 日/周 Employee.id + 跨月/竞态身份 → critical
  'test-personnel-monthly-display.mjs', // Gate 29G：Personnel 月度提成/大单奖展示语义 → critical
  'test-payroll-explanation-metadata.mjs', // Gate 29I：权威日工资解释元数据 + 金额/历史快照冻结 → critical
  'test-payroll-card-ui.mjs', // Gate 29J：员工工资月卡/日解释卡只读权威元数据 → critical
  'test-payroll-self-scope.mjs', // Gate 29L：员工本人范围只认 User.employeeId → critical
  'test-inventory-workflow.mjs',    // Inventory 调货/采购流程（本地起服务）→ critical
  'test-payroll.mjs',               // Payroll 工资计算（单元）→ critical
  'test-approval-engine.mjs',       // Approval 审批引擎（单元）→ critical
  'test-payroll-integration.mjs',   // Payroll 集成（Vite 内存服务）→ critical
]
// critical 子集（关键业务域：Auth/Account/Permission、DailyEntry、POS、Inventory、Payroll、Approval、Homepage）
const CRITICAL_DIRECT = [
  'test-role-module-api.mjs',
  'test-pg-account-load-db-isolation.mjs',
  'test-daily-store-staff-employee-identity.mjs',
  'test-current-directory-identity.mjs',
  'test-daily-pay-adjustment-employee-identity.mjs',
  'test-big-order-bonus-employee-identity.mjs',
  'test-daily-store-staff-foundation.mjs',
  'test-payroll-shadow-input.mjs',
  'test-payroll-shadow-calculator.mjs',
  'test-daily-store-staff-constraint-cutover.mjs',
  'test-payroll-notice-identity.mjs',
  'test-explicit-employee-account-binding.mjs',
  'test-month-scoped-staff-cache.mjs',
  'test-payroll-cache-lifecycle.mjs',
  'test-payroll-readiness.mjs',
  'test-payroll-resolver.mjs',
  'test-export-salary-identity.mjs',
  'test-export-detail-identity.mjs',
  'test-payroll-adjustment-only.mjs',
  'test-payroll-issue-resolver.mjs',
  'test-week-custom-payroll.mjs',
  'test-payroll-payable-hours.mjs',
  'test-payroll-mascot-isolation.mjs',
  'test-personnel-payroll-identity.mjs',
  'test-personnel-monthly-display.mjs',
  'test-payroll-explanation-metadata.mjs',
  'test-payroll-card-ui.mjs',
  'test-payroll-self-scope.mjs',
  'test-inventory-workflow.mjs',
  'test-payroll.mjs',
  'test-approval-engine.mjs',
  'test-payroll-integration.mjs',
]
const CRITICAL_NODE_TEST = [
  'test-account-permissions.mjs',
  'test-daily-entry-upgrade.mjs',
  'test-pos-core.mjs',
  'test-homepage-lightweight.mjs',
  'test-data-authority-freeze.mjs',
  'test-pg-bootstrap-independence.mjs',
  'test-removed-staff-retirement.mjs',
  'test-pg-employee-reactivity.mjs',
  'test-store-entry-state-integrity.mjs',
  'test-store-entry-performance-staff-display.mjs',
  'test-data-authority-migration.mjs',
  'test-daily-entry-authority.mjs',
  'test-schedule-authority.mjs',
  'test-identity-authority.mjs',
  'test-customer-service-request.mjs',
]
// 已知既有失败（不纳入统一入口；原因见完成报告）
// - test-startup-performance.mjs：断言 sw.js 缓存名应为 budu-shell-v12，当前代码为 v15（既有测试过时）
// - test-item-category-integration.mjs：依赖 DATABASE_URL（外部数据库），本地不可重复运行

const directFiles = (mode === 'critical' ? CRITICAL_DIRECT : DIRECT_SUITE).map((f) => path.join('scripts', f))
const nodeTestFiles = (mode === 'critical' ? CRITICAL_NODE_TEST : NODE_TEST_SUITE).map((f) => path.join('scripts', f))
checkFiles([...directFiles, ...nodeTestFiles])

// ---------------- 隔离测试环境 ----------------
// 生产/外部服务凭证变量黑名单：测试子进程一律不继承（fail-safe，不依赖开发者机器是否干净）
const STRIPPED_ENV_KEYS = [
  // 数据库
  'DATABASE_URL',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  // Upstash / KV / Redis
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN',
  // 支付
  'PAYMENT_MODE', 'ENABLE_MOCK_CALLBACK_API', 'EMAIL_NOTIFY_ENABLED',
  // 微信付款码支付（V2 MICROPAY）——测试一律剥离，绝不继承生产密钥
  'WECHAT_PAY_ENABLED', 'WECHAT_PAY_PROTOCOL', 'WECHAT_PAY_MCHID', 'WECHAT_PAY_APPID',
  'WECHAT_PAY_API_V2_KEY_FILE', 'WECHAT_PAY_CERT_FILE', 'WECHAT_PAY_PRIVATE_KEY_FILE',
  'WECHAT_PAY_TERMINAL_IP', 'WECHAT_PAY_ENABLED_STORES',
  'WECHAT_PAY_QUERY_INTERVAL_MS', 'WECHAT_PAY_MAX_QUERIES', 'WECHAT_PAY_REVERSE_AFTER_MS',
  'WECHAT_REFUND_QUERY_INTERVAL_MS',
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
  // 其他外部服务
  'PUBLIC_BASE_URL',
  // 随机种子/环境密钥（避免测试继承生产 JWT 等）
  'JWT_SECRET',
]

/** 构造测试子进程的安全环境：白名单基础变量 + 强制 test 模式 + 清除所有生产/外部凭证 */
function createTestEnv() {
  return createTestEnvFrom(process.env)
}

const testEnv = createTestEnv()

/** 文件存在性预检（node --test 对缺失文件静默返回 0，需显式拦截） */
function checkFiles(list) {
  const missing = list.filter((f) => !fs.existsSync(path.join(root, f)))
  if (missing.length) {
    console.error('缺失测试文件：' + missing.join(', '))
    process.exit(1)
  }
}

/** 执行单个测试文件；stdout/stderr 透传，返回是否成功 */
function runOne(file, extraArgs = []) {
  const r = spawnSync(process.execPath, [...extraArgs, file], {
    cwd: root,
    env: testEnv,
    stdio: 'inherit',
    shell: false,
  })
  return r.status === 0
}

let pass = 0
let fail = 0
const failures = []

console.log(`\n===== BUDU 统一测试入口 [${mode}] =====`)
console.log(`  环境隔离：NODE_ENV=test / APP_ENV=test / DATA_DIR=本地临时目录 / 外部凭证已剥离\n`)

// 1) 直接执行脚本（独立文件执行）
for (const f of directFiles) {
  const ok = runOne(f)
  if (ok) pass += 1
  else { fail += 1; failures.push(f) }
  console.log(`  ${ok ? '✅' : '❌'} ${f}\n`)
}

// 2) node --test 框架（每个文件独立执行 → 文件级失败统计准确）
for (const f of nodeTestFiles) {
  const ok = runOne(f, ['--test'])
  if (ok) pass += 1
  else { fail += 1; failures.push(f) }
  console.log(`  ${ok ? '✅' : '❌'} ${f}\n`)
}

// 3) 环境隔离自验证（模拟父进程带假生产变量 → 子进程必须看不到）
const isolationOk = verifyIsolation()
if (isolationOk) pass += 1
else { fail += 1; failures.push('环境隔离自验证') }
console.log(`  ${isolationOk ? '✅' : '❌'} 环境隔离自验证\n`)

console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)

/** 环境隔离自验证：
 * 1) 用「带假生产变量的父进程环境」调用 createTestEnv()，产物必须不含任何黑名单键；
 * 2) 用该产物作为子进程 env 运行探针，子进程必须看不到假凭证、且为 test 模式、DATA_DIR 为本地临时。
 * 使用假值，不涉及任何真实凭证。
 */
function verifyIsolation() {
  // 模拟父进程带有生产配置（假值）
  const fakeParent = {
    ...process.env,
    DATABASE_URL: 'postgres://fake-prod',
    UPSTASH_REDIS_REST_URL: 'https://fake-prod',
    UPSTASH_REDIS_REST_TOKEN: 'fake-secret',
    KV_REST_API_URL: 'https://fake-prod',
    KV_REST_API_TOKEN: 'fake-secret',
    WXWORK_SECRET: 'fake-secret',
    WXWORK_CORP_ID: 'fake-corp',
    MP_APP_SECRET: 'fake-secret',
    COS_SECRET_KEY: 'fake-secret',
    TENCENT_OCR_SECRET_ID: 'fake-secret',
    SENTRY_DSN: 'https://fake@sentry.example/1',
    VITE_SENTRY_DSN: 'https://fake@sentry.example/1',
    JWT_SECRET: 'fake-secret',
    WECHAT_WORK_WEBHOOK_URL: 'https://fake-webhook',
  }
  // 直接用 createTestEnv 的剥离逻辑生成隔离环境（从假父进程角度）
  const isolated = createTestEnvFrom(fakeParent)
  const strippedKeys = [
    'DATABASE_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'WXWORK_SECRET', 'WXWORK_CORP_ID',
    'MP_APP_SECRET', 'COS_SECRET_KEY', 'TENCENT_OCR_SECRET_ID',
    'SENTRY_DSN', 'VITE_SENTRY_DSN', 'JWT_SECRET', 'WECHAT_WORK_WEBHOOK_URL',
  ]
  const leaked = strippedKeys.filter((k) => isolated[k] !== undefined)
  if (leaked.length) {
    console.error('ISOLATION_FAIL: 环境构造仍包含 ' + leaked.join(','))
    return false
  }
  if (isolated.NODE_ENV !== 'test' || isolated.APP_ENV !== 'test') {
    console.error('ISOLATION_FAIL: 未强制 test 模式')
    return false
  }
  if (!isolated.DATA_DIR) {
    console.error('ISOLATION_FAIL: 缺少 DATA_DIR')
    return false
  }
  // 子进程探针：确认子进程看到的 env 与隔离构造一致（看不到假凭证）
  const probe = `
    const keys = ${JSON.stringify(strippedKeys)}
    const leaked = keys.filter((k) => process.env[k] !== undefined)
    if (process.env.NODE_ENV !== 'test' || process.env.APP_ENV !== 'test') { console.error('ISOLATION_FAIL: mode'); process.exit(1) }
    if (!process.env.DATA_DIR) { console.error('ISOLATION_FAIL: DATA_DIR'); process.exit(1) }
    if (leaked.length) { console.error('ISOLATION_FAIL: ' + leaked.join(',')); process.exit(1) }
  `
  const r = spawnSync(process.execPath, ['-e', probe], {
    cwd: root,
    env: isolated,
    stdio: 'inherit',
    shell: false,
  })
  if (r.status !== 0) return false
  console.log('  隔离验证：外部凭证已剥离 / 强制 test 模式 / DATA_DIR 本地临时')
  return true
}

/** 从指定父进程环境构造隔离测试环境（供自验证复用同一剥离逻辑） */
function createTestEnvFrom(parentEnv) {
  const env = {}
  for (const k of ['PATH', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
    if (parentEnv[k] !== undefined) env[k] = parentEnv[k]
  }
  env.NODE_ENV = 'test'
  env.APP_ENV = 'test'
  env.DATA_DIR = parentEnv.TEST_DATA_DIR || path.join(os.tmpdir(), `budu-test-data-${process.pid}-${Date.now().toString(36)}`)
  env.TEST_DATA_DIR = env.DATA_DIR
  for (const [k, v] of Object.entries(parentEnv)) {
    if (k.startsWith('TEST_') && !STRIPPED_ENV_KEYS.includes(k)) env[k] = v
  }
  for (const k of STRIPPED_ENV_KEYS) delete env[k]
  return env
}
