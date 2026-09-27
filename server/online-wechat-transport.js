import https from 'node:https'
import crypto from 'node:crypto'

const LIMIT = 1024 * 1024
const fail = code => Object.assign(new Error(code), { code })

// Server-only API v3 transport. A response is untrusted until its original bytes
// and signature have been checked by online-wechat-evidence. Never retry here:
// timeout is ambiguous; recovery queries the original merchant identity.
export function createOnlineWechatTransport({ mchId, merchantSerial, merchantPrivateKey,
  deadlineMs = 10000, requestImpl = https.request }) {
  if (!/^\d{8,16}$/.test(mchId || '') || !/^[A-Fa-f0-9]{1,128}$/.test(merchantSerial || '')
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) throw fail('ONLINE_WECHAT_CONFIG_INVALID')
  let key
  try { key = crypto.createPrivateKey(merchantPrivateKey) } catch { throw fail('ONLINE_WECHAT_KEY_INVALID') }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw fail('ONLINE_WECHAT_KEY_INVALID')

  return async function request(method, path, body, { signal } = {}) {
    if (typeof path !== 'string' || path.length > 256) throw fail('ONLINE_WECHAT_REQUEST_INVALID')
    const query = new RegExp(`^/v3/pay/transactions/out-trade-no/[A-Za-z0-9_-]{1,32}\\?mchid=${mchId}$`)
    const allowed = method === 'GET'
      ? query.test(path) || /^\/v3\/refund\/domestic\/refunds\/[A-Za-z0-9_-]{1,64}$/.test(path)
      : method === 'POST' && (path === '/v3/pay/transactions/jsapi' || path === '/v3/refund/domestic/refunds'
        || /^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_-]{1,32}\/close$/.test(path))
    if (typeof path !== 'string' || !allowed || (method === 'GET' && body != null)) throw fail('ONLINE_WECHAT_REQUEST_INVALID')
    let bytes
    try {
      if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body))) throw Error()
      bytes = Buffer.from(method === 'GET' ? '' : JSON.stringify(body), 'utf8')
    } catch { throw fail('ONLINE_WECHAT_REQUEST_INVALID') }
    if (bytes.length > LIMIT) throw fail('ONLINE_WECHAT_REQUEST_TOO_LARGE')
    if (signal?.aborted) throw fail('ONLINE_WECHAT_ABORTED')
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(24).toString('hex')
    const message = Buffer.concat([Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n`), bytes, Buffer.from('\n')])
    const signature = crypto.sign('RSA-SHA256', message, key).toString('base64')
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${merchantSerial}"`
    return new Promise((resolve, reject) => {
      let req, response, done = false, size = 0
      const chunks = []
      const finish = (error, result) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) {
          // Never propagate native errors: they can contain request or key data.
          response?.destroy()
          req?.destroy()
          reject(error)
        } else resolve(result)
      }
      const abort = () => finish(fail('ONLINE_WECHAT_ABORTED'))
      // Starts before request creation: bounds DNS, TLS, headers and slow streams.
      const timer = setTimeout(() => finish(fail('ONLINE_WECHAT_DEADLINE')), deadlineMs)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        req = requestImpl({ protocol: 'https:', hostname: 'api.mch.weixin.qq.com', port: 443,
          method, path, rejectUnauthorized: true, agent: false, maxHeaderSize: 16384,
          headers: { Authorization: authorization, Accept: 'application/json',
            'Accept-Encoding': 'identity', 'Content-Type': 'application/json',
            'Content-Length': bytes.length, 'User-Agent': 'budu-online-wechat/1.1B' } }, res => {
          response = res
          res.on('error', () => finish(fail('ONLINE_WECHAT_RESPONSE_ERROR')))
          if (done) { res.destroy(); return }
          if (res.statusCode >= 300 && res.statusCode < 400) { finish(fail('ONLINE_WECHAT_REDIRECT_DENIED')); return }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { finish(fail('ONLINE_WECHAT_ENCODING_DENIED')); return }
          const length = res.headers['content-length']
          if (length != null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) { finish(fail('ONLINE_WECHAT_RESPONSE_TOO_LARGE')); return }
          res.on('data', chunk => {
            if (done) return
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += buffer.length
            if (size > LIMIT) { finish(fail('ONLINE_WECHAT_RESPONSE_TOO_LARGE')); return }
            chunks.push(buffer)
          })
          res.on('aborted', () => finish(fail('ONLINE_WECHAT_RESPONSE_ABORTED')))
          res.on('end', () => {
            if (res.complete === false || (length != null && Number(length) !== size)) { finish(fail('ONLINE_WECHAT_RESPONSE_INCOMPLETE')); return }
            finish(null, { statusCode: res.statusCode, headers: res.headers, rawBody: Buffer.concat(chunks, size) })
          })
          res.on('close', () => { if (!done) finish(fail('ONLINE_WECHAT_RESPONSE_INCOMPLETE')) })
        })
        req.on('error', () => finish(fail('ONLINE_WECHAT_NETWORK_ERROR')))
        if (done) req.destroy()
        else req.end(bytes)
      } catch { finish(fail('ONLINE_WECHAT_NETWORK_ERROR')) }
    })
  }
}
