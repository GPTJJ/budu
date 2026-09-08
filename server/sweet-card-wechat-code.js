import { validateWechatLoginConfig } from './wechat-test-login.js'
import { claimSceneReference } from './sweet-card-claim.js'

export const CLAIM_MINIPROGRAM_PAGE = 'pages/sweet-card-claim/sweet-card-claim'
const fail = () => Object.assign(new Error('微信小程序码生成失败，请稍后重试；原领取凭证未变更'), { status: 503, publicCode: 'SERVER_ERROR' })
const cache = new Map()

// Official API only. Never log provider URLs, tokens, response bodies or AppSecret.
export async function createOfficialClaimCode({ credentialId, config = validateWechatLoginConfig(), fetchImpl = fetch, now = Date.now }) {
  const scene = claimSceneReference(credentialId)
  if (!config.enabled || !config.appId || !config.appSecret) throw fail()
  const cacheKey = `${config.mode}:${config.appId}`
  const request = async (url, body) => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw fail()
      return response
    } catch { throw fail() }
  }
  let token = cache.get(cacheKey)
  if (!token || token.expiresAt <= now()) {
    let result
    try {
      result = await (await request('https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: config.appId, secret: config.appSecret,
        force_refresh: false,
      })).json()
    } catch { throw fail() }
    if (result.errcode || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 120) throw fail()
    token = { value: result.access_token, expiresAt: now() + (result.expires_in - 120) * 1000 }
    cache.set(cacheKey, token)
  }
  const response = await request(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token.value)}`, {
    scene, page: CLAIM_MINIPROGRAM_PAGE, check_path: true,
    env_version: config.mode === 'production' ? 'release' : 'trial',
    width: 1000, auto_color: false, is_hyaline: false,
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  // WeChat reports errors as JSON even with HTTP 200. Never render that as a code.
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if ((!png && !jpeg) || bytes.length < 100 || bytes.length > 2_000_000) {
    cache.delete(cacheKey)
    throw fail()
  }
  return `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`
}
