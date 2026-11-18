/**
 * 每日 10:00 触发券到期提醒（订阅消息）。
 *
 * 云函数侧（coupon action=expiryReminder）负责：查 3 天内到期的未使用券 → 按 openid 合并 →
 * 检查订阅次数 → 发送 → 扣减次数。本脚本只负责触发，不碰券数据。
 *
 * 用法（容器内）：node /app/scripts/coupon-expiry-reminder.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(fs.existsSync('/app/package.json') ? '/app/package.json' : import.meta.url)
const tcb = require('@cloudbase/node-sdk')

const env = process.env.TCB_ENV_ID
const secretId = process.env.TCB_SECRET_ID
const secretKey = process.env.TCB_SECRET_KEY
if (!env || !secretId || !secretKey) {
  console.error('缺少 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY')
  process.exit(2)
}

const app = tcb.init({ env, secretId, secretKey })
const at = new Date().toISOString()
try {
  const response = await app.callFunction({ name: 'coupon', data: { action: 'expiryReminder' } })
  const result = (response && response.result) || {}
  console.log(JSON.stringify({ at, result }))
  // 模板未配置不是故障，是还没审核通过；用非零退出会让 cron 邮件变噪音。
  if (!result.ok && result.code !== 'TEMPLATE_NOT_CONFIGURED') process.exit(1)
} catch (error) {
  console.error(JSON.stringify({ at, error: error && error.message ? error.message : String(error) }))
  process.exit(1)
}
