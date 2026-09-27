/** 企业微信群机器人告警（Markdown）。webhook 只认运行环境显式配置。 */

export function wecomWebhookUrl() {
  return String(process.env.WECHAT_WORK_WEBHOOK_URL || '').trim()
}

export async function sendWechatMarkdownResult(title, content) {
  const url = wecomWebhookUrl()
  if (!url) return { ok: false, errcode: 'CONFIG_MISSING', errmsg: 'WECHAT_WORK_WEBHOOK_URL 未配置' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: `## ${title}\n${content}` },
      }),
    })
    const body = await res.json().catch(() => ({}))
    return {
      ok: res.ok && body.errcode === 0,
      errcode: body.errcode ?? `HTTP_${res.status}`,
      errmsg: String(body.errmsg || '').slice(0, 200),
    }
  } catch (e) {
    console.error('[wechat-alert]', e.message)
    return { ok: false, errcode: 'LOCAL_ERROR', errmsg: 'local delivery error' }
  }
}

export async function sendWechatMarkdown(title, content) {
  return (await sendWechatMarkdownResult(title, content)).ok
}
