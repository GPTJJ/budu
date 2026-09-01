import { AlipaySdk } from 'alipay-sdk'

export class AlipayClientError extends Error {
  constructor(code, message, { ambiguous = true, status = 0, providerCode = '' } = {}) {
    super(message)
    this.name = 'AlipayClientError'
    this.code = code
    this.ambiguous = ambiguous
    this.status = status
    this.providerCode = providerCode
  }
}

export class AlipayOpenApiClient {
  constructor(config, { sdk = null } = {}) {
    this.config = config
    this.sdk = sdk || new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      alipayPublicKey: config.alipayPublicKey,
      // BUDU 的应用私钥使用 PKCS8（BEGIN PRIVATE KEY）。若不显式声明，
      // SDK 会按 PKCS1 再包一层，最终生成无法签名的嵌套 PEM。
      keyType: 'PKCS8',
      signType: 'RSA2',
      endpoint: config.endpoint,
      timeout: config.requestTimeoutMs,
    })
  }

  async request(path, body, requestId) {
    let timer = null
    try {
      const deadlineMs = this.config.requestTimeoutMs + 2000
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new AlipayClientError('ABSOLUTE_DEADLINE', '支付宝请求超过绝对时限')), deadlineMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      const response = await Promise.race([
        this.sdk.curl('POST', path, { body, requestId, requestTimeout: this.config.requestTimeoutMs }),
        deadline,
      ])
      if (!response || typeof response.data !== 'object' || response.data == null) throw new AlipayClientError('BAD_RESPONSE', '支付宝响应格式不正确')
      return response.data
    } catch (error) {
      if (error instanceof AlipayClientError) throw error
      const status = Number(error?.responseHttpStatus || error?.response?.status || error?.status || 0)
      const rawProviderCode = String(error?.code || '')
      const providerCode = /^[A-Z0-9._-]{1,64}$/.test(rawProviderCode) ? rawProviderCode : ''
      throw new AlipayClientError('NETWORK_OR_PROVIDER_ERROR', '支付宝请求结果未知，需要主动查询', {
        ambiguous: status === 0 || status >= 500,
        status,
        providerCode,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  verifyNotification(payload) {
    try { return this.sdk.checkNotifySignV2(payload) === true } catch { return false }
  }
}
