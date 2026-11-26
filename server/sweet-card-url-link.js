import { validateWechatLoginConfig } from './wechat-test-login.js'
import { miniprogramAccessToken, invalidateMiniprogramToken } from './wechat-access-token.js'
import { claimSceneReference } from './sweet-card-claim.js'

/**
 * 环境 B 的两种微信侧入口：
 * 1. URL Scheme（`/wxa/generatescheme`）→ `weixin://dl/business/?t=...`，微信聊天框内点击可**直接拉起小程序**，
 *    不经过 wxmpurl.cn 的中转网页（实测该中转页在部分机型/网络下会停在「此网页由 wxmpurl.cn 提供」白屏）。
 * 2. URL Link（`/wxa/generate_urllink`）→ `https://wxmpurl.cn/...`，作为 Scheme 不可用时的兜底。
 *
 * 约束：
 * - 只接受领取凭据的服务端 UUID，对外只暴露 scene 引用（32 位十六进制），从不返回 token 明文。
 * - access_token 只来自 wechat-access-token.js 的单一权威缓存；被微信拒绝时失效一次并重试一次。
 * - 不记录 access_token、AppSecret、请求体或响应体。
 */
export const CLAIM_URL_LINK_PAGE = 'pages/sweet-card-claim/sweet-card-claim'
// generate_scheme 的 path 是「小程序页面路径」，官方示例不带前导斜杠；带斜杠在部分客户端会被判为非法路径而回落到默认首页/线上版。
export const CLAIM_URL_SCHEME_PATH = 'pages/sweet-card-claim/sweet-card-claim'
/**
 * 微信短链域名白名单。2026-11 起 /wxa/generate_urllink 实际返回 https://wxmpurl.cn/...，
 * 旧域名 wxaurl.cn 仍可能有存量数据，两者都接受；其它域名一律拒绝（防开放跳转）。
 */
export const URL_LINK_HOSTS = new Set(['wxaurl.cn', 'wxmpurl.cn'])

export function isWechatUrlLink(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && URL_LINK_HOSTS.has(url.hostname) && url.pathname.length > 1
  } catch {
    return false
  }
}

/**
 * URL Scheme 形如 `weixin://dl/business/?t=AbCd1234`（不是 http URL，不能用 URL 解析约束 host）。
 * 只接受微信官方前缀 + 字母数字票据，防止把任意深链写进剪贴板。
 */
export const URL_SCHEME_PATTERN = /^weixin:\/\/dl\/business\/\?t=[A-Za-z0-9_-]{8,128}$/

export function isWechatUrlScheme(value) {
  return URL_SCHEME_PATTERN.test(String(value || ''))
}
const TOKEN_REJECTED = new Set([40001, 40014, 42001])

const linkError = (message, publicCode) => Object.assign(new Error(message), { status: 503, publicCode })

/**
 * 默认打开正式版；候选/真机联调需要指向体验版时，用 WECHAT_URLLINK_ENV_VERSION=trial 显式覆盖
 * （该变量同时作用于 URL Scheme 与 URL Link，避免两条通道指向不同版本）。
 * 不设置时行为与原先完全一致（生产 release / 非生产 trial）。
 */
const ENV_VERSIONS = new Set(['release', 'trial', 'develop'])

function normalizeEnvVersion(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ENV_VERSIONS.has(normalized) ? normalized : ''
}

function envVersionFor(config) {
  const override = normalizeEnvVersion(process.env.WECHAT_URLLINK_ENV_VERSION)
  if (override) return override
  return config.mode === 'production' ? 'release' : 'trial'
}

async function postJson(fetchImpl, url, body, label, upstreamCode) {
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!response || !response.ok) throw linkError(`微信${label}生成失败，请稍后重试`, upstreamCode)
  return response.json()
}

/**
 * 取 token → 调微信接口；token 被拒（40001/40014/42001）时作废缓存并重试一次。
 * 只把 errcode 挂在错误对象上用于排查，不记录请求体/响应体/access_token。
 */
async function callWechat({ endpoint, body, label, codes, config, fetchImpl, now }) {
  const request = async (forceRefresh) => {
    const token = await miniprogramAccessToken({ config, fetchImpl, now, forceRefresh })
    if (!token) throw linkError(`微信${label}服务暂不可用`, codes.token)
    const payload = await postJson(fetchImpl, `https://api.weixin.qq.com${endpoint}?access_token=${encodeURIComponent(token)}`, body, label, codes.upstream)
    if (payload && payload.errcode) {
      if (TOKEN_REJECTED.has(payload.errcode) && !forceRefresh) return null
      throw Object.assign(linkError(`微信${label}生成被拒绝`, codes.rejected), { wechatErrcode: payload.errcode })
    }
    return payload
  }
  let payload = await request(false)
  if (payload === null) {
    invalidateMiniprogramToken(config)
    payload = await request(true)
  }
  return payload
}

function requireReady(credentialId, config, publicCode) {
  const scene = claimSceneReference(credentialId)
  if (!scene) throw linkError('领取凭据引用无效', 'CLAIM_REFERENCE_INVALID')
  if (!config.enabled || !config.appId || !config.appSecret) throw linkError('微信链接服务未启用', publicCode)
  return scene
}

/**
 * URL Scheme：`weixin://dl/business/?t=...`。微信聊天框内直接点击即可拉起小程序
 * （无 wxmpurl.cn 中转网页，因此不会停在「此网页由 wxmpurl.cn 提供」的白屏）。
 */
export async function createClaimUrlScheme({
  credentialId,
  expireDays = 7,
  envVersion,
  config = validateWechatLoginConfig(),
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const scene = requireReady(credentialId, config, 'URL_SCHEME_NOT_CONFIGURED')
  const body = {
    jump_wxa: {
      path: CLAIM_URL_SCHEME_PATH,
      query: `claimToken=${scene}`,
      env_version: normalizeEnvVersion(envVersion) || envVersionFor(config),
    },
    expire_type: 1,
    expire_interval: Math.min(30, Math.max(1, Number(expireDays) || 7)),
  }
  const payload = await callWechat({
    endpoint: '/wxa/generatescheme',
    body,
    label: ' URL Scheme ',
    codes: { token: 'URL_SCHEME_TOKEN_UNAVAILABLE', upstream: 'URL_SCHEME_UPSTREAM_ERROR', rejected: 'URL_SCHEME_REJECTED' },
    config, fetchImpl, now,
  })
  const schemeUrl = String(payload && payload.openlink || '')
  if (!isWechatUrlScheme(schemeUrl)) throw linkError('微信 URL Scheme 生成结果不可用', 'URL_SCHEME_INVALID')
  return { schemeUrl, credentialId: scene, expireDays: body.expire_interval, envVersion: body.jump_wxa.env_version }
}

/** URL Link：`https://wxmpurl.cn/...`，Scheme 不可用时的兜底通道。 */
export async function createClaimUrlLink({
  credentialId,
  expireDays = 7,
  config = validateWechatLoginConfig(),
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const scene = requireReady(credentialId, config, 'URL_LINK_NOT_CONFIGURED')
  const body = {
    path: CLAIM_URL_LINK_PAGE,
    query: `claimToken=${scene}`,
    env_version: envVersionFor(config),
    expire_type: 1,
    expire_interval: Math.min(30, Math.max(1, Number(expireDays) || 7)),
  }
  const payload = await callWechat({
    endpoint: '/wxa/generate_urllink',
    body,
    label: '短链',
    codes: { token: 'URL_LINK_TOKEN_UNAVAILABLE', upstream: 'URL_LINK_UPSTREAM_ERROR', rejected: 'URL_LINK_REJECTED' },
    config, fetchImpl, now,
  })
  const urlLink = String(payload && payload.url_link || '')
  if (!isWechatUrlLink(urlLink)) throw linkError('微信短链生成结果不可用', 'URL_LINK_INVALID')
  return { urlLink, credentialId: scene, expireDays: body.expire_interval }
}

/**
 * 转发入口：并行生成 Scheme 与短链，Scheme 优先（微信内可直拉小程序），短链兜底。
 * 任一成功即返回，两个都失败才抛错（优先抛 Scheme 的错误，便于前端提示）。
 */
export async function createClaimShareLink({ credentialId, expireDays = 7, config, fetchImpl, now } = {}) {
  const options = { credentialId, expireDays, config, fetchImpl, now }
  const [scheme, link] = await Promise.allSettled([createClaimUrlScheme(options), createClaimUrlLink(options)])
  const schemeValue = scheme.status === 'fulfilled' ? scheme.value : null
  const linkValue = link.status === 'fulfilled' ? link.value : null
  if (!schemeValue && !linkValue) throw (scheme.reason || link.reason)
  return {
    schemeUrl: schemeValue ? schemeValue.schemeUrl : '',
    urlLink: linkValue ? linkValue.urlLink : '',
    channel: schemeValue ? 'WECHAT_URL_SCHEME' : 'WECHAT_URL_LINK',
    degraded: !schemeValue,
    credentialId: schemeValue ? schemeValue.credentialId : linkValue.credentialId,
    expireDays,
    envVersion: schemeValue ? schemeValue.envVersion : '',
  }
}
