import crypto from 'node:crypto'
import { miniprogramAccessToken, invalidateMiniprogramToken } from './wechat-access-token.js'

// Config is adopted-template metadata, not an invented template or subscription quota.
export function serviceTemplates(env = process.env) {
  let config
  try { config = JSON.parse(env.STORE_SERVICE_TEMPLATE_CONFIG || '{}') } catch { return {} }
  const templates = {}
  for (const [type, event] of [['MAILING', 'SHIPMENT_CONFIRMED'], ['INVOICE', 'INVOICE_RECEIVED']]) {
    const t = config[type]
    if (!t || t.semantic !== event || t.verified !== true || !/^[A-Za-z0-9_-]{10,128}$/.test(t.id || '')
        || !t.fields || typeof t.fields !== 'object' || Array.isArray(t.fields)) continue
    const entries = Object.entries(t.fields)
    if (!entries.length || entries.length > 5 || entries.some(([key, value]) => !/^(thing|character_string|phrase|amount)\d+$/.test(key)
      || !['storeName', 'requestNo', 'status', 'carrier', 'trackingNo', 'amount'].includes(value))) continue
    if (type === 'INVOICE' && entries.some(([, v]) => ['carrier', 'trackingNo'].includes(v))) continue
    templates[type] = { id: t.id, fields: t.fields, semantic: event }
  }
  return templates
}
function messageData(template, request, storeName) {
  const values = { storeName, requestNo: request.id.replaceAll('-', '').slice(-12),
    status: request.type === 'INVOICE' ? '已收到' : '已发货', carrier: request.carrier || '',
    trackingNo: request.trackingNo || '', amount: (Number(request.requestMetadata?.amountCents || 0) / 100).toFixed(2) + '元' }
  const data = {}
  for (const [key, field] of Object.entries(template.fields)) {
    const value = String(values[field] || ''), length = [...value].length
    const valid = key.startsWith('thing') ? length > 0 && length <= 20
      : key.startsWith('character_string') ? /^[A-Za-z0-9\-_.]{1,32}$/.test(value)
        : key.startsWith('phrase') ? /^[\u3400-\u9fff]{1,5}$/.test(value)
          : /^\d{1,10}(\.\d{1,2})?元$/.test(value)
    if (!valid) return null
    data[key] = { value }
  }
  return data
}
export function createServiceWechatSender({ config, templates, fetchImpl = fetch, envVersion = 'release' }) {
  return async (delivery, request, storeName) => {
    const template = templates[request.type]
    if (!config?.enabled || !template || template.id !== delivery.templateId || template.semantic !== delivery.event
      || delivery.appId !== config.appId || delivery.envId !== config.cloudBaseEnvId
      || !['release', 'developer', 'trial'].includes(envVersion)) return { status: 'BLOCKED_CONFIG', code: 'CONFIG' }
    const data = messageData(template, request, storeName)
    if (!data) return { status: 'FAILED', code: 'FIELD_INVALID' }
    // Obtaining a token cannot send a customer message and is safe to retry boundedly.
    const token = await miniprogramAccessToken({ config, fetchImpl })
    if (!token) return { status: 'PENDING', code: 'TOKEN_UNAVAILABLE' }
    try {
      const response = await fetchImpl(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: delivery.openId, template_id: template.id,
          page: `pages/store-service/detail?id=${encodeURIComponent(request.id)}`, miniprogram_state: envVersion, lang: 'zh_CN', data }),
      })
      if (!response.ok) return { status: 'UNKNOWN', code: 'HTTP_AMBIGUOUS' }
      const body = await response.json(), code = body?.errcode
      if (code === 0) return { status: 'ACCEPTED', code: '0' }
      if (code === 43101) return { status: 'NO_PERMISSION', code: '43101' }
      if ([40001, 40014, 42001].includes(code)) { invalidateMiniprogramToken(config); return { status: 'PENDING', code: String(code) } }
      if ([40037, 41030, 47003].includes(code)) return { status: 'BLOCKED_CONFIG', code: String(code) }
      if (Number.isInteger(code) && code !== 0) return { status: 'FAILED', code: String(code) }
      return { status: 'UNKNOWN', code: 'RESPONSE_AMBIGUOUS' }
    } catch { return { status: 'UNKNOWN', code: 'NETWORK_AMBIGUOUS' } }
  }
}
export async function deliverStoreServiceOnce(db, send, { now = new Date(), maxAttempts = 3 } = {}) {
  // A crashed SENDING job may already have reached WeChat. NEVER auto resend it.
  await db.storeServiceDelivery.updateMany({ where: { status: 'SENDING', claimedAt: { lt: new Date(now.getTime() - 60000) } },
    data: { status: 'UNKNOWN', platformCode: 'WORKER_INTERRUPTED' } })
  const claimId = crypto.randomUUID()
  const delivery = await db.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe(`SELECT id FROM store_service_deliveries WHERE status = 'PENDING' AND next_attempt_at <= $1 AND attempts < $2 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, now, maxAttempts)
    if (!rows.length) return null
    return tx.storeServiceDelivery.update({ where: { id: rows[0].id }, data: { status: 'SENDING', claimedAt: now, claimId, attempts: { increment: 1 } } })
  })
  if (!delivery) return { processed: false }
  let result
  try {
    const request = await db.customerServiceRequest.findUnique({ where: { id: delivery.requestId }, include: { store: true } })
    if (!request || request.customerUserId !== delivery.userId || request.customerOpenId !== delivery.openId
        || request.customerAppId !== delivery.appId || request.customerEnvId !== delivery.envId) result = { status: 'FAILED', code: 'OWNER_CHANGED' }
    else result = await send(delivery, request, request.store.name)
  } catch { result = { status: 'UNKNOWN', code: 'SEND_INTERRUPTED' } }
  if (!['PENDING', 'ACCEPTED', 'NO_PERMISSION', 'FAILED', 'BLOCKED_CONFIG', 'UNKNOWN'].includes(result?.status)) result = { status: 'UNKNOWN', code: 'ADAPTER_INVALID' }
  if (result.status === 'PENDING' && delivery.attempts >= maxAttempts) result = { status: 'FAILED', code: 'RETRY_EXHAUSTED' }
  const saved = await db.storeServiceDelivery.updateMany({ where: { id: delivery.id, status: 'SENDING', claimId }, data: {
    status: result.status, platformCode: String(result.code || '').slice(0, 64),
    acceptedAt: result.status === 'ACCEPTED' ? now : null,
    nextAttemptAt: new Date(now.getTime() + Math.min(3600000, 30000 * 2 ** delivery.attempts)),
  } })
  return { processed: true, status: saved.count ? result.status : 'UNKNOWN' }
}
