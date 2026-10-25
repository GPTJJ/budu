import crypto from 'node:crypto'
import express from 'express'
import { authenticateCustomerSession, bearerToken } from './customer-auth.js'
import { verifyProductionGatewayRequest, gatewayBodyHash, signProductionGatewayRequest, createGatewayReplayGuard } from './production-cloudbase-gateway.js'
import { validateWechatLoginConfig } from './wechat-test-login.js'
import { miniprogramAccessToken } from './wechat-access-token.js'
import { createFixedWindowLimiter, httpError } from './customer-request-core.js'
import { submitCustomerServiceRequest } from './customer-requests.js'
import { assertServiceStaff, serviceDetail, resolveServiceScene, listCustomerServices, recordServiceVisit, sceneHash, confirmService } from './store-service-core.js'
import { serviceTemplates, createServiceWechatSender, deliverStoreServiceOnce } from './store-service-notifications.js'
import { queryServiceConversion } from './store-service-conversion.js'

const TEST_ENV = 'budu-test-d8gwb4xwy41dc6c61'
// The existing TEST proxy replaces /api/v2/test-sc11a/ with /api/.
// Recover only these canonical signing paths; never trust forwarded URL headers
// or normalize a non-canonical path that reaches this application.
const TEST_GATEWAY_PATHS = new Map(['capabilities', 'resolve', 'submit', 'list', 'detail', 'visit-mall']
  .map(action => [`/api/customer/store-services/${action}`, `/api/v2/test-sc11a/customer/store-services/${action}`]))
const hash = s => crypto.createHash('sha256').update(s).digest('hex')
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
export function loadStoreServiceConfig(env = process.env) {
  if (env.STORE_SERVICE_RUNTIME_ENABLED !== '1') return null
  const config = validateWechatLoginConfig(env)
  if (!config.enabled) throw Error('STORE_SERVICE_LOGIN_CONFIG_REQUIRED')
  if (config.mode === 'production') return config
  if (config.mode !== 'test' || !/^[A-Za-z0-9_-]{32,128}$/.test(env.STORE_SERVICE_TEST_GATEWAY_SECRET || '')) throw Error('STORE_SERVICE_TEST_GATEWAY_CONFIG_REQUIRED')
  return { ...config, cloudBaseEnvId: TEST_ENV, gatewaySecret: env.STORE_SERVICE_TEST_GATEWAY_SECRET }
}
function verifyServiceGateway(req, config, replayGuard) {
  if (config?.mode === 'production') return verifyProductionGatewayRequest(req, config, { replayGuard })
  const requestPath = TEST_GATEWAY_PATHS.get(req.originalUrl)
  if (!config?.enabled || config.mode !== 'test' || config.cloudBaseEnvId !== TEST_ENV || config.appId !== 'wxfce0a3c4bb430023'
    || req.method !== 'POST' || !requestPath) throw httpError('身份核验失败', 403)
  const timestamp = req.get('x-budu-gateway-timestamp') || '', nonce = req.get('x-budu-gateway-nonce') || ''
  const signature = req.get('x-budu-gateway-signature') || ''
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000 || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)
    || req.get('x-budu-gateway-environment') !== config.cloudBaseEnvId || req.get('x-budu-gateway-appid') !== config.appId) throw httpError('身份核验失败', 401)
  const expected = signProductionGatewayRequest({ timestamp, nonce, method: req.method, requestPath,
    bodyHash: gatewayBodyHash(req.body), environment: config.cloudBaseEnvId, appId: config.appId }, config.gatewaySecret)
  if (!equal(signature, expected) || !replayGuard.consume(nonce, Number(timestamp))) throw httpError('身份核验失败', 401)
}
const publicCode = error => error.code === 'SERVICE_DISABLED' ? 'SERVICE_DISABLED' : error.code === 'STORE_CLOSED' ? 'STORE_CLOSED'
  : error.status === 401 ? 'CUSTOMER_SESSION_EXPIRED' : error.status === 403 ? 'CUSTOMER_SESSION_DENIED'
    : error.status === 404 ? 'SERVICE_NOT_FOUND' : error.status === 410 ? 'SERVICE_CODE_EXPIRED'
      : error.status === 409 ? 'SERVICE_CODE_USED' : error.status === 400 ? 'SERVICE_INVALID_INPUT'
        : error.status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE'
export function createStoreServiceCustomerRouter({ db, config, env = process.env, deliverInternal = true }) {
  const router = express.Router(), replayGuard = createGatewayReplayGuard(), templates = serviceTemplates(env)
  const limiter = createFixedWindowLimiter({ limit: 120, windowMs: 600000 })
  const handle = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      verifyServiceGateway(req, config, replayGuard)
      const rawToken = bearerToken(req.get('authorization'))
      if (!rawToken || req.body?.sessionHash !== hash(rawToken)) throw httpError('请重新登录', 401)
      const session = await authenticateCustomerSession({ rawToken, markerKey: config.markerKey, db })
      if (typeof req.body.openId !== 'string' || !req.body.openId || req.body.openId.length > 128) throw httpError('身份核验失败', 401)
      const identity = await db.weChatAuthIdentity.findUnique({ where: { provider_appId_openId: {
        provider: 'WECHAT_MINIPROGRAM', appId: config.appId, openId: req.body.openId } } })
      if (identity?.userId !== session.userId) throw httpError('身份核验失败', 403)
      if (!limiter.consume(session.userId).allowed) throw httpError('操作过于频繁', 429)
      const customer = { userId: session.userId, appId: config.appId, envId: config.cloudBaseEnvId, openId: identity.openId }
      res.json({ ok: true, result: await fn(req.body, customer) })
    } catch (error) {
      const code = publicCode(error)
      res.status([400, 401, 403, 404, 409, 410, 429].includes(error.status) ? error.status : 503).json({ ok: false, error: code, code })
    }
  }
  const admissions = () => { if (env.STORE_SERVICE_SUBMISSIONS_ENABLED !== '1') throw Object.assign(httpError('服务暂未开放', 503), { code: 'SERVICE_DISABLED' }) }
  router.post('/capabilities', handle(async () => ({ enabled: env.STORE_SERVICE_SUBMISSIONS_ENABLED === '1', templateIds: {
    MAILING: templates.MAILING?.id || '', INVOICE: templates.INVOICE?.id || '' } })))
  router.post('/resolve', handle(async (body, customer) => resolveServiceScene(db, body.scene, customer)))
  router.post('/submit', handle(async (body, customer) => {
    // Same-owner response recovery remains available when new admissions are off.
    if (env.STORE_SERVICE_SUBMISSIONS_ENABLED !== '1') {
      const existing = await resolveServiceScene(db, body.scene, customer)
      if (existing.submittedRequestId) return { requestId: existing.submittedRequestId, type: existing.request.type, status: 'SUBMITTED' }
      admissions()
    }
    const t = await db.customerServiceRequestToken.findUnique({ where: { miniSceneHash: sceneHash(body.scene) || 'invalid' }, include: { request: true } })
    const template = templates[t?.request.type]
    const subscription = { status: ['accept', 'reject', 'cancel', 'unavailable'].includes(body.subscription?.status) ? body.subscription.status : 'unavailable',
      templateId: template?.id && body.subscription?.templateId === template.id ? template.id : null }
    return submitCustomerServiceRequest({ prismaClient: db, miniScene: body.scene, payload: body.payload,
      customerIdentity: customer, subscription, deliverInternal })
  }))
  router.post('/list', handle((body, customer) => listCustomerServices(db, customer, body)))
  router.post('/detail', handle((body, customer) => serviceDetail(db, body.requestId, customer)))
  router.post('/visit-mall', handle(async (body, customer) => {
    const result = await serviceDetail(db, body.requestId, customer)
    await recordServiceVisit(db, result.request, customer, 'MALL')
    return { ok: true }
  }))
  return router
}
export async function generateStoreServiceCode({ db, requestId, user, config, env = process.env, fetchImpl = fetch }) {
  if (env.STORE_SERVICE_QR_ENABLED !== '1' || env.STORE_SERVICE_SUBMISSIONS_ENABLED !== '1' || !config?.enabled) throw httpError('小程序入口尚未开启，可继续使用网页填写码', 503)
  if (config.mode === 'production' && env.STORE_SERVICE_RELEASE_PATH_READY !== '1') throw httpError('小程序正式路径尚未确认发布', 503)
  const r = await db.customerServiceRequest.findUnique({ where: { id: requestId } })
  if (!r) throw httpError('申请不存在', 404)
  assertServiceStaff(user, r)
  if (config.mode !== 'production' && user.role !== 'developer') throw httpError('开发二维码仅开发者可生成', 403)
  if (r.status !== 'WAITING_CUSTOMER' || r.expiresAt <= new Date()) throw httpError('填写码已失效', 410)
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(config.gatewaySecret || '')) throw httpError('小程序码配置暂不可用', 503)
  // Stable, secret-derived 128-bit credential. Reopening/retrying the same QR never invalidates it.
  const scene = crypto.createHmac('sha256', config.gatewaySecret).update(`store-service-scene-v1\n${config.cloudBaseEnvId}\n${r.id}`).digest('hex').slice(0, 32)
  const envVersion = config.mode === 'production' ? 'release' : 'develop'
  const token = await miniprogramAccessToken({ config, fetchImpl })
  if (!token) throw httpError('小程序码凭证暂不可用', 503)
  let bytes
  try {
    const response = await fetchImpl(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene, page: 'pages/store-service/form', check_path: config.mode === 'production', env_version: envVersion, width: 600 }) })
    if (!response.ok) throw Error()
    bytes = Buffer.from(await response.arrayBuffer())
  } catch { throw httpError('小程序码生成失败，请重试或使用网页填写码', 503) }
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if ((!png && !jpeg) || bytes.length < 100 || bytes.length > 2000000) throw httpError('微信未返回有效小程序码', 503)
  await db.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe("SELECT id FROM customer_service_request_tokens WHERE request_id = $1 AND status = 'ACTIVE' FOR UPDATE", requestId)
    const current = await tx.customerServiceRequest.findUnique({ where: { id: requestId } })
    if (rows.length !== 1 || current.status !== 'WAITING_CUSTOMER' || current.expiresAt <= new Date()) throw httpError('填写码已失效', 410)
    const existingToken = await tx.customerServiceRequestToken.findUnique({ where: { id: rows[0].id } })
    if (existingToken.miniSceneHash && existingToken.miniSceneHash !== sceneHash(scene)) throw httpError('码配置已变更，请保留已发出的码；需要新码时使用重新生成操作', 409)
    await tx.customerServiceRequestToken.update({ where: { id: rows[0].id }, data: { miniSceneHash: sceneHash(scene) } })
  })
  return { imageDataUrl: `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`, envVersion, expiresAt: r.expiresAt }
}
export function createStoreServiceStaffRouter({ db, env = process.env, configLoader = loadStoreServiceConfig }) {
  const router = express.Router(), templates = serviceTemplates(env)
  const wrap = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json({ ok: true, ...await fn(req) }) }
    catch (error) { res.status([400, 403, 404, 409, 410].includes(error.status) ? error.status : 503).json({ ok: false, error: error.status < 500 ? error.message : '服务暂不可用，请稍后重试' }) }
  }
  router.get('/customer-requests/service-capabilities', wrap(async () => {
    let configured = false
    try { configured = Boolean(configLoader(env)?.enabled) } catch { /* advertise unavailable, never leak config */ }
    return { enabled: env.STORE_SERVICE_RUNTIME_ENABLED === '1' && configured,
      qrEnabled: configured && env.STORE_SERVICE_RUNTIME_ENABLED === '1' && env.STORE_SERVICE_QR_ENABLED === '1'
        && env.STORE_SERVICE_SUBMISSIONS_ENABLED === '1' && (env.APP_ENV !== 'prod' || env.STORE_SERVICE_RELEASE_PATH_READY === '1') }
  }))
  router.get('/customer-requests/conversion', wrap(async req => {
    if (req.user?.role !== 'developer' || req.user?.status === 'disabled') throw httpError('无权限', 403)
    return { data: await queryServiceConversion(db, req.query) }
  }))
  router.get('/customer-requests/:id/service', wrap(async req => serviceDetail(db, req.params.id, null, req.user)))
  router.post('/customer-requests/:id/mini-code', wrap(req => generateStoreServiceCode({ db, requestId: req.params.id, user: req.user, env, config: configLoader(env) })))
  for (const [path, action] of [['confirm-receipt', 'receipt'], ['confirm-shipment', 'shipment'], ['correct-shipment', 'correct-shipment']]) {
    router.post(`/customer-requests/:id/${path}`, wrap(req => confirmService(db, { requestId: req.params.id, user: req.user, action, input: req.body || {}, templates })))
  }
  return router
}
export function createStoreServiceRuntime({ db, config, env = process.env, fetchImpl, deliverInternal = true }) {
  const router = createStoreServiceCustomerRouter({ db, config, env, deliverInternal })
  const send = createServiceWechatSender({ config, templates: serviceTemplates(env), fetchImpl,
    envVersion: config.mode === 'production' ? 'formal' : 'developer' })
  let timer = null, busy = false
  const tick = async () => {
    if (busy || env.STORE_SERVICE_SEND_ENABLED !== '1') return
    busy = true
    try { await deliverStoreServiceOnce(db, send) } catch { /* no PII/provider details in logs */ } finally { busy = false }
  }
  return {
    mount(app) {
      const prefix = config.mode === 'production' ? '/api/v2' : '/api'
      app.use(`${prefix}/customer/store-services`, express.json({ limit: '32kb' }), router,
        (error, req, res, next) => res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ ok: false, error: 'SERVICE_INVALID_INPUT' }))
    },
    start() { if (!timer && env.STORE_SERVICE_SEND_ENABLED === '1') { timer = setInterval(tick, 5000); timer.unref(); void tick() } },
    stop() { if (timer) clearInterval(timer); timer = null }, tick,
  }
}
