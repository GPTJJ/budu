/**
 * Single authority for the WeChat **MiniProgram** app-level access_token.
 *
 * Why this module exists: WeChat's `cgi-bin/token` and `cgi-bin/stable_token`
 * endpoints invalidate each other's tokens. Two independent caches for the same
 * appid therefore thrash, and the symptom is intermittent 40001 when more than
 * one feature (mini program code, logistics, notification) asks for a token in
 * the same window. Everything that needs this token must come through here.
 * Do not add a second cache for the same appid anywhere else.
 *
 * Uses stable_token because it is the endpoint WeChat documents for multiple
 * consumers of one appid. The secret is never logged, never returned, and never
 * placed in an error message; only the token value leaves this module, and only
 * to the caller that needs to sign a request.
 */
const EXPIRY_SAFETY_MS = 120 * 1000
const cache = new Map()

/** Test-only: drop the cached token so the next call refetches. */
export function _resetMiniprogramTokenAuthority() {
  cache.clear()
}

/**
 * Drop the cached token for one config. Call this when a downstream WeChat API
 * rejects the token (40001/40014) so the next caller refetches instead of
 * reusing a token WeChat has already invalidated.
 */
export function invalidateMiniprogramToken(config) {
  if (config && config.appId) cache.delete(config.appId)
}

function usable(config) {
  return !!(config && config.appId && config.appSecret)
}

/**
 * Resolve the MiniProgram access_token.
 *
 * @param {object}   options.config        `{ appId, appSecret, mode }` — the shape returned by validateWechatLoginConfig()
 * @param {Function} options.fetchImpl     injectable for tests
 * @param {Function} options.now           injectable clock
 * @param {boolean}  options.forceRefresh  skip the cache (used after a 40001)
 * @returns {Promise<string>}              '' when unavailable — callers must treat '' as "cannot call the API", never retry blindly
 */
export async function miniprogramAccessToken({ config, fetchImpl = fetch, now = Date.now, forceRefresh = false } = {}) {
  if (!usable(config)) return ''
  // Keyed on appid alone: the access_token is a per-appid resource. `mode`
  // selects which mini program code version is generated, not the token, so
  // including it would split the cache and reintroduce token thrashing.
  const key = config.appId
  const cached = cache.get(key)
  if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value
  try {
    const response = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: config.appId,
        secret: config.appSecret,
        force_refresh: false,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response || !response.ok) return ''
    const body = await response.json()
    if (body.errcode || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 120) return ''
    cache.set(key, { value: body.access_token, expiresAt: now() + (body.expires_in * 1000) - EXPIRY_SAFETY_MS })
    return body.access_token
  } catch {
    return ''
  }
}

/**
 * Adapter for callers that already hold an (appId, secret) pair instead of a
 * config object. Same cache, same endpoint — it is not a second authority.
 */
export async function mpAccessToken(appId, secret, { mode, fetchImpl, now } = {}) {
  return miniprogramAccessToken({ config: { appId, secret, mode }, fetchImpl, now })
}
