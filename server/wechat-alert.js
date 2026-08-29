/** 企业微信群机器人告警（Markdown） */

// 私有仓库内置的企微群机器人 webhook（服务器 .env 未配置时兜底；该值仅能向群发消息，不能读取群内容）
// 2026-08-26：群机器人被移除后重新添加，webhook key 已更换（旧 key=91759b9b-d91c-4540-8648-70a78f139ee1 已废弃）
const FALLBACK_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=b2181357-fc56-4847-bfd1-3d997f314d7a'

export function wecomWebhookUrl() {
  return process.env.WECHAT_WORK_WEBHOOK_URL || FALLBACK_WEBHOOK_URL
}

export async function sendWechatMarkdown(title, content) {
  const url = wecomWebhookUrl()
  if (!url) return false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: `## ${title}\n${content}` },
      }),
    })
    return res.ok
  } catch (e) {
    console.error('[wechat-alert]', e.message)
    return false
  }
}
