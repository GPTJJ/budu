// P0 READ-ONLY signature diagnostics. Prints only public response metadata and
// which verification predicate failed. Never prints key material.
import crypto from 'node:crypto'
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlineWechatTransport } from '/app/server/online-wechat-transport.js'

const NO = process.argv[2] || 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'
const cfg = loadOnlineCheckoutConfig()
const pc = cfg.paymentConfig
const request = createOnlineWechatTransport(pc)
const reply = await request('GET', `/v3/pay/transactions/out-trade-no/${NO}?mchid=${pc.mchId}`)
const h = reply.headers || {}
const get = n => { const k = Object.keys(h).filter(x => x.toLowerCase() === n); return k.length === 1 ? h[k[0]] : `(matches=${k.length})` }

const ts = get('wechatpay-timestamp')
const nonce = get('wechatpay-nonce')
const serial = get('wechatpay-serial')
const sig = get('wechatpay-signature')

console.log('http_status:', reply.statusCode)
console.log('raw_body_bytes:', reply.rawBody ? reply.rawBody.length : 0)
console.log('--- response signature headers (public metadata) ---')
console.log('wechatpay-timestamp:', ts)
console.log('wechatpay-nonce:', nonce)
console.log('wechatpay-serial:', serial)
console.log('wechatpay-signature_len:', typeof sig === 'string' ? sig.length : 0)
console.log('--- configured expectation ---')
console.log('configured platformKeyId:', pc.platformKeyId)
console.log('--- predicate checks (mirrors online-wechat-evidence.js) ---')
console.log('ts_format_ok      :', /^\d{10}$/.test(String(ts)))
console.log('server_epoch      :', Math.floor(Date.now() / 1000))
console.log('skew_seconds      :', Math.abs(Math.floor(Date.now() / 1000) - Number(ts)))
console.log('skew_within_300s  :', Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300)
console.log('nonce_bounded     :', typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 256 && !/[\r\n]/.test(nonce))
console.log('SERIAL_MATCH      :', serial === pc.platformKeyId)
console.log('--- raw crypto.verify ---')
try {
  const pub = crypto.createPublicKey(pc.platformPublicKey)
  console.log('pubkey_type       :', pub.asymmetricKeyType)
  console.log('pubkey_modulus    :', pub.asymmetricKeyDetails?.modulusLength)
  const message = Buffer.concat([Buffer.from(`${ts}\n${nonce}\n`), reply.rawBody, Buffer.from('\n')])
  const ok = crypto.verify('RSA-SHA256', message, pub, Buffer.from(String(sig), 'base64'))
  console.log('SIGNATURE_VERIFY  :', ok)
} catch (e) {
  console.log('verify_error:', e.message)
}
