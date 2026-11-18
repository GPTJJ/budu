/**
 * 清理小程序旧支付链里超时未支付的订单（并释放被锁的券）。
 *
 * 为什么放在 OS：CloudBase 云函数没有定时触发器，OS 的宿主机已有 5 分钟一次的
 * crontab 在跑小程序订单归档；这里复用同一台机器的凭据调用 payOrder 云函数。
 *
 * 云函数侧（payOrder action=sweepStaleOrders）负责：关微信支付单 → 条件取消本地单 → 释放券。
 * 本脚本只负责触发与记账，不直接改任何订单。
 *
 * 用法（容器内）：
 *   node /app/scripts/sweep-legacy-orders.mjs            # 默认 30 分钟 TTL
 *   node /app/scripts/sweep-legacy-orders.mjs 45         # 自定义 TTL
 *   node /app/scripts/sweep-legacy-orders.mjs 30 --dry-run
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

// 容器里脚本可能被放到 /tmp 执行，依赖要按 /app 解析，不能按脚本自身路径。
const require = createRequire(fs.existsSync('/app/package.json') ? '/app/package.json' : import.meta.url)
const tcb = require('@cloudbase/node-sdk')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const ttlArg = argv.find((value) => /^\d+$/.test(value))
const ttlMinutes = ttlArg ? Number(ttlArg) : 30

const env = process.env.TCB_ENV_ID
const secretId = process.env.TCB_SECRET_ID
const secretKey = process.env.TCB_SECRET_KEY
if (!env || !secretId || !secretKey) {
  console.error('缺少 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY')
  process.exit(2)
}

const app = tcb.init({ env, secretId, secretKey })
const startedAt = new Date().toISOString()

try {
  const response = await app.callFunction({
    name: 'payOrder',
    data: { action: 'sweepStaleOrders', ttlMinutes, limit: 50, dryRun },
  })
  const result = (response && response.result) || {}
  console.log(JSON.stringify({ at: startedAt, ttlMinutes, dryRun, result }))
  if (!result.ok) process.exit(1)
} catch (error) {
  console.error(JSON.stringify({ at: startedAt, error: error && error.message ? error.message : String(error) }))
  process.exit(1)
}
