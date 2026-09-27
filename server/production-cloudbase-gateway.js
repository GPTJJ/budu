import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PRODUCTION_WECHAT_APP_ID = 'wxfce0a3c4bb430023'
export const PRODUCTION_CLOUDBASE_ENV_ID = 'budu-d6gz358ixe39faf43'
export const PRODUCTION_DATABASE = 'budu_bj006'
export const PRODUCTION_APPSECRET_PATH = '/run/secrets/sweet-card/production-wechat.appsecret'
export const PRODUCTION_GATEWAY_SECRET_PATH = '/run/secrets/sweet-card/production-gateway-hmac.key'
export const GATEWAY_SIGNATURE_VERSION = 'v1'
export const GATEWAY_TOLERANCE_MS = 5 * 60 * 1000

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/

function databaseName(databaseUrl) {
  try {
    const parsed = new URL(String(databaseUrl || ''))
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

function readRootSecret(secretPath, io) {
  if (!path.isAbsolute(secretPath)) throw new Error('[config] production gateway secret path must be absolute')
  let stat
  let value
  try {
    stat = io.statSync(secretPath)
    value = String(io.readFileSync(secretPath, 'utf8')).trim()
  } catch {
    throw new Error('[config] production gateway secret file is unavailable')
  }
  const mode = stat.mode & 0o777
  if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || ![0o400, 0o440].includes(mode)) {
    throw new Error('[config] production gateway secret file permissions are unsafe')
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new Error('[config] production gateway secret file is invalid')
  }
  return value
}

export function validateProductionGatewayConfig(
  env = process.env,
  io = { statSync: fs.statSync, readFileSync: fs.readFileSync },
) {
  const enabled = String(env.SWEET_CARD_PRODUCTION_GATEWAY_ENABLED || '') === '1'
  if (!enabled) return { enabled: false }
  if (String(env.APP_ENV || '').trim().toLowerCase() !== 'prod') {
    throw new Error('[config] production gateway requires APP_ENV=prod')
  }
  if (databaseName(env.DATABASE_URL) !== PRODUCTION_DATABASE) {
    throw new Error('[config] production gateway requires budu_bj006')
  }
  if (String(env.SWEET_CARD_WECHAT_APP_ID || '').trim() !== PRODUCTION_WECHAT_APP_ID) {
    throw new Error('[config] production gateway AppID is not approved')
  }
  if (String(env.SWEET_CARD_CLOUDBASE_ENV_ID || '').trim() !== PRODUCTION_CLOUDBASE_ENV_ID) {
    throw new Error('[config] production gateway CloudBase environment is not approved')
  }
  const appSecretPath = String(env.SWEET_CARD_WECHAT_APP_SECRET_FILE || '').trim()
  const gatewaySecretPath = String(env.SWEET_CARD_PRODUCTION_GATEWAY_SECRET_FILE || '').trim()
  if (appSecretPath !== PRODUCTION_APPSECRET_PATH) {
    throw new Error('[config] production WeChat AppSecret path is not approved')
  }
  if (gatewaySecretPath !== PRODUCTION_GATEWAY_SECRET_PATH) {
    throw new Error('[config] production gateway HMAC path is not approved')
  }
  const appSecret = readRootSecret(appSecretPath, io)
  const gatewaySecret = readRootSecret(gatewaySecretPath, io)
  const markerKey = String(env.JWT_SECRET || '')
  if (markerKey.length < 16) throw new Error('[config] production customer-session marker key is unavailable')
  return {
    enabled: true,
    mode: 'production',
    appId: PRODUCTION_WECHAT_APP_ID,
    cloudBaseEnvId: PRODUCTION_CLOUDBASE_ENV_ID,
    database: PRODUCTION_DATABASE,
    appSecret,
    gatewaySecret,
    markerKey,
  }
}

export function gatewayBodyHash(body) {
  const serialized = body === undefined || body === null ? '' : JSON.stringify(body)
  return crypto.createHash('sha256').update(serialized).digest('hex')
}

export function productionGatewayPayload({ timestamp, nonce, method, requestPath, bodyHash, environment, appId }) {
  return [
    GATEWAY_SIGNATURE_VERSION,
    String(timestamp),
    String(nonce),
    String(method || '').toUpperCase(),
    String(requestPath || ''),
    String(bodyHash || ''),
    String(environment || ''),
    String(appId || ''),
  ].join('\n')
}

export function signProductionGatewayRequest(fields, secret) {
  return crypto.createHmac('sha256', secret)
    .update(productionGatewayPayload(fields))
    .digest('base64url')
}

export function createGatewayReplayGuard({ now = () => Date.now() } = {}) {
  const seen = new Map()
  return {
    consume(nonce, timestamp) {
      const current = now()
      for (const [key, expiresAt] of seen) if (expiresAt <= current) seen.delete(key)
      if (seen.has(nonce)) return false
      seen.set(nonce, Math.max(current, Number(timestamp)) + GATEWAY_TOLERANCE_MS)
      return true
    },
  }
}

export const productionGatewayReplayGuard = createGatewayReplayGuard()

function gatewayError(message, status) {
  return Object.assign(new Error(message), { status, publicSafe: true })
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function verifyProductionGatewayRequest(req, config, {
  replayGuard = productionGatewayReplayGuard,
  now = () => Date.now(),
} = {}) {
  if (!config?.enabled || config.mode !== 'production') throw gatewayError('PRODUCTION_GATEWAY_DISABLED', 403)
  const timestamp = String(req.get('x-budu-gateway-timestamp') || '').trim()
  const nonce = String(req.get('x-budu-gateway-nonce') || '').trim()
  const environment = String(req.get('x-budu-gateway-environment') || '').trim()
  const appId = String(req.get('x-budu-gateway-appid') || '').trim()
  const signature = String(req.get('x-budu-gateway-signature') || '').trim()
  if (!/^\d{13}$/.test(timestamp) || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) {
    throw gatewayError('PRODUCTION_GATEWAY_SIGNATURE_REQUIRED', 401)
  }
  if (environment !== config.cloudBaseEnvId || appId !== config.appId) {
    throw gatewayError('PRODUCTION_GATEWAY_SCOPE_DENIED', 403)
  }
  const numericTimestamp = Number(timestamp)
  if (!Number.isSafeInteger(numericTimestamp) || Math.abs(now() - numericTimestamp) > GATEWAY_TOLERANCE_MS) {
    throw gatewayError('PRODUCTION_GATEWAY_REQUEST_EXPIRED', 401)
  }
  const fields = {
    timestamp,
    nonce,
    method: req.method,
    requestPath: req.originalUrl,
    bodyHash: gatewayBodyHash(req.body),
    environment,
    appId,
  }
  const expected = signProductionGatewayRequest(fields, config.gatewaySecret)
  if (!safeEqual(signature, expected)) throw gatewayError('PRODUCTION_GATEWAY_SIGNATURE_DENIED', 401)
  if (!replayGuard.consume(nonce, numericTimestamp)) throw gatewayError('PRODUCTION_GATEWAY_REPLAYED', 409)
  return { verified: true, environment, appId, nonce }
}
