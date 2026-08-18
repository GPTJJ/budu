/** 企业微信群机器人告警（Markdown） */

// 私有仓库内置的企微群机器人 webhook（服务器 .env 未配置时兜底；该值仅能向群发消息，不能读取群内容）
const FALLBACK_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=91759b9b-d91c-4540-8648-70a78f139ee1'

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
