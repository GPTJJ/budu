import { validateWechatLoginConfig } from './wechat-test-login.js'
import { claimSceneReference } from './sweet-card-claim.js'
import { miniprogramAccessToken, invalidateMiniprogramToken } from './wechat-access-token.js'

export const CLAIM_MINIPROGRAM_PAGE = 'pages/sweet-card-claim/sweet-card-claim'
const fail = () => Object.assign(new Error('微信小程序码生成失败，请稍后重试；原领取凭证未变更'), { status: 503, publicCode: 'SERVER_ERROR' })

// Official API only. Never log provider URLs, tokens, response bodies or AppSecret.
export async function createOfficialClaimCode({ credentialId, config = validateWechatLoginConfig(), fetchImpl = fetch, now = Date.now }) {
  const scene = claimSceneReference(credentialId)
  if (!config.enabled || !config.appId || !config.appSecret) throw fail()
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
  // The access token comes from the shared MiniProgram token authority. This
  // module must not keep its own cache: two caches for one appid thrash, because
  // WeChat invalidates the previously issued token.
  const token = await miniprogramAccessToken({ config, fetchImpl, now })
  if (!token) throw fail()
  const response = await request(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
    scene, page: CLAIM_MINIPROGRAM_PAGE, check_path: true,
    env_version: config.mode === 'production' ? 'release' : 'trial',
    width: 1000, auto_color: false, is_hyaline: false,
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  // WeChat reports errors as JSON even with HTTP 200. Never render that as a code.
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if ((!png && !jpeg) || bytes.length < 100 || bytes.length > 2_000_000) {
    // A rejected token must not stay cached; drop it so the next caller refetches.
    invalidateMiniprogramToken(config)
    throw fail()
  }
  return `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`
}
