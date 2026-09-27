import crypto from 'node:crypto'
import { createOnlineWechatMessageVerifier } from './online-wechat-evidence.js'
import { httpError } from './pos-core.js'

const deny = () => { throw httpError('微信退款结果校验失败，请稍后查询', 401) }
const identity = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value)
const cents = value => {
  if (typeof value === 'bigint' && value > 0n && value <= 2000000000n) return value
  if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && BigInt(value) <= 2000000000n) return BigInt(value)
  return deny()
}
const providerCents = value => Number.isSafeInteger(value) && value > 0 && value <= 2000000000

// Domestic direct-merchant v3 refunds. Official query response has no mchid or
// appid; notify has mchid but no appid/currency. Missing protocol fields are
// bound through mandatory immutable original-payment expectations, not guessed.
// Query: https://pay.wechatpay.cn/doc/v3/merchant/4012791884
// Notify: https://pay.wechatpay.cn/doc/v3/merchant/4012268885
function createRefundParser(configuration) {
  const { appId, mchId, apiV3Key } = configuration
  if (!/^wx[A-Za-z0-9]{16}$/.test(appId || '') || !/^\d{8,16}$/.test(mchId || '')) throw Error('ONLINE_REFUND_CONFIG_REQUIRED')
  const verifyMessage = createOnlineWechatMessageVerifier(configuration)
  const key = Buffer.from(apiV3Key || '', 'utf8')
  if (key.length !== 32) throw Error('ONLINE_REFUND_API_V3_KEY_INVALID')
  return function parse(input) {
    const { source, rawBody, statusCode } = input || {}
    if (!['QUERY', 'SUBMIT', 'NOTIFY'].includes(source) || !Buffer.isBuffer(rawBody) || !rawBody.length
        || (source === 'QUERY' && statusCode !== 200) || (source === 'SUBMIT' && ![200,201].includes(statusCode))) return deny()
    verifyMessage(input)
    let result, eventType
    try {
      result = JSON.parse(rawBody.toString('utf8'))
      if (source === 'NOTIFY') {
        eventType = result.event_type
        const r = result.resource
        if (!['REFUND.SUCCESS', 'REFUND.CLOSED', 'REFUND.ABNORMAL'].includes(eventType)
            || result.resource_type !== 'encrypt-resource' || r?.algorithm !== 'AEAD_AES_256_GCM' || r.original_type !== 'refund'
            || typeof r.nonce !== 'string' || Buffer.byteLength(r.nonce) !== 12
            || (r.associated_data != null && (typeof r.associated_data !== 'string' || Buffer.byteLength(r.associated_data) > 1024))
            || typeof r.ciphertext !== 'string' || r.ciphertext.length > 1024*1024
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.ciphertext)) return deny()
        const encrypted = Buffer.from(r.ciphertext, 'base64')
        if (encrypted.length <= 16) return deny()
        // Same AEAD primitive/byte contract as payment verifier, whose decrypt
        // function is intentionally private. No shared payment code changed.
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.nonce))
        decipher.setAAD(Buffer.from(r.associated_data || ''))
        decipher.setAuthTag(encrypted.subarray(-16))
        result = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0,-16)), decipher.final()]).toString('utf8'))
      }
    } catch { return deny() }
    return { result, eventType, source }
  }
}

// Lookup hint only: no monetary, ownership or settlement authority. Callers
// must load the original refund and run the full verifier before any mutation.
export function createOnlineRefundReferenceReader(configuration) {
  const parse = createRefundParser(configuration)
  return input => {
    const { result } = parse(input)
    if (!result || typeof result.out_refund_no !== 'string' || !/^[A-Za-z0-9_|@-]{1,64}$/.test(result.out_refund_no)) return deny()
    return result.out_refund_no
  }
}

export function createOnlineRefundEvidence(configuration) {
  const { appId, mchId } = configuration
  const parse = createRefundParser(configuration)
  return function verifyRefund(input, expected) {
    if (!expected || expected.appId !== appId || expected.mchId !== mchId || expected.currency !== 'CNY'
        || !identity(expected.merchantTradeNo, 32) || !identity(expected.transactionId, 128)
        || !identity(expected.merchantRefundNo, 64)) return deny()
    const total = cents(expected.totalCents), refund = cents(expected.refundCents)
    if (refund > total) return deny()
    const { result, eventType, source } = parse(input)
    const state = source === 'NOTIFY' ? result?.refund_status : result?.status
    if (!result || !['SUCCESS','PROCESSING','CLOSED','ABNORMAL'].includes(state)
        || (source === 'NOTIFY' && (eventType !== `REFUND.${state}` || result.mchid !== mchId))
        || (result.mchid != null && result.mchid !== mchId) || (result.appid != null && result.appid !== appId)
        || result.out_trade_no !== expected.merchantTradeNo || result.transaction_id !== expected.transactionId
        || result.out_refund_no !== expected.merchantRefundNo || !identity(result.refund_id, 128)
        || (expected.providerRefundId != null && result.refund_id !== expected.providerRefundId)
        || !providerCents(result.amount?.total) || !providerCents(result.amount?.refund)
        || BigInt(result.amount.total) !== total || BigInt(result.amount.refund) !== refund
        || (source !== 'NOTIFY' && result.amount.currency !== 'CNY')
        || (result.amount.currency != null && result.amount.currency !== 'CNY')) return deny()
    let successAt = null
    if (state === 'SUCCESS') {
      if (typeof result.success_time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(result.success_time)) return deny()
      successAt = new Date(result.success_time)
      if (!Number.isFinite(successAt.getTime()) || successAt.getTime() > Date.now() + 300000) return deny()
    }
    // No customer bank/account details, secret, ciphertext, or full raw body.
    return Object.freeze({ appId, mchId, merchantTradeNo: expected.merchantTradeNo, transactionId: expected.transactionId,
      merchantRefundNo: expected.merchantRefundNo, providerRefundId: result.refund_id,
      totalCents: total, amountCents: refund, currency: 'CNY', state, successAt })
  }
}
