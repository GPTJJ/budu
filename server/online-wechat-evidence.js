import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

const deny = () => { throw httpError('微信支付结果校验失败，请稍后查询', 401) }
const bounded = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max
function header(headers, name) {
  const keys = Object.keys(headers || {}).filter(k => k.toLowerCase() === name)
  if (keys.length !== 1 || typeof headers[keys[0]] !== 'string') return deny()
  return headers[keys[0]]
}
function base64(value, max) {
  if (!bounded(value, max) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return deny()
  return Buffer.from(value, 'base64')
}

// Separate JSAPI v3 trust boundary; the existing POS MICROPAY v2 adapter is
// unchanged. Configuration comes only from the server composition root.
export function createOnlineWechatEvidence({ appId, mchId, platformPublicKey, platformKeyId, apiV3Key }) {
  if (!/^wx[A-Za-z0-9]{16}$/.test(appId || '') || !/^\d{8,16}$/.test(mchId || '')
    || !bounded(platformKeyId, 128)) throw Error('ONLINE_WECHAT_CONFIG_REQUIRED')
  const publicKey = crypto.createPublicKey(platformPublicKey)
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength < 2048) throw Error('ONLINE_WECHAT_PUBLIC_KEY_INVALID')
  const decryptKey = Buffer.from(apiV3Key || '', 'utf8')
  if (decryptKey.length !== 32) throw Error('ONLINE_WECHAT_API_V3_KEY_INVALID')
  return function verifyPayment({ source, headers, rawBody, statusCode }) {
    if (!['QUERY', 'NOTIFY'].includes(source) || (source === 'QUERY' && statusCode !== 200)
      || !Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 1024 * 1024) return deny()
    const timestamp = header(headers, 'wechatpay-timestamp'), nonce = header(headers, 'wechatpay-nonce')
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
      || !bounded(nonce, 256) || /[\r\n]/.test(nonce) || header(headers, 'wechatpay-serial') !== platformKeyId) return deny()
    const signature = base64(header(headers, 'wechatpay-signature'), 2048)
    const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), rawBody, Buffer.from('\n')])
    if (!crypto.verify('RSA-SHA256', message, publicKey, signature)) return deny()
    let result
    try {
      result = JSON.parse(rawBody.toString('utf8'))
      if (source === 'NOTIFY') {
        if (result.event_type !== 'TRANSACTION.SUCCESS' || result.resource_type !== 'encrypt-resource'
          || result.resource?.algorithm !== 'AEAD_AES_256_GCM' || result.resource?.original_type !== 'transaction') return deny()
        const r = result.resource, iv = Buffer.from(r.nonce || '', 'utf8')
        if (iv.length !== 12 || (r.associated_data != null && typeof r.associated_data !== 'string')) return deny()
        const encrypted = base64(r.ciphertext, 1024 * 1024)
        if (encrypted.length <= 16) return deny()
        const decipher = crypto.createDecipheriv('aes-256-gcm', decryptKey, iv)
        decipher.setAAD(Buffer.from(r.associated_data || '', 'utf8'))
        decipher.setAuthTag(encrypted.subarray(-16))
        result = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'))
      }
    } catch { return deny() }
    if (!result || result.appid !== appId || result.mchid !== mchId || result.trade_type !== 'JSAPI'
      || !bounded(result.out_trade_no, 32) || !['SUCCESS', 'NOTPAY', 'USERPAYING', 'CLOSED', 'REVOKED', 'PAYERROR'].includes(result.trade_state)
      || !Number.isSafeInteger(result.amount?.total) || result.amount.total <= 0 || result.amount.total > 2000000000
      || result.amount.currency !== 'CNY' || (source === 'NOTIFY' && result.trade_state !== 'SUCCESS')) return deny()
    let successAt = null
    if (result.trade_state === 'SUCCESS') {
      successAt = new Date(result.success_time)
      if (!bounded(result.transaction_id, 128) || !bounded(result.payer?.openid, 128)
        || !bounded(result.success_time, 40) || !Number.isFinite(successAt.getTime()) || successAt.getTime() > Date.now() + 300000) return deny()
    }
    // This object stays in the service call stack, never logs/HTTP/mirror JSON.
    return Object.freeze({ appId, mchId, merchantTradeNo: result.out_trade_no,
      amountCents: BigInt(result.amount.total), currency: 'CNY', state: result.trade_state,
      transactionId: result.trade_state === 'SUCCESS' ? result.transaction_id : null,
      payerOpenId: result.trade_state === 'SUCCESS' ? result.payer.openid : null, successAt })
  }
}
