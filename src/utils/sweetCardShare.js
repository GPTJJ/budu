import { api } from './api'

export const SWEET_CARD_DEFAULT_NOTE = 'With a little sweetness, from budu.'
export const CLAIM_PAGE_PATH = 'pages/sweet-card-claim/sweet-card-claim'
/** 发卡人一侧的原生转发承载页：只展示 + 调起 open-type=share，绝不领取。 */
export const SHARE_PAGE_PATH = 'pages/sweet-card-share/sweet-card-share'

/** 环境 A：budu OS 页面被装进 budu 小程序 web-view 中运行。 */
export function isWechatMiniProgramWebview(scope = typeof window === 'undefined' ? null : window) {
  if (!scope) return false
  if (scope.__wxjs_environment === 'miniprogram') return true
  const bridge = scope.wx && scope.wx.miniProgram
  return Boolean(bridge && typeof bridge.navigateTo === 'function')
}

/**
 * 领取凭据在微信侧的可公开引用：credentialId 去掉连字符即为 32 位十六进制 scene 引用。
 * 服务端 claimCredentialLookup 同时接受该引用与一次性 token，因此链接不需要暴露 token 明文。
 */
export function claimSceneReference(credentialId) {
  const scene = String(credentialId || '').replaceAll('-', '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(scene) && scene[12] === '4' ? scene : ''
}

export function buildClaimQuery(credentialId) {
  const scene = claimSceneReference(credentialId)
  return scene ? `claimToken=${scene}` : ''
}

export function buildClaimPath(credentialId) {
  const query = buildClaimQuery(credentialId)
  return query ? `/${CLAIM_PAGE_PATH}?${query}` : ''
}

/**
 * 环境 A 的跳转目标：原生转发承载页（不是领取页）。
 * 承载页没有任何领取调用，发卡人进去不会误领自己的卡。
 */
export function buildSharePath(credentialId, { cardId, amountText, note } = {}) {
  const query = buildClaimQuery(credentialId)
  if (!query) return ''
  const params = new URLSearchParams()
  if (cardId) params.set('cardId', String(cardId))
  if (amountText) params.set('amount', String(amountText))
  params.set('note', String(note || SWEET_CARD_DEFAULT_NOTE))
  return `/${SHARE_PAGE_PATH}?${query}&${params.toString()}`
}

export function shareCopy(amountText, urlLink) {
  // formatCents 已经带 ¥，这里统一去掉再补，避免出现「¥¥200.00」。
  const amount = String(amountText || '').replace(/^[¥￥\s]+/, '').trim()
  const face = amount ? `¥${amount} ` : ''
  return `${SWEET_CARD_DEFAULT_NOTE} 送你一张 ${face}budu SWEET CARD · 甜意卡，点击直达领取 👉 ${urlLink}`
}

export async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* 落到兼容路径 */ }
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch { copied = false }
  document.body.removeChild(area)
  return copied
}

/** 微信短链只有微信内置浏览器能打开；外部浏览器仅用于「唤起微信去粘贴」。 */
export function openWeixinScheme() {
  if (typeof window === 'undefined') return false
  try {
    window.location.href = 'weixin://'
    return true
  } catch {
    return false
  }
}

export function navigateInsideMiniProgram(url) {
  if (typeof window === 'undefined' || !window.wx || !window.wx.miniProgram) return false
  try {
    window.wx.miniProgram.navigateTo({ url })
    return true
  } catch {
    return false
  }
}

/** 微信 URL Scheme：weixin://dl/business/?t=...，聊天框内点击直接拉起小程序（无中转网页白屏）。 */
export const URL_SCHEME_PATTERN = /^weixin:\/\/dl\/business\/\?t=[A-Za-z0-9_-]{8,128}$/
export const URL_LINK_PATTERN = /^https:\/\/(wxaurl|wxmpurl)\.cn\/[^/]+/

export function isWechatUrlScheme(value) {
  return URL_SCHEME_PATTERN.test(String(value || ''))
}

/**
 * 环境 B：服务端并行生成 URL Scheme（优先）与短链（兜底）。
 * 复制给好友的必须是 Scheme —— 短链会先落到「此网页由 wxmpurl.cn 提供」的中转页，实机经常白屏。
 */
export async function requestClaimShareLink(cardId) {
  const result = await api(`/v2/sweet-cards/cards/${encodeURIComponent(cardId)}/claim-url-link`, { method: 'POST', body: JSON.stringify({}) })
  const schemeUrl = String(result && result.schemeUrl || '')
  const urlLink = String(result && result.urlLink || '')
  const link = isWechatUrlScheme(schemeUrl) ? schemeUrl : (URL_LINK_PATTERN.test(urlLink) ? urlLink : '')
  if (!link) {
    const error = new Error('微信链接生成结果不可用')
    error.code = 'URL_LINK_INVALID'
    throw error
  }
  return {
    link,
    kind: link === schemeUrl ? 'scheme' : 'url-link',
    schemeUrl,
    urlLink,
    channel: result.channel || '',
    expiresAt: result.expiresAt || null,
    credentialId: result.credentialId || null,
  }
}

export function shareFailureMessage(error) {
  const code = String(error && (error.code || error.data?.code || error.message) || '')
  if (/NOT_CONFIGURED|UNAVAILABLE|SERVER_ERROR|UPSTREAM_ERROR/.test(code)) return '微信链接服务当前不可用，请改用小程序内转发'
  if (/CLAIM_CREDENTIAL/.test(code)) return '这张卡还没有可用的领取凭据，请先生成电子卡'
  if (/URL_LINK_INVALID|URL_SCHEME_INVALID/.test(code)) return '微信链接生成结果不可用，请稍后重试'
  return error?.message || '转发准备失败，请稍后重试'
}
