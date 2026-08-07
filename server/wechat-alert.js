/** 企业微信群机器人告警（Markdown） */

export async function sendWechatMarkdown(title, content) {
  const url = process.env.WECHAT_WORK_WEBHOOK_URL
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
