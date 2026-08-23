// BUDU Data Authority 1.0 — DA-1 Freeze Tests
// 目标：把已确认 PostgreSQL Authority 的业务域正式固定（READ=PG / WRITE=PG / Fallback=NONE / 无业务数据 KV 依赖）。
// 原则：已经正确的业务不重新迁移；本测试只防止「冻结域」重新引入 KV/JSON 业务权威。
// 静态断言始终执行；数据库冒烟在提供 DATABASE_URL 时执行（测试环境按惯例剥离凭证，自动 skip）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ---------------- 冻结域清单 ----------------
// 纯 PG 文件：业务数据不得以任何方式触碰 KV 层（store.js / loadDb / persist）
const PURE_FILES = [
  'server/pos.js',                    // POS Order / OrderItem / Payment / Refund
  'server/products.js',               // Product（InventoryItem）
  'server/payroll-notice.js',         // PayrollNotice（工资条）
  'server/employee-profile.js',       // Employee Profile / Bank Account / Contract / Audit
  'server/daily-entry-upgrade.js',    // DailyEntry / DailyStoreStaff / DailyPayAdjustment
  'server/notifications.js',          // Notification（站内）
  'server/ocr.js',                    // Invoice OCR 辅助
  'server/asset-reminders.js',        // Asset 到期提醒
  'server/schedule.js',               // Schedule（DA-3 排班权威）
  'server/v2.js',                     // 调货/采购/库存/大单奖/日薪调整/发票/邮寄/资产等 v2 业务域
  'server/payments/payment-reconciler.js',   // Payment 对账
  'server/payments/payment-service.js',      // Payment 服务
  'server/payments/refund-reconciler.js',    // Refund 对账
  'server/payments/terminal-ip.js',          // 支付终端 IP 校验
  'server/payments/providers/cash.js',       // 现金支付 Provider
  'server/payments/providers/mock.js',       // 模拟支付 Provider
  'server/payments/providers/wechat-pay.js', // 微信支付 Provider
  'server/payments/wechat-config.js',        // 微信支付配置
  'server/payments/wechat-v2-client.js',     // 微信 V2 客户端
  'server/payments/wechat-v2-signature.js',  // 微信 V2 签名
]

// 混合文件：KV 仅允许「账号目录」（users）用途；禁止业务数据 KV 访问
const MIXED_FILES = [
  'server/approvals.js',        // 审批业务 PG；KV 仅 cc-candidates / cc 校验 / 抄送名单（users）
  'server/asset-center.js',     // 资产业务 PG；KV 仅 grants 账号查询（users）
  'server/notification-center.js', // 通知业务 PG；KV 仅 listUsernames（users）
  'server/wechat-bind.js',      // 绑定业务 PG；KV 仅系统账号查找（users）
]

// KV 业务数据字段（冻结域不得经 KV 读写）
const KV_BUSINESS_FIELDS = [
  'entries', 'staff', 'schedules', 'stores', 'products', 'analysis',
  'inventoryRequests', 'inventory', 'bigBonuses', 'dailyPayAdjustments',
  'posDaily', 'posProductSales', 'productImages', 'removedStaff',
]

const KV_ACCESS_MARKERS = ['loadDb(', 'persist(', "from './store.js'", "from '../store.js'", "from './store.js'", "from '../server/store.js'"]

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

test('DA-1: 纯 PG 冻结文件不得引用 KV 层', () => {
  const violations = []
  for (const file of PURE_FILES) {
    if (!fs.existsSync(path.join(root, file))) continue
    const src = read(file)
    for (const marker of KV_ACCESS_MARKERS) {
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        if (line.includes(marker)) violations.push(`${file}:${i + 1} -> ${line.trim()}`)
      })
    }
  }
  assert.deepEqual(violations, [], `冻结域文件出现 KV 访问：\n${violations.join('\n')}`)
})

test('DA-1: 混合文件 KV 仅限账号目录（users），禁止业务数据经 KV 访问', () => {
  const violations = []
  for (const file of MIXED_FILES) {
    const src = read(file)
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      // 1) loadDb/persist 调用处必须是账号目录（users）用途：检查调用行前后 4 行上下文
      if (/loadDb\(|persist\(/.test(line) && !line.trim().startsWith('//')) {
        const window = lines.slice(Math.max(0, i - 8), i + 9).join('\n')
        if (!/users/.test(window)) {
          violations.push(`${file}:${i + 1} -> ${line.trim()}`)
        }
      }
      // 2) 禁止 db.<业务字段> 的 KV 业务数据访问
      for (const field of KV_BUSINESS_FIELDS) {
        if (new RegExp(`db\\.${field}\\b`).test(line) && !line.trim().startsWith('//')) {
          violations.push(`${file}:${i + 1} -> ${line.trim()}`)
        }
      }
    })
  }
  assert.deepEqual(violations, [], `混合文件出现业务数据 KV 访问：\n${violations.join('\n')}`)
})

test('DA-1: 前端不得存在冻结域业务数据的 KV 提交调用方', () => {
  // 冻结域业务数据在运行时仅经 /v2/* PG 接口读写；下列 KV 提交函数必须无调用方（否则即 dual write）
  const deadCommits = [
    'commitProducts',
    'commitInventoryRequests',
    'commitInventoryState',
    'commitBigBonuses',
    'commitPosDaily',
    'commitPosProductSales',
    'commitDailyPayAdjustments',
  ]
  const violations = []
  for (const fn of deadCommits) {
    const files = fs.readdirSync(path.join(root, 'src'))
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const st = fs.statSync(full)
        if (st.isDirectory()) walk(full)
        else if (/\.(js|jsx)$/.test(name)) {
          const src = fs.readFileSync(full, 'utf8')
          const re = new RegExp(`\\b${fn}\\(`, 'g')
          let m
          while ((m = re.exec(src))) {
            const lineNo = src.slice(0, m.index).split('\n').length
            const line = src.split('\n')[lineNo - 1]
            if (!line.includes('export function')) {
              violations.push(`${full.replace(root + '/', '')}:${lineNo} -> ${line.trim().slice(0, 80)}`)
            }
          }
        }
      }
    }
    walk(path.join(root, 'src'))
  }
  assert.deepEqual(violations, [], `冻结域出现前端 KV 提交调用：\n${violations.join('\n')}`)
})

test('DA-1: 服务端冻结域路由不得写入 KV 总入口', () => {
  // 冻结域文件已由 PURE/MIXED 测试覆盖（无 loadDb/persist/业务字段 KV 访问）；
  // server/app.js 是 KV 总写入口（遗留域专用，DA-2/DA-5 收敛），此处仅确认冻结域路由不调用 /userdata PUT。
  const frozenRoutes = [
    'server/pos.js', 'server/products.js', 'server/payroll-notice.js',
    'server/employee-profile.js', 'server/daily-entry-upgrade.js', 'server/v2.js',
  ]
  const violations = []
  for (const file of frozenRoutes) {
    const src = read(file)
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      if (/\/userdata/.test(line) && !line.trim().startsWith('//')) {
        violations.push(`${file}:${i + 1} -> ${line.trim().slice(0, 90)}`)
      }
    })
  }
  assert.deepEqual(violations, [], `冻结域路由直接写 KV 总入口：\n${violations.join('\n')}`)
})

// ---------------- 数据库冒烟（提供 DATABASE_URL 时） ----------------
const DB_URL = process.env.DATABASE_URL || ''
test('DA-1: 冻结域 PG 表存在（需要 DATABASE_URL，测试环境自动跳过）', { skip: !DB_URL }, async () => {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  try {
    const tables = await prisma.$queryRawUnsafe(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )
    const set = new Set(tables.map((t) => t.tablename))
    const required = [
      'DailyEntry', 'daily_store_staff', 'daily_pay_adjustments', 'payroll_notices',
      'employees', 'employee_bank_accounts', 'InventoryItem', 'orders', 'order_items',
      'payments', 'payment_logs', 'refunds', 'refund_items', 'StockBalance', 'StockLedger',
      'TransferRequest', 'TransferItem', 'PurchaseRequest', 'PurchaseItem', 'Supplier',
      'approval_templates', 'approval_requests', 'approval_nodes', 'approval_attachments',
      'approval_comments', 'approval_ccs', 'approval_logs', 'notifications',
      'notification_templates', 'notification_deliveries', 'Invoice', 'InvoiceCompany',
      'MailingRecord', 'asset_files', 'asset_reminders', 'BigOrderBonus',
    ]
    const missing = required.filter((t) => !set.has(t))
    assert.deepEqual(missing, [], `冻结域缺失 PG 表：${missing.join(', ')}`)
  } finally {
    await prisma.$disconnect()
  }
})
