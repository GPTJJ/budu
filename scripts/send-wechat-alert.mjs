// 发送企业微信群机器人告警（Markdown）；未配置 Webhook 则跳过
import fs from 'node:fs'

function loadEnv() {
  for (const p of ['/opt/budu/.env.production', '.env.local', '.env']) {
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!(m[1] in process.env)) process.env[m[1]] = v
    }
  }
}

loadEnv()

const url = process.env.WECHAT_WORK_WEBHOOK_URL
const title = process.argv[2] || 'BUDU 告警'
const content = process.argv[3] || ''
if (!url) {
  console.log('未配置 WECHAT_WORK_WEBHOOK_URL，跳过')
  process.exit(0)
}

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ msgtype: 'markdown', markdown: { content: `## ${title}\n${content}` } }),
})
if (!res.ok) {
  console.error('企微告警发送失败：', res.status)
  process.exit(1)
}
console.log('企微告警已发送')
