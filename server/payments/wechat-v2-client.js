// 微信支付 APIv2 安全 HTTP 客户端（付款码支付 MICROPAY 场景）
//
// 能力：
// - POST /pay/micropay、/pay/orderquery（明文 https）
// - POST /secapi/pay/reverse（双向 TLS，商户 API 证书）
// - 主域名失败后受控回退到备用域名
// - 请求/连接超时、响应大小上限
// - 对响应中的 appid、mch_id、out_trade_no、金额与签名做交叉验证
//
// 安全约定：
// - 付款码、签名、密钥、原始 XML 一律不进入日志与错误消息。
// - 业务错误只携带安全错误码与安全描述。
import crypto from 'node:crypto'
import https from 'node:https'
import { buildV2Xml, parseV2Xml, signV2Params, verifyV2Signature, WECHAT_V2_SIGN_HMAC_SHA256, WECHAT_V2_SIGN_MD5 } from './wechat-v2-signature.js'

const PRIMARY_HOST = 'api.mch.weixin.qq.com'
const FALLBACK_HOST = 'api2.mch.weixin.qq.com'
const DEFAULT_CONNECT_TIMEOUT_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 10000

export class WechatV2Error extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'WechatV2Error'
    this.code = code
    this.providerTradeNo = extra.providerTradeNo || null
    this.retryable = extra.retryable !== false
    this.ambiguous = extra.ambiguous === true
  }
}

function httpRequest({ host, path, body, cert, key, connectTimeoutMs, requestTimeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
          'User-Agent': 'BUDU-POS/1.0',
        },
        ...(cert && key ? { cert, key } : {}),
      },
      (res) => {
        const chunks = []
        let received = 0
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          req.destroy(new Error('response timeout'))
        }, requestTimeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        res.on('data', (chunk) => {
          received += chunk.length
          if (received > maxResponseBytes) {
            timedOut = true
            req.destroy(new Error('response too large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          clearTimeout(timer)
          if (timedOut) return
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
        res.on('error', (error) => {
          clearTimeout(timer)
          if (timedOut) return
          reject(error)
        })
      },
    )
    req.setTimeout(connectTimeoutMs, () => {
      req.destroy(new Error('connect timeout'))
    })
    req.on('error', (error) => reject(error))
    req.end(body)
  })
}

/**
 * @param {object} options
 * @param {string} options.mchId
 * @param {string} options.appId
 * @param {string} options.apiV2Key
 * @param {string} [options.certPem]
 * @param {string} [options.keyPem]
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.maxResponseBytes]
 */
export class WechatV2Client {
  constructor(options) {
    if (!options || !options.mchId || !options.appId || !options.apiV2Key) {
      throw new Error('WechatV2Client: mchId/appId/apiV2Key 缺失')
    }
    this.mchId = String(options.mchId)
    this.appId = String(options.appId)
    this.apiV2Key = String(options.apiV2Key)
    this.certPem = options.certPem || null
    this.keyPem = options.keyPem || null
    this.connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    this.maxResponseBytes = options.maxResponseBytes || 1024 * 1024
    // 测试注入点：自定义 transport(path, xmlBody, useMtls) => xml 字符串
    this._transport = options.transport || null
  }

  /**
   * 发送微信 V2 请求并完成安全校验。
   * @param {string} path 例如 /pay/micropay
   * @param {Record<string,string|number>} params
   * @param {{useMtls?:boolean, checkTradeFields?:{outTradeNo?:string, totalFee?:string|number}}} [opts]
   * @returns {Promise<Record<string,string>>} 校验后的响应参数
   */
  async request(path, params, opts = {}) {
    const useMtls = opts.useMtls === true
    if (useMtls && (!this.certPem || !this.keyPem)) {
      throw new WechatV2Error('CERT_MISSING', '商户 API 证书未配置，无法调用需双向 TLS 的接口', { retryable: false })
    }
    const payload = { ...params, mch_id: this.mchId, appid: this.appId, nonce_str: nonce(), sign_type: WECHAT_V2_SIGN_HMAC_SHA256 }
    payload.sign = signV2Params(payload, this.apiV2Key, WECHAT_V2_SIGN_HMAC_SHA256)
    const xmlBody = buildV2Xml(payload)

    let xmlText = null
    let lastError = null
    for (const host of [PRIMARY_HOST, FALLBACK_HOST]) {
      try {
        if (this._transport) {
          xmlText = await this._transport(path, xmlBody, useMtls, host)
        } else {
          xmlText = await httpRequest({
            host,
            path,
            body: xmlBody,
            cert: useMtls ? this.certPem : null,
            key: useMtls ? this.keyPem : null,
            connectTimeoutMs: this.connectTimeoutMs,
            requestTimeoutMs: this.requestTimeoutMs,
            maxResponseBytes: this.maxResponseBytes,
          })
        }
        break
      } catch (error) {
        lastError = error
        // 网络类错误允许回退备用域名；解析后不再回退
        if (error instanceof WechatV2Error) throw error
      }
    }
    if (xmlText == null) {
      throw new WechatV2Error('NETWORK_ERROR', '微信支付接口网络错误', { retryable: true, ambiguous: true })
    }

    let parsed
    try {
      parsed = parseV2Xml(xmlText)
    } catch (error) {
      throw new WechatV2Error('BAD_RESPONSE', `微信支付响应解析失败：${error.message}`, { retryable: true, ambiguous: true })
    }

    if (String(parsed.return_code || '') !== 'SUCCESS') {
      const code = String(parsed.return_msg || 'FAIL').slice(0, 64)
      throw new WechatV2Error('RETURN_FAIL', `微信支付接口返回失败：${code}`, { retryable: true, ambiguous: true })
    }

    if (parsed.appid && String(parsed.appid) !== this.appId) {
      throw new WechatV2Error('APPID_MISMATCH', '微信响应 appid 与商户配置不一致', { retryable: false, ambiguous: true })
    }
    if (parsed.mch_id && String(parsed.mch_id) !== this.mchId) {
      throw new WechatV2Error('MCHID_MISMATCH', '微信响应 mch_id 与商户配置不一致', { retryable: false, ambiguous: true })
    }

    const signType = String(parsed.sign_type || WECHAT_V2_SIGN_HMAC_SHA256) === WECHAT_V2_SIGN_MD5 ? WECHAT_V2_SIGN_MD5 : WECHAT_V2_SIGN_HMAC_SHA256
    if (!verifyV2Signature(parsed, this.apiV2Key, signType)) {
      throw new WechatV2Error('SIGN_MISMATCH', '微信响应签名校验失败', { retryable: false, ambiguous: true })
    }

    if (opts.checkTradeFields) {
      const { outTradeNo, totalFee } = opts.checkTradeFields
      if (outTradeNo && parsed.out_trade_no && String(parsed.out_trade_no) !== String(outTradeNo)) {
        throw new WechatV2Error('OUT_TRADE_NO_MISMATCH', '微信响应商户订单号与请求不一致', { retryable: false, ambiguous: true })
      }
      if (totalFee !== undefined && totalFee !== null && parsed.total_fee !== undefined && String(parsed.total_fee) !== String(totalFee)) {
        throw new WechatV2Error('TOTAL_FEE_MISMATCH', '微信响应金额与请求不一致', { retryable: false, ambiguous: true })
      }
    }
    return parsed
  }
}

function nonce() {
  return crypto.randomBytes(16).toString('hex')
}
