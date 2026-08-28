import crypto from 'node:crypto'

export const CUSTOMER_REQUEST_TYPES = Object.freeze({
  MAILING: 'MAILING',
  INVOICE: 'INVOICE',
})

export const CUSTOMER_REQUEST_STATUS = Object.freeze({
  WAITING: 'WAITING_CUSTOMER',
  SUBMITTED: 'SUBMITTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
})

export const CUSTOMER_REQUEST_TTL_MS = 2 * 60 * 60 * 1000

export function httpError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

export function createCustomerToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashCustomerToken(token) {
  const value = String(token || '')
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(value)) return ''
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function customerRequestPublicUrl(origin, token) {
  const raw = String(origin || '').trim()
  const tokenValue = String(token || '')
  if (!raw || !hashCustomerToken(tokenValue)) throw httpError('公开访问地址配置不正确', 503)
  let url
  try {
    url = new URL(raw)
  } catch {
    throw httpError('公开访问地址配置不正确', 503)
  }
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) {
    throw httpError('公开访问地址配置不正确', 503)
  }
  url.pathname = '/customer-request'
  url.search = ''
  url.hash = `token=${encodeURIComponent(tokenValue)}`
  return url.toString()
}

export function redactCustomerRequestUrl(rawUrl) {
  const value = String(rawUrl || '')
  return value
    .replace(/([?&](?:token|access_token)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(\/api\/public\/customer-requests?\/)[A-Za-z0-9_-]{20,}/g, '$1[redacted]')
}

function text(value, max, label, { required = false, min = 0 } = {}) {
  const out = String(value || '').trim()
  if (required && !out) throw httpError(`请填写${label}`)
  if (out.length < min || out.length > max) throw httpError(`${label}长度不正确`)
  return out
}

function requireConfirmation(payload) {
  if (payload?.confirmedAccurate !== true) throw httpError('请确认以上信息准确无误')
  if (String(payload?.companyWebsite || '').trim()) throw httpError('提交内容无效')
}

export function validateMailingSubmission(payload) {
  requireConfirmation(payload)
  const recipient = text(payload?.recipient, 50, '收件人', { required: true, min: 1 })
  const phone = String(payload?.phone || '').replace(/[\s-]/g, '')
  if (!/^1[3-9]\d{9}$/.test(phone)) throw httpError('请填写正确的中国大陆手机号')
  const address = text(payload?.address, 200, '完整收件地址', { required: true, min: 5 })
  const mailingContent = text(payload?.mailingContent, 100, '邮寄内容')
  const note = text(payload?.note, 200, '备注')
  const remark = [mailingContent ? `邮寄内容：${mailingContent}` : '', note].filter(Boolean).join('\n')
  if (remark.length > 200) throw httpError('邮寄内容和备注合计不能超过 200 个字符')
  return { recipient, phone, address, mailingContent, note, remark }
}

export function validateInvoiceSubmission(payload) {
  requireConfirmation(payload)
  const titleType = payload?.titleType === 'PERSONAL' ? 'PERSONAL' : payload?.titleType === 'ENTERPRISE' ? 'ENTERPRISE' : ''
  if (!titleType) throw httpError('请选择抬头类型')
  const invoiceTitle = text(payload?.invoiceTitle, 100, '发票抬头', { required: true, min: 1 })
  let taxNo = text(payload?.taxNo, 50, '纳税人识别号')
  if (titleType === 'ENTERPRISE') {
    taxNo = taxNo.toUpperCase()
    if (!/^[0-9A-Z-]{8,50}$/.test(taxNo)) throw httpError('请填写正确的纳税人识别号')
  } else {
    taxNo = ''
  }
  const email = text(payload?.email, 120, '接收邮箱', { required: true, min: 3 })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError('邮箱格式不正确')
  const note = text(payload?.note, 200, '备注')
  return { titleType, invoiceTitle, taxNo, email, note }
}

export function validateMailingMetadata(input) {
  const method = String(input?.method || '').trim()
  const postage = String(input?.postage || '').trim()
  const fee = String(input?.fee || '').trim()
  if (!['顺丰邮寄', '同城闪送'].includes(method)) throw httpError('邮寄方式不正确')
  if (!['包邮', '不包邮'].includes(postage)) throw httpError('运费选项不正确')
  if (fee && !['标准件18¥', '生鲜航运30¥'].includes(fee)) throw httpError('运费选项不正确')
  return { method, postage, fee }
}

export function validateInvoiceMetadata(input) {
  const amountCents = Number(input?.amountCents)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 999999999999) {
    throw httpError('请先填写正确的开票金额')
  }
  const category = text(input?.category || '其他', 30, '发票内容', { required: true, min: 1 })
  return { amountCents, category }
}

export function serializePublicRequest(request) {
  const metadata = request?.requestMetadata && typeof request.requestMetadata === 'object' ? request.requestMetadata : {}
  const base = {
    type: request.type,
    status: request.status,
    expiresAt: request.expiresAt,
  }
  if (request.type === CUSTOMER_REQUEST_TYPES.INVOICE) {
    return {
      ...base,
      invoiceAmountCents: String(metadata.amountCents || 0),
      invoiceCategory: String(metadata.category || '其他'),
    }
  }
  return base
}

export function createFixedWindowLimiter({ limit, windowMs, now = () => Date.now() }) {
  const buckets = new Map()
  return {
    consume(key) {
      const current = now()
      const safeKey = String(key || '')
      const previous = buckets.get(safeKey)
      const bucket = !previous || previous.resetAt <= current
        ? { count: 0, resetAt: current + windowMs }
        : previous
      bucket.count += 1
      buckets.set(safeKey, bucket)
      if (buckets.size > 5000) {
        for (const [candidate, value] of buckets) {
          if (value.resetAt <= current) buckets.delete(candidate)
        }
      }
      return {
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)),
      }
    },
    clear() {
      buckets.clear()
    },
  }
}

export function safeRateKey(ip, tokenHash) {
  return crypto.createHash('sha256').update(`${String(ip || '')}\n${String(tokenHash || '')}`).digest('hex')
}
