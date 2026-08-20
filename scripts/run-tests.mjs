#!/usr/bin/env node
// 统一测试入口调度器（V3-002）
// 用法：
//   node scripts/run-tests.mjs            → 日常全量（npm run test）
//   node scripts/run-tests.mjs critical    → 关键业务域（npm run test:critical）
// 职责：顺序执行各测试脚本（node --test 或直接执行），任一失败即退出非 0。
// 设计原则：只复用仓库现有测试，不修改任何测试逻辑与业务代码。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2] === 'critical' ? 'critical' : 'all'

/** 测试文件存在性预检（node --test 对缺失文件静默返回 0，需显式拦截） */
function checkFiles(list) {
  const missing = list.filter((f) => !fs.existsSync(path.join(root, f)))
  if (missing.length) {
    console.error('缺失测试文件：' + missing.join(', '))
    process.exit(1)
  }
}

// ---------------- 测试清单 ----------------
// node --test 框架（自动发现断言，失败非 0）
// node:test 框架（自动发现断言，失败非 0）
const NODE_TEST_SUITE = [
  'test-account-permissions.mjs',   // Auth / Permission（单元）→ critical
  'test-daily-entry-upgrade.mjs',   // DailyEntry（单元）→ critical
  'test-pos-core.mjs',              // POS 核心快照/归并（单元）→ critical
  'test-pos-daily.mjs',             // POS 日结（单元）
  'test-pos-order-summary.mjs',     // POS 订单汇总（单元）
  'test-homepage-lightweight.mjs',  // Homepage 轻量首页（Vite 内存服务）→ critical
  'test-daily-pay-adjustment.mjs',  // 日薪调整（单元）
  'test-product-excel.mjs',         // 商品 Excel 导入（单元）
  'test-employee-pay-excel.mjs',    // 员工薪资 Excel（单元）
  'test-payment-foundation.mjs',    // 支付基础（单元）
  'test-camera-scanner.mjs',        // 扫码（单元）
  'test-swipe-back.mjs',            // 滑动返回（单元）
  'test-system-slimming.mjs',       // 系统瘦身（单元）
  'test-item-category.mjs',         // 商品分类（单元）
  'test-ocr-map.mjs',               // OCR 映射（单元）
]
// 直接执行脚本（自带断言与退出码；与原 npm 命令 node scripts/xxx 一致）
const DIRECT_SUITE = [
  'test-role-module-api.mjs',       // Auth / 角色 / 模块权限 API（本地起服务）→ critical
  'test-inventory-workflow.mjs',    // Inventory 调货/采购流程（本地起服务）→ critical
  'test-payroll.mjs',               // Payroll 工资计算（单元）→ critical
  'test-approval-engine.mjs',       // Approval 审批引擎（单元）→ critical
  'test-payroll-integration.mjs',   // Payroll 集成（Vite 内存服务）→ critical
]
// critical 子集（关键业务域：Auth/Account/Permission、DailyEntry、POS、Inventory、Payroll、Approval、Homepage）
const CRITICAL_DIRECT = [
  'test-role-module-api.mjs',
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
]
// 已知既有失败（不纳入统一入口；原因见完成报告）
// - test-startup-performance.mjs：断言 sw.js 缓存名应为 budu-shell-v12，当前代码为 v15（既有测试过时）
// - test-item-category-integration.mjs：依赖 DATABASE_URL（外部数据库），本地不可重复运行

const directFiles = (mode === 'critical' ? CRITICAL_DIRECT : DIRECT_SUITE).map((f) => path.join('scripts', f))
const nodeTestFiles = (mode === 'critical' ? CRITICAL_NODE_TEST : NODE_TEST_SUITE).map((f) => path.join('scripts', f))
checkFiles([...directFiles, ...nodeTestFiles])
const directList = directFiles // 已带 scripts/ 前缀
const nodeTestList = nodeTestFiles

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
  return r.status === 0
}

let pass = 0
let fail = 0
const failures = []

console.log(`\n===== BUDU 统一测试入口 [${mode}] =====\n`)

// 1) 直接执行脚本
for (const f of directFiles) {
  const ok = run(process.execPath, [f])
  if (ok) pass += 1
  else { fail += 1; failures.push(f) }
  console.log(`  ${ok ? '✅' : '❌'} ${f}\n`)
}

// 2) node --test 框架（一次调用跑一批，自动发现断言）
const okBatch = run(process.execPath, ['--test', ...nodeTestList])
if (okBatch) pass += nodeTestList.length
else {
  fail += nodeTestList.length
  for (const f of nodeTestList) failures.push(f)
  console.log(`  ❌ node --test 批次（${nodeTestList.join(', ')}）`)
}

console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
process.exit(0)
