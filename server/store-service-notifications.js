import crypto from 'node:crypto'
import { miniprogramAccessToken, invalidateMiniprogramToken } from './wechat-access-token.js'
import { MAILING_METHOD } from './customer-request-core.js'

// Config is adopted-template metadata, not an invented template or subscription quota.
export function serviceTemplates(env = process.env) {
  let config
  try { config = JSON.parse(env.STORE_SERVICE_TEMPLATE_CONFIG || '{}') } catch { return {} }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const templates = {}
  for (const [kind, type, event] of [['MAILING', 'MAILING', 'SHIPMENT_CONFIRMED'],
    ['MAILING_EXPRESS', 'MAILING', 'SHIPMENT_CONFIRMED'], ['MAILING_FLASH', 'MAILING', 'SHIPMENT_CONFIRMED'],
    ['INVOICE', 'INVOICE', 'INVOICE_RECEIVED']]) {
    const t = config[kind]
    if (!t || t.semantic !== event || t.verified !== true || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(t.id)
        || !t.fields || typeof t.fields !== 'object' || Array.isArray(t.fields)) continue
    const entries = Object.entries(t.fields)
    if (!entries.length || entries.length > 5 || entries.some(([key, value]) => !/^(thing|character_string|phrase|amount|time)\d+$/.test(key)
      || !['storeName', 'requestNo', 'status', 'carrier', 'trackingNo', 'amount', 'invoiceTitle', 'submittedAt', 'invoiceReceivedNote', 'shipmentNote', 'shipmentConfirmedAt'].includes(value)
      || (['invoiceTitle', 'invoiceReceivedNote', 'shipmentNote'].includes(value) && !key.startsWith('thing'))
      || (['submittedAt', 'shipmentConfirmedAt'].includes(value) && !key.startsWith('time'))
      || (key.startsWith('time') && !['submittedAt', 'shipmentConfirmedAt'].includes(value)))) continue
    if (type === 'INVOICE' && entries.some(([, v]) => ['carrier', 'trackingNo', 'shipmentNote', 'shipmentConfirmedAt'].includes(v))) continue
    if (type !== 'INVOICE' && entries.some(([, v]) => ['invoiceTitle', 'submittedAt', 'invoiceReceivedNote'].includes(v))) continue
    templates[kind] = { id: t.id, fields: t.fields, semantic: event }
  }
  return templates
}
// New admissions use only the saved request's validated method. MAILING is a
// lookup-only compatibility entry for previously saved subscription IDs.
export function selectServiceTemplate(templates, request, { method, saved = false } = {}) {
  let current
  if (request.type === 'INVOICE') current = templates.INVOICE
  else if (request.type === 'MAILING') {
    const original = request.requestMetadata?.method
    if (method !== undefined && method !== original) return null
    if (original === MAILING_METHOD.SF) current = templates.MAILING_EXPRESS
    else if (original === MAILING_METHOD.FLASH) current = templates.MAILING_FLASH
    else return null
  } else return null
  if (!saved || !request.subscriptionTemplateId || current?.id === request.subscriptionTemplateId) return current || null
  if (request.type === 'MAILING' && templates.MAILING?.id === request.subscriptionTemplateId) return templates.MAILING
  return null
}
export function normalizeServiceSubscription(template, reported = {}) {
  const reportedChoice = ['accept', 'reject', 'cancel', 'unavailable'].includes(reported?.status) ? reported.status : 'unavailable'
  const id = typeof reported?.templateId === 'string' && /^[A-Za-z0-9_-]{10,128}$/.exec(reported.templateId)?.[0] === reported.templateId ? reported.templateId : null
  const matched = !!template && id === template.id
  return { status: matched ? reportedChoice : 'unavailable', templateId: id,
    validation: { reportedChoice, requestedTemplateId: id, expectedTemplateId: template?.id || null, matched,
      code: !template ? 'CONFIG_UNAVAILABLE' : !id ? 'ID_UNAVAILABLE' : !matched ? 'TEMPLATE_MISMATCH' : 'MATCHED' } }
}
const INVOICE_RECEIVED_NOTE = '申请已收到，待财务办理，请留意邮箱'
const SHIPMENT_NOTES = { [MAILING_METHOD.SF]: '商家已确认发货，点击查看配送详情',
  [MAILING_METHOD.FLASH]: '商家已确认发出，点击查看配送凭证' }
function validCalendar(year, month, day, hour, minute) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, 0, 0)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
// Independently validate the single documented 24-hour calendar form we emit.
export function validServiceMessageTime(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{2}):(\d{2})$/.exec(value)
  return !!match && match[0] === value && validCalendar(...match.slice(1).map(Number))
}
function submittedTime(value) {
  // Prisma supplies a Date; never default missing data to confirmation/send time.
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(p => [p.type, p.value]))
  const result = `${parts.year.padStart(4, '0')}年${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`
  return validServiceMessageTime(result) ? result : ''
}
function amountText(raw) {
  let cents
  if (typeof raw === 'bigint') cents = raw
  else if (typeof raw === 'number' && Number.isSafeInteger(raw)) cents = BigInt(raw)
  else if (typeof raw === 'string' && /^[0-9]+$/.exec(raw)?.[0] === raw) cents = BigInt(raw)
  else return ''
  // At most ten numeric digits, including the two fractional digits. Do not
  // round, truncate or coerce a missing/unsafe value into a different amount.
  if (cents < 0n || cents > 9999999999n) return ''
  return `￥${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
const FIELD_VALIDATORS = {
  thing: value => [...value].length > 0 && [...value].length <= 20 && !/[\u0000-\u001f\u007f-\u009f]/.test(value),
  character_string: value => /^[A-Za-z0-9\-_.]{1,32}$/.exec(value)?.[0] === value,
  phrase: value => /^[\u3400-\u9fff]{1,5}$/.exec(value)?.[0] === value,
  amount: value => /^￥(?:0|[1-9]\d{0,7})\.\d{2}$/.exec(value)?.[0] === value,
  time: validServiceMessageTime,
}
function messageData(template, request, storeName, business) {
  const title = request.type === 'INVOICE' && typeof business?.companyName === 'string' ? [...business.companyName.trim()] : []
  const values = { storeName, requestNo: request.id.replaceAll('-', '').slice(-12),
    status: request.type === 'INVOICE' ? '已收到' : '已发货', carrier: request.carrier || '',
    trackingNo: request.trackingNo || '',
    amount: amountText(request.type === 'INVOICE' ? business?.amountCents : request.requestMetadata?.amountCents),
    invoiceTitle: title.length > 20 ? title.slice(0, 19).join('') + '…' : title.join(''),
    submittedAt: submittedTime(request.submittedAt), invoiceReceivedNote: request.type === 'INVOICE' ? INVOICE_RECEIVED_NOTE : '',
    shipmentConfirmedAt: submittedTime(request.shipmentConfirmedAt), shipmentNote: SHIPMENT_NOTES[business?.method] || '' }
  const data = {}
  for (const [key, field] of Object.entries(template.fields)) {
    const value = String(values[field] ?? ''), type = /^([a-z_]+)\d+$/.exec(key)?.[1]
    const validate = Object.hasOwn(FIELD_VALIDATORS, type) ? FIELD_VALIDATORS[type] : null
    if (!validate || !validate(value)) return null
    data[key] = { value }
  }
  return data
}
export function createServiceWechatSender({ config, templates, fetchImpl = fetch, envVersion = 'formal' }) {
  return async (delivery, request, storeName, business = null) => {
    const template = selectServiceTemplate(templates, request,
      { saved: true, ...(request.type === 'MAILING' && business ? { method: business.method } : {}) })
    if (!config?.enabled || delivery.appId !== config.appId || delivery.envId !== config.cloudBaseEnvId
      || !['formal', 'developer', 'trial'].includes(envVersion)) return { status: 'BLOCKED_CONFIG', code: 'CONFIG' }
    if (request.customerUserId !== delivery.userId || request.customerOpenId !== delivery.openId
      || request.customerAppId !== delivery.appId || request.customerEnvId !== delivery.envId) return { status: 'FAILED', code: 'OWNER_CHANGED' }
    if (request.type === 'MAILING' && business && business.method !== request.requestMetadata?.method)
      return { status: 'BLOCKED_CONFIG', code: 'DELIVERY_METHOD_CHANGED' }
    if (request.subscriptionChoice !== 'accept') return { status: 'NO_PERMISSION', code: 'SUBSCRIPTION_NOT_ACCEPTED' }
    if (request.subscriptionTemplateId !== delivery.templateId) return { status: 'BLOCKED_CONFIG', code: 'SUBSCRIPTION_TEMPLATE_MISMATCH' }
    if (!template || template.id !== delivery.templateId || template.semantic !== delivery.event)
      return { status: 'BLOCKED_CONFIG', code: 'TEMPLATE_NOT_CONFIGURED_OR_CHANGED' }
    if (!business || business.id !== request.linkedBusinessRecordId || business.storeKey !== request.storeKey || business.deletedAt)
      return { status: 'FAILED', code: request.type === 'INVOICE' ? 'INVOICE_RECORD_UNAVAILABLE' : 'MAILING_RECORD_UNAVAILABLE' }
    if (request.type === 'MAILING' && business.method === MAILING_METHOD.FLASH
      && (typeof request.deliveryProof !== 'string' || !request.deliveryProof.trim() || request.deliveryProof.length > 200))
      return { status: 'FAILED', code: 'DELIVERY_PROOF_INVALID' }
    if (request.type === 'MAILING' && business.method === MAILING_METHOD.SF
      && (typeof request.trackingNo !== 'string' || /^[A-Za-z0-9-]{6,80}$/.exec(request.trackingNo)?.[0] !== request.trackingNo))
      return { status: 'FAILED', code: 'FIELD_INVALID' }
    const data = messageData(template, request, storeName, business)
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
    else {
      let business = null
      if (request.type === 'INVOICE') {
        business = request.linkedBusinessRecordId ? await db.invoice.findUnique({ where: { id: request.linkedBusinessRecordId },
          select: { id: true, storeKey: true, companyName: true, amountCents: true, deletedAt: true } }) : null
      } else if (request.type === 'MAILING') {
        business = request.linkedBusinessRecordId ? await db.mailingRecord.findUnique({ where: { id: request.linkedBusinessRecordId },
          select: { id: true, storeKey: true, method: true, deletedAt: true } }) : null
      }
      if (!business || business.id !== request.linkedBusinessRecordId || business.storeKey !== request.storeKey || business.deletedAt)
        result = { status: 'FAILED', code: request.type === 'INVOICE' ? 'INVOICE_RECORD_UNAVAILABLE' : 'MAILING_RECORD_UNAVAILABLE' }
      else if (request.subscriptionTemplateId !== delivery.templateId)
        result = { status: 'BLOCKED_CONFIG', code: 'SUBSCRIPTION_TEMPLATE_MISMATCH' }
      else if (request.subscriptionChoice !== 'accept') result = { status: 'NO_PERMISSION', code: 'SUBSCRIPTION_NOT_ACCEPTED' }
      else result = await send(delivery, request, request.store.name, business)
    }
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
