import crypto from 'node:crypto'
import { httpError } from '../../pos-core.js'
import { alipayConfig, alipayStoreAllowed } from '../alipay-config.js'
import { AlipayOpenApiClient } from '../alipay-client.js'
import { PaymentProvider } from './base.js'

export const ALIPAY_AUTH_CODE_RE = /^\d{16,64}$/
const SUCCESS_STATES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED'])
const PENDING_STATES = new Set(['WAIT_BUYER_PAY', 'USERPAYING'])
const CLOSED_STATES = new Set(['TRADE_CLOSED'])

const cents = (value) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value ?? ''))) return null
  const [whole, fraction = ''] = String(value).split('.')
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
}
const yuan = (value) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`
const safeCode = (data) => String(data?.sub_code || data?.code || data?.trade_status || 'UNKNOWN').slice(0, 64)

function event(payment, status, extra = {}) {
  return {
    eventId: extra.eventId || `alipay-${payment.paymentNo}-${status}-${crypto.randomUUID()}`,
    paymentNo: payment.paymentNo,
    merchantTradeNo: payment.merchantTradeNo,
    status,
    occurredAt: extra.occurredAt || new Date().toISOString(),
    providerTradeNo: extra.providerTradeNo || null,
    amount: extra.amount,
    currency: 'CNY',
    failureCode: extra.failureCode || '',
    failureMessage: extra.failureMessage || '',
  }
}

export class AlipayProvider extends PaymentProvider {
  constructor({ config = null, client = null } = {}) {
    super('alipay', {
      supportsQuery: true,
      supportsCancel: true,
      supportsRefund: true,
      supportsRefundQuery: true,
      supportsCallback: true,
      ambiguousResultRecovery: true,
      refundResubmitAfterMs: 60000,
    })
    this._config = config
    this._client = client
  }

  config() { return this._config || alipayConfig() }
  client(config = this.config()) {
    if (!this._client) this._client = new AlipayOpenApiClient(config)
    return this._client
  }

  assertAvailable({ storeId, mode, authCode } = {}) {
    const config = this.config()
    if (mode !== 'live') throw httpError('支付宝真实 Provider 仅在 PAYMENT_MODE=live 时可用', 503)
    if (!config.enabled || !config.configured) throw httpError('支付宝支付未启用或配置不完整', 503)
    if (!alipayStoreAllowed(storeId, config)) throw httpError('当前门店未启用支付宝支付', 403)
    if (!ALIPAY_AUTH_CODE_RE.test(String(authCode || '').trim())) throw httpError('请扫描有效的支付宝付款码')
  }

  validateTrade(payment, data) {
    if (data.out_trade_no && String(data.out_trade_no) !== payment.merchantTradeNo) throw httpError('支付宝响应商户单号不匹配', 502)
    if (data.total_amount != null && cents(data.total_amount) !== payment.amount) throw httpError('支付宝响应金额不匹配', 502)
    if (data.seller_id && String(data.seller_id) !== this.config().sellerId) throw httpError('支付宝响应收款账号不匹配', 502)
  }

  mapQuery(payment, data) {
    this.validateTrade(payment, data)
    const state = String(data.trade_status || '')
    const providerTradeNo = data.trade_no ? String(data.trade_no) : null
    const verifiedAmount = cents(data.total_amount)
    if (SUCCESS_STATES.has(state) && verifiedAmount !== payment.amount) {
      return event(payment, 'pending', { providerTradeNo, failureCode: 'AMOUNT_UNVERIFIED', failureMessage: '支付宝成功状态缺少可核对金额，需要人工核对' })
    }
    if (SUCCESS_STATES.has(state)) return event(payment, 'success', { providerTradeNo, amount: verifiedAmount })
    if (CLOSED_STATES.has(state)) return event(payment, 'closed', { providerTradeNo, failureCode: state, failureMessage: '支付宝交易已关闭' })
    if (PENDING_STATES.has(state)) return event(payment, 'pending', { providerTradeNo, failureCode: state, failureMessage: '支付宝支付处理中' })
    return event(payment, 'pending', { providerTradeNo, failureCode: safeCode(data), failureMessage: '支付宝状态未知，需要继续核对' })
  }

  async createPayment(payment, options = {}) {
    const authCode = String(options.authCode || '').trim()
    if (!ALIPAY_AUTH_CODE_RE.test(authCode)) throw httpError('请扫描有效的支付宝付款码')
    const config = this.config()
    try {
      const data = await this.client(config).request('/v3/alipay/trade/pay', {
        out_trade_no: payment.merchantTradeNo,
        total_amount: yuan(payment.amount),
        subject: 'budu POS',
        scene: 'bar_code',
        auth_code: authCode,
        notify_url: config.notifyUrl,
      }, payment.requestKey)
      this.validateTrade(payment, data)
      const providerTradeNo = data.trade_no ? String(data.trade_no) : null
      const state = String(data.trade_status || '')
      const verifiedAmount = cents(data.total_amount)
      const status = verifiedAmount === payment.amount && (SUCCESS_STATES.has(state) || (providerTradeNo && !state)) ? 'success' : 'pending'
      return {
        providerTradeNo,
        metadata: { protocol: config.protocol, endpoint: config.endpoint, scene: 'bar_code' },
        callbacks: [event(payment, status, {
          providerTradeNo,
          amount: verifiedAmount,
          failureCode: status === 'pending' ? safeCode(data) : '',
          failureMessage: status === 'pending' ? '支付宝扣款结果未定，需要主动查询' : '',
        })],
      }
    } catch (error) {
      return { callbacks: [event(payment, 'pending', { failureCode: error.code || 'ALIPAY_AMBIGUOUS', failureMessage: '支付宝请求结果未知，需要主动查询' })] }
    }
  }

  async queryPayment(payment) {
    try {
      const data = await this.client().request('/v3/alipay/trade/query', { out_trade_no: payment.merchantTradeNo }, `query-${payment.paymentNo}`)
      return { callback: this.mapQuery(payment, data) }
    } catch (error) {
      return { callback: event(payment, 'pending', { failureCode: error.providerCode || error.code || 'QUERY_AMBIGUOUS', failureMessage: '支付宝查询失败，需要继续核对' }) }
    }
  }

  async closePayment(payment) {
    const before = await this.queryPayment(payment)
    if (before.callback?.status === 'success' || before.callback?.status === 'closed') return before
    try {
      const data = await this.client().request('/v3/alipay/trade/cancel', { out_trade_no: payment.merchantTradeNo }, `cancel-${payment.paymentNo}`)
      this.validateTrade(payment, data)
      if (String(data.retry_flag || 'N') === 'Y') return { callback: event(payment, 'pending', { failureCode: 'CANCEL_RETRY', failureMessage: '支付宝撤销需重试，禁止开启新支付' }) }
      return { callback: event(payment, 'closed', { failureCode: 'CANCELLED', failureMessage: '支付宝支付已撤销' }) }
    } catch (error) {
      if (error?.providerCode === 'ACQ.TRADE_NOT_EXIST' && error?.ambiguous === false) {
        return { callback: event(payment, 'closed', { failureCode: 'ACQ.TRADE_NOT_EXIST', failureMessage: '支付宝交易不存在，视为未支付' }) }
      }
      return { callback: event(payment, 'pending', { failureCode: error.code || 'CANCEL_AMBIGUOUS', failureMessage: '支付宝撤销结果未知，需要继续核对' }) }
    }
  }

  async refundPayment(payment, input) {
    try {
      const data = await this.client().request('/v3/alipay/trade/refund', {
        out_trade_no: payment.merchantTradeNo,
        refund_amount: yuan(input.refundAmount),
        out_request_no: input.refundNo,
        refund_reason: String(input.reason || '').slice(0, 200),
      }, input.refundNo)
      this.validateTrade(payment, data)
      if (data.refund_fee != null && cents(data.refund_fee) !== input.refundAmount) throw httpError('支付宝退款响应金额不匹配', 502)
      return { status: 'pending', providerRefundNo: data.trade_no ? String(data.trade_no) : null }
    } catch {
      return { status: 'pending' }
    }
  }

  async queryRefund(payment, input) {
    try {
      const data = await this.client().request('/v3/alipay/trade/fastpay/refund/query', { out_trade_no: payment.merchantTradeNo, out_request_no: input.refundNo }, `refund-query-${input.refundNo}`)
      this.validateTrade(payment, data)
      const refundAmount = cents(data.refund_amount ?? data.refund_fee)
      if (refundAmount != null && refundAmount !== input.refundAmount) throw httpError('支付宝退款查询金额不匹配', 502)
      if (String(data.refund_status || '') === 'REFUND_SUCCESS' && refundAmount === input.refundAmount) return { status: 'completed', providerRefundNo: data.trade_no ? String(data.trade_no) : null }
      return { status: 'pending', notFound: safeCode(data) === 'ACQ.TRADE_NOT_EXIST' }
    } catch {
      return { status: 'pending' }
    }
  }

  async verifyCallback(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpError('支付宝通知格式不正确', 400)
    if (String(payload.sign_type || '') !== 'RSA2') throw httpError('支付宝通知签名算法不正确', 400)
    if (!this.client().verifyNotification(payload)) throw httpError('支付宝通知验签失败', 400)
    const config = this.config()
    if (String(payload.app_id || '') !== config.appId) throw httpError('支付宝通知 AppID 不匹配', 409)
    if (String(payload.seller_id || '') !== config.sellerId) throw httpError('支付宝通知 Seller ID 不匹配', 409)
    const merchantTradeNo = String(payload.out_trade_no || '')
    const providerTradeNo = String(payload.trade_no || '')
    const state = String(payload.trade_status || '')
    const amount = cents(payload.total_amount)
    if (!merchantTradeNo || !providerTradeNo || amount == null) throw httpError('支付宝通知关键字段缺失', 400)
    if (![...SUCCESS_STATES, ...PENDING_STATES, ...CLOSED_STATES].includes(state)) throw httpError('支付宝通知交易状态不受信任', 400)
    return {
      eventId: `alipay-${providerTradeNo}-${state}-${String(payload.notify_id || payload.gmt_payment || '').slice(0, 48)}`,
      merchantTradeNo, providerTradeNo,
      status: SUCCESS_STATES.has(state) ? 'success' : CLOSED_STATES.has(state) ? 'closed' : 'pending',
      amount, currency: String(payload.currency || 'CNY'),
      occurredAt: payload.gmt_payment || payload.notify_time || new Date().toISOString(),
      failureCode: SUCCESS_STATES.has(state) ? '' : state,
      failureMessage: SUCCESS_STATES.has(state) ? '' : '支付宝通知状态未终结为成功',
    }
  }
}
