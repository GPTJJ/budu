import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import express from 'express'
import { createCustomerSession, authenticateCustomerSession, bearerToken, resolveOrCreateCustomerIdentity } from './customer-auth.js'
import { prisma } from './pg.js'

export const APPROVED_TEST_WECHAT_APP_ID = 'wxfce0a3c4bb430023'
export const APPROVED_TEST_DATABASE = 'budu_sc11a_test'
export const APPROVED_TEST_SECRET_PATH = '/run/secrets/sweet-card-wechat-appsecret'
export const APPROVED_TEST_GATEWAY_PREFIX = '/api/v2/test-sc11a'

const ENABLED_VALUE = '1'
const CODE_PATTERN = /^[A-Za-z0-9_-]{8,256}$/

function databaseName(databaseUrl) {
  try {
    const parsed = new URL(String(databaseUrl || ''))
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

export function validateWechatTestLoginConfig(
  env = process.env,
  io = { statSync: fs.statSync, readFileSync: fs.readFileSync },
) {
  const enabled = String(env.SWEET_CARD_WECHAT_LOGIN_HARNESS_ENABLED || '') === ENABLED_VALUE
  if (!enabled) return { enabled: false }

  if (String(env.APP_ENV || '').trim().toLowerCase() !== 'test') {
    throw new Error('[config] WeChat test login requires APP_ENV=test')
  }
  if (String(env.SWEET_CARD_WECHAT_APP_ID || '').trim() !== APPROVED_TEST_WECHAT_APP_ID) {
    throw new Error('[config] WeChat test login AppID is not approved')
  }
  if (databaseName(env.DATABASE_URL) !== APPROVED_TEST_DATABASE) {
    throw new Error('[config] WeChat test login requires budu_sc11a_test')
  }
  if (String(env.SWEET_CARD_WECHAT_GATEWAY_PREFIX || '').trim() !== APPROVED_TEST_GATEWAY_PREFIX) {
    throw new Error('[config] WeChat test login gateway is not approved')
  }

  const secretPath = String(env.SWEET_CARD_WECHAT_APP_SECRET_FILE || '').trim()
  if (secretPath !== APPROVED_TEST_SECRET_PATH || !path.isAbsolute(secretPath)) {
    throw new Error('[config] WeChat test login secret path is not approved')
  }

  let stat
  let secret
  try {
    stat = io.statSync(secretPath)
    secret = String(io.readFileSync(secretPath, 'utf8')).trim()
  } catch {
    throw new Error('[config] WeChat test login secret file is unavailable')
  }
  const mode = stat.mode & 0o777
  if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || ![0o400, 0o440].includes(mode)) {
    throw new Error('[config] WeChat test login secret file permissions are unsafe')
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) {
    throw new Error('[config] WeChat test login secret file is invalid')
  }
  const markerKey = String(env.JWT_SECRET || '')
  if (markerKey.length < 16) {
    throw new Error('[config] WeChat test login marker key is unavailable')
  }

  return {
    enabled: true,
    appId: APPROVED_TEST_WECHAT_APP_ID,
    database: APPROVED_TEST_DATABASE,
    secretPath,
    appSecret: secret,
    markerKey,
  }
}

function requestWechatSession({ appId, appSecret, code, timeoutMs = 8000 }) {
  const query = new URLSearchParams({
    appid: appId,
    secret: appSecret,
    js_code: code,
    grant_type: 'authorization_code',
  })
  return new Promise((resolve, reject) => {
    const request = https.request({
      method: 'GET',
      hostname: 'api.weixin.qq.com',
      port: 443,
      path: `/sns/jscode2session?${query}`,
      headers: { accept: 'application/json' },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 32768) request.destroy(new Error('WECHAT_RESPONSE_TOO_LARGE'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('WECHAT_INVALID_RESPONSE'))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('WECHAT_TIMEOUT')))
    request.on('error', reject)
    request.end()
  })
}

function httpError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

export async function resolveWechatTestIdentity({ code, config, exchange = requestWechatSession }) {
  const proof = await resolveWechatIdentityProof({ code, config, exchange })
  return {
    ok: true,
    wechatIdentityResolved: true,
    identityMarker: proof.identityMarker,
    environment: 'test',
    databaseAuthority: APPROVED_TEST_DATABASE,
  }
}

export async function resolveWechatIdentityProof({ code, config, exchange = requestWechatSession }) {
  const normalizedCode = String(code || '').trim()
  if (!normalizedCode) throw httpError('WECHAT_CODE_REQUIRED', 400)
  if (!CODE_PATTERN.test(normalizedCode)) throw httpError('WECHAT_CODE_INVALID', 400)

  let result
  try {
    result = await exchange({
      appId: config.appId,
      appSecret: config.appSecret,
      code: normalizedCode,
    })
  } catch (error) {
    if (error?.message === 'WECHAT_TIMEOUT') throw httpError('WECHAT_UPSTREAM_TIMEOUT', 504)
    throw httpError('WECHAT_UPSTREAM_UNAVAILABLE', 502)
  }
  if (!result || typeof result !== 'object') throw httpError('WECHAT_UPSTREAM_INVALID', 502)
  if (Number.isFinite(Number(result.errcode)) && Number(result.errcode) !== 0) {
    throw httpError('WECHAT_CODE_REJECTED', 401)
  }
  const openId = String(result.openid || '').trim()
  if (!openId) throw httpError('WECHAT_IDENTITY_UNRESOLVED', 401)

  const identityMarker = crypto.createHmac('sha256', config.markerKey)
    .update(`${config.appId}\n${openId}`)
    .digest('hex')
    .slice(0, 12)
  return { openId, unionId: String(result.unionid || '').trim() || null, identityMarker: `test-${identityMarker}` }
}

export function createWechatTestLoginRouter({
  configLoader = validateWechatTestLoginConfig,
  exchange = requestWechatSession,
  db = prisma,
} = {}) {
  const router = express.Router()
  router.post('/live-verify', async (req, res) => {
    if (String(process.env.APP_ENV || '').trim().toLowerCase() !== 'test'
        || req.get('x-budu-test-gateway') !== '1') {
      return res.status(404).json({ error: 'NOT_FOUND' })
    }
    try {
      const config = configLoader(process.env)
      if (!config.enabled) return res.status(404).json({ error: 'NOT_FOUND' })
      return res.json(await resolveWechatTestIdentity({ code: req.body?.code, config, exchange }))
    } catch (error) {
      const status = Number(error?.status) || 503
      return res.status(status).json({ error: error?.message || 'WECHAT_LOGIN_VERIFY_UNAVAILABLE' })
    }
  })
  router.post('/session', async (req, res) => {
    if (String(process.env.APP_ENV || '').trim().toLowerCase() !== 'test'
        || req.get('x-budu-test-gateway') !== '1') {
      return res.status(404).json({ error: 'NOT_FOUND' })
    }
    if (['userId', 'openid', 'openId', 'unionid', 'unionId'].some(key => Object.hasOwn(req.body || {}, key))) {
      return res.status(400).json({ error: 'IDENTITY_AUTHORITY_SPOOF_REJECTED' })
    }
    try {
      const config = configLoader(process.env)
      if (!config.enabled) return res.status(404).json({ error: 'NOT_FOUND' })
      const proof = await resolveWechatIdentityProof({ code: req.body?.code, config, exchange })
      const identity = await resolveOrCreateCustomerIdentity({
        appId: config.appId, openId: proof.openId, unionId: proof.unionId, db,
      })
      const session = await createCustomerSession({ userId: identity.userId, markerKey: config.markerKey, db })
      return res.json({
        ok: true,
        wechatIdentityResolved: true,
        userResolved: true,
        customerRef: session.customerRef,
        customerSession: session.rawToken,
        expiresAt: session.expiresAt.toISOString(),
        environment: 'test',
        databaseAuthority: APPROVED_TEST_DATABASE,
      })
    } catch (error) {
      return res.status(Number(error?.status) || 503).json({ error: error?.message || 'WECHAT_SESSION_UNAVAILABLE' })
    }
  })
  router.post('/session/verify', async (req, res) => {
    if (String(process.env.APP_ENV || '').trim().toLowerCase() !== 'test'
        || req.get('x-budu-test-gateway') !== '1') {
      return res.status(404).json({ error: 'NOT_FOUND' })
    }
    try {
      const config = configLoader(process.env)
      const session = await authenticateCustomerSession({
        rawToken: bearerToken(req.get('authorization')), markerKey: config.markerKey, db,
      })
      return res.json({ ok: true, customerRef: session.customerRef })
    } catch (error) {
      return res.status(Number(error?.status) || 503).json({ error: error?.message || 'CUSTOMER_SESSION_UNAVAILABLE' })
    }
  })
  return router
}

export const wechatTestLoginRouter = createWechatTestLoginRouter()
