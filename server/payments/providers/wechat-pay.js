// 微信付款码支付 Provider（APIv2 MICROPAY）
//
// 映射：
//   createPayment() → /pay/micropay
//   queryPayment()  → /pay/orderquery
//   closePayment()  → 先查询，再按规则 /secapi/pay/reverse（双向 TLS）
//   refundPayment() → 本阶段明确返回「微信真实退款尚未开放」
//
// 状态规则（同步响应与查询结果统一转换为已验证 Provider Event）：
//   SUCCESS                        → success
//   USERPAYING / SYSTEMERROR / 未知 → pending + reconciliationRequired（绝不直接失败）
//   明确终态错误（付款码过期/无效/余额不足等）→ failed
//   REVOKED / CLOSED               → closed
//   金额/商户号/订单号不一致        → pending + reconciliationRequired + 告警
//
// 安全：付款码只存在于本 Provider 调用栈内存，绝不进入 metadata/日志/持久化。
//
// R3 绝对时限：单次 Provider 操作（一次 createPayment / queryPayment / closePayment，
// 覆盖其内部全部顺序子调用）受 WECHAT_PAY_PROVIDER_ABSOLUTE_DEADLINE_MS 硬性墙钟上限约束：
//  - 上限到期 → AbortController.abort() 主动中止底层 HTTP 请求（真实传输 destroy socket），
//    且不再回退备用域名；
//  - 操作返回受控的「歧义/可重试」结果（pending + reconciliationRequired），
//    绝不虚构终态、绝不取消订单。
//  该上限与核对租约的关系（lease > deadline + margin）见 wechat-v2-client.js。
import crypto from 'node:crypto'
import { PaymentProvider } from './base.js'
import { httpError } from '../../pos-core.js'
import { WechatV2Client, WechatV2Error, WECHAT_PAY_PROVIDER_ABSOLUTE_DEADLINE_MS } from '../wechat-v2-client.js'
import { wechatPayConfig } from '../wechat-config.js'
import { isValidPublicIpv4 } from '../terminal-ip.js'
import { parseV2Xml, verifyV2Signature } from '../wechat-v2-signature.js'

// 微信付款码：18 位纯数字，官方允许前缀 10-15
export const WECHAT_AUTH_CODE_RE = /^(1[0-5])\d{16}$/

/** 终端 IP 安全边界：缺失/非法/保留段一律 fail closed，绝不回退 127.0.0.1。
 *  规则唯一权威实现：terminal-ip.js（与配置层共用同一套逻辑）。 */
function assertTerminalIp(config) {
  const ip = String(config.terminalIp || '').trim()
  if (!isValidPublicIpv4(ip)) {
    throw httpError('收银终端 IP 未配置或无效（微信 MICROPAY 要求公网可路由 IPv4），请联系管理员', 501)
  }
}

// 明确不会扣款的终态错误码
const TERMINAL_ERR_CODES = new Set([
  'AUTHCODEEXPIRE', // 付款码过期
  'AUTH_CODE_INVALID', // 无效付款码
  'NOTENOUGH', // 余额不足
  'PARAM_ERROR', // 请求参数错误（本系统金额/订单号校验已先行拦截，此处视为无扣款）
  'NOAUTH', // 商户无权限（产品/配置问题，未发生扣款）
  'MCH_NOT_EXIST', // 商户号不存在
])

const event = (payment, status, extra = {}) => ({
  signature: 'wechat-v2-verified',
  eventId: `wx-${crypto.randomUUID()}`,
  paymentNo: payment.paymentNo,
  merchantTradeNo: payment.merchantTradeNo,
  providerTradeNo: extra.providerTradeNo || payment.providerTradeNo || null,
  status,
  occurredAt: new Date().toISOString(),
  ...extra,
})

function safeMetadata(result) {
  // 只保留安全字段；绝不包含付款码、openid、签名、原始 XML。
  return {
    wechat: {
      resultCode: String(result.result_code || ''),
      errCode: String(result.err_code || ''),
      tradeState: String(result.trade_state || ''),
      tradeType: String(result.trade_type || ''),
      providerTradeNo: result.transaction_id || null,
    },
  }
}

export class WechatPayProvider extends PaymentProvider {
  constructor(options = {}) {
    super('wechat_pay')
    this._clientFactory = options.clientFactory || null
    this._config = options.config || null
    this._deadlineMs = options.deadlineMs || WECHAT_PAY_PROVIDER_ABSOLUTE_DEADLINE_MS
  }

  config() {
    return this._config || wechatPayConfig()
  }

  client() {
    const config = this.config()
    if (this._clientFactory) return this._clientFactory(config)
    return new WechatV2Client({
      mchId: config.mchId,
      appId: config.appId,
      apiV2Key: config.apiV2Key,
      certPem: config.certPem || undefined,
      keyPem: config.keyPem || undefined,
    })
  }

  assertUsable() {
    const config = this.config()
    if (!config.enabled || !config.configured) {
      throw httpError('微信支付尚未开通或配置不完整', 501)
    }
    // 终端 IP 是 MICROPAY 必填且必须为公网可路由 IPv4；缺失/非法时在发起任何
    // 网络请求之前 fail closed（R2 起已删除 127.0.0.1 回退；R3 使用共享严格校验）。
    assertTerminalIp(config)
  }

  /**
   * R3：单次 Provider 操作的绝对墙钟上限。
   * 覆盖 DNS/TCP/TLS/请求/响应/主备域名回退/操作内全部顺序子调用。
   * 到期：abort() 主动中止底层请求（真实传输 → req.destroy/socket 销毁），
   * 并返回受控歧义结果（pending + reconciliationRequired，绝不虚构终态）。
   */
  async _bounded(payment, fn) {
    const controller = new AbortController()
    let timer = null
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort() // 主动中止底层 HTTP 请求（真实传输 → req.destroy）
        reject(new WechatV2Error('ABSOLUTE_DEADLINE', '微信支付操作超过绝对时限，结果未知，需要核对', { retryable: true, ambiguous: true }))
      }, this._deadlineMs)
    })
    if (typeof timer.unref === 'function') timer.unref()
    try {
      return await Promise.race([fn(controller.signal), deadline])
    } catch (error) {
      // 绝对时限到期 → 受控歧义结果（支付保持待核对，订单绝不被取消/虚构终态）
      if (error instanceof WechatV2Error && error.code === 'ABSOLUTE_DEADLINE') {
        return {
          providerTradeNo: null,
          metadata: { wechat: { resultCode: '', errCode: 'ABSOLUTE_DEADLINE', error: true } },
          callbacks: [event(payment, 'pending', { failureCode: 'ABSOLUTE_DEADLINE', failureMessage: '微信支付操作超过绝对时限，结果未知，需要核对' })],
          reconciliation: { providerStatus: 'ABSOLUTE_DEADLINE', reconciliationRequired: true },
        }
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async createPayment(payment, options = {}) {
    this.assertUsable()
    const authCode = String(options.authCode || '')
    if (!WECHAT_AUTH_CODE_RE.test(authCode)) {
      throw httpError('请扫描有效的微信付款码（18 位数字）', 400)
    }
    return this._bounded(payment, (signal) => this._createPaymentWithSignal(payment, options, signal))
  }

  async _createPaymentWithSignal(payment, options, signal) {
    const config = this.config()
    const outTradeNo = payment.merchantTradeNo
    const totalFee = payment.amount.toString()
    const client = this.client()

    let result
    try {
      result = await client.request(
        '/pay/micropay',
        {
          out_trade_no: outTradeNo,
          body: 'BUDU',
          total_fee: totalFee,
          auth_code: String(options.authCode || ''),
          // assertUsable() 已保证 terminalIp 为合法公网 IPv4；此处不得有任何回环回退。
          spbill_create_ip: config.terminalIp,
        },
        { checkTradeFields: { outTradeNo, totalFee }, signal },
      )
    } catch (error) {
      // R3：绝对时限已到 → 立即中止本操作，交由 _bounded 返回受控歧义结果，
      // 绝不继续执行后续顺序子调用。
      if (signal?.aborted) throw error
      return this.mapMicroPayError(payment, error)
    }

    if (String(result.result_code || '') === 'SUCCESS') {
      return {
        providerTradeNo: result.transaction_id || null,
        metadata: safeMetadata(result),
        callbacks: [
          event(payment, 'success', {
            providerTradeNo: result.transaction_id || null,
          }),
        ],
      }
    }

    const errCode = String(result.err_code || '')
    if (errCode === 'ORDERPAID') {
      // 商户订单号已支付：立即查询确认最终状态（同一绝对时限内）
      const query = await this._queryPaymentWithSignal(payment, signal)
      return {
        ...query,
        metadata: { ...query.metadata, wechat: { ...(query.metadata?.wechat || {}), initialErrCode: 'ORDERPAID' } },
      }
    }
    if (errCode === 'USERPAYING') {
      return {
        providerTradeNo: null,
        metadata: safeMetadata(result),
        callbacks: [event(payment, 'pending', { failureCode: 'USERPAYING', failureMessage: '微信支付处理中，请等待扣款结果' })],
        reconciliation: { providerStatus: 'USERPAYING', reconciliationRequired: true },
      }
    }
    if (TERMINAL_ERR_CODES.has(errCode)) {
      return {
        providerTradeNo: null,
        metadata: safeMetadata(result),
        callbacks: [
          event(payment, 'failed', {
            failureCode: errCode,
            failureMessage: String(result.err_code_des || '付款失败').slice(0, 120),
          }),
        ],
      }
    }
    // SYSTEMERROR / BANKERROR / 其他未知错误：保持待核对，绝不直接失败
    return {
      providerTradeNo: null,
      metadata: safeMetadata(result),
      callbacks: [
        event(payment, 'pending', {
          failureCode: errCode || 'UNKNOWN',
          failureMessage: '微信扣款结果未知，正在核对',
        }),
      ],
      reconciliation: { providerStatus: errCode || 'UNKNOWN', reconciliationRequired: true },
    }
  }

  mapMicroPayError(payment, error) {
    if (error instanceof WechatV2Error) {
      // 金额/订单号/商户号不一致或签名失败：人工核对，不得完成订单
      if (['TOTAL_FEE_MISMATCH', 'OUT_TRADE_NO_MISMATCH', 'MCHID_MISMATCH', 'APPID_MISMATCH', 'SIGN_MISMATCH'].includes(error.code)) {
        return {
          providerTradeNo: null,
          metadata: { wechat: { resultCode: '', errCode: error.code, error: true } },
          callbacks: [
            event(payment, 'pending', { failureCode: error.code, failureMessage: '微信响应校验异常，需要人工核对' }),
          ],
          reconciliation: { providerStatus: error.code, reconciliationRequired: true },
        }
      }
      if (error.ambiguous || error.retryable) {
        // 网络超时/绝对时限/系统异常/响应不明确：可能已扣款，必须待核对
        return {
          providerTradeNo: null,
          metadata: { wechat: { resultCode: '', errCode: error.code, error: true } },
          callbacks: [
            event(payment, 'pending', { failureCode: error.code, failureMessage: '微信扣款结果未知，正在核对' }),
          ],
          reconciliation: { providerStatus: error.code, reconciliationRequired: true },
        }
      }
      throw error
    }
    if (error?.status === 501 || error?.status === 400) throw error
    // 本地异常——保持待核对而非误判失败
    return {
      providerTradeNo: null,
      metadata: { wechat: { resultCode: '', errCode: 'PROVIDER_LOCAL_ERROR', error: true } },
      callbacks: [
        event(payment, 'pending', { failureCode: 'PROVIDER_LOCAL_ERROR', failureMessage: '微信支付本地处理异常，正在核对' }),
      ],
      reconciliation: { providerStatus: 'LOCAL_ERROR', reconciliationRequired: true },
    }
  }

  async queryPayment(payment) {
    this.assertUsable()
    return this._bounded(payment, (signal) => this._queryPaymentWithSignal(payment, signal))
  }

  async _queryPaymentWithSignal(payment, signal) {
    const client = this.client()
    const outTradeNo = payment.merchantTradeNo
    const totalFee = payment.amount ? payment.amount.toString() : undefined
    let result
    try {
      result = await client.request(
        '/pay/orderquery',
        {
          out_trade_no: outTradeNo,
          ...(payment.providerTradeNo ? { transaction_id: payment.providerTradeNo } : {}),
        },
        { checkTradeFields: { outTradeNo, totalFee }, signal },
      )
    } catch (error) {
      // R3：绝对时限已到 → 立即中止本操作，交由 _bounded 返回受控歧义结果
      if (signal?.aborted) throw error
      if (error instanceof WechatV2Error && !error.ambiguous && !error.retryable) {
        return {
          providerTradeNo: null,
          metadata: { wechat: { resultCode: '', errCode: error.code, error: true } },
          callbacks: [event(payment, 'pending', { failureCode: error.code, failureMessage: '微信查询校验异常，需要人工核对' })],
          reconciliation: { providerStatus: error.code, reconciliationRequired: true },
        }
      }
      return {
        providerTradeNo: null,
        metadata: { wechat: { resultCode: '', errCode: error.code || 'NETWORK_ERROR', error: true } },
        callbacks: [event(payment, 'pending', { failureCode: error.code || 'NETWORK_ERROR', failureMessage: '微信查询网络异常，继续核对' })],
        reconciliation: { providerStatus: error.code || 'NETWORK_ERROR', reconciliationRequired: true },
      }
    }

    if (String(result.result_code || '') !== 'SUCCESS') {
      const errCode = String(result.err_code || '')
      if (TERMINAL_ERR_CODES.has(errCode)) {
        return {
          providerTradeNo: result.transaction_id || null,
          metadata: safeMetadata(result),
          callbacks: [event(payment, 'failed', { failureCode: errCode, failureMessage: String(result.err_code_des || '支付失败').slice(0, 120) })],
        }
      }
      return {
        providerTradeNo: result.transaction_id || null,
        metadata: safeMetadata(result),
        callbacks: [event(payment, 'pending', { failureCode: errCode || 'UNKNOWN', failureMessage: '微信查询结果未知，继续核对' })],
        reconciliation: { providerStatus: errCode || 'UNKNOWN', reconciliationRequired: true },
      }
    }

    const tradeState = String(result.trade_state || '')
    const providerTradeNo = result.transaction_id || null
    if (tradeState === 'SUCCESS') {
      return {
        providerTradeNo,
        metadata: safeMetadata(result),
        callbacks: [event(payment, 'success', { providerTradeNo })],
      }
    }
    if (tradeState === 'CLOSED' || tradeState === 'REVOKED') {
      return {
        providerTradeNo,
        metadata: safeMetadata(result),
        callbacks: [event(payment, 'closed', { failureCode: tradeState, failureMessage: '微信支付已关闭/撤销' })],
      }
    }
    if (tradeState === 'PAYERROR') {
      return {
        providerTradeNo,
        metadata: safeMetadata(result),
        callbacks: [event(payment, 'failed', { failureCode: 'PAYERROR', failureMessage: '微信支付失败' })],
      }
    }
    // USERPAYING / NOTPAY / REFUND / 未知：保持待核对
    return {
      providerTradeNo,
      metadata: safeMetadata(result),
      callbacks: [event(payment, 'pending', { failureCode: tradeState || 'UNKNOWN', failureMessage: '微信扣款结果未定，继续核对' })],
      reconciliation: { providerStatus: tradeState || 'UNKNOWN', reconciliationRequired: true },
    }
  }

  async closePayment(payment) {
    this.assertUsable()
    // 整次 closePayment（查询 + 撤销 + 撤销后复查）共享同一个绝对时限与中止信号
    return this._bounded(payment, async (signal) => {
      const query = await this._queryPaymentWithSignal(payment, signal)
      const eventStatus = query.callbacks?.[0]?.status
      if (eventStatus === 'success' || eventStatus === 'failed' || eventStatus === 'closed') {
        return query
      }
      // USERPAYING / 未知：执行撤销（双向 TLS）
      const client = this.client()
      let result
      try {
        result = await client.request(
          '/secapi/pay/reverse',
          { out_trade_no: payment.merchantTradeNo },
          { useMtls: true, checkTradeFields: { outTradeNo: payment.merchantTradeNo }, signal },
        )
      } catch (error) {
        // R3：绝对时限已到 → 立即中止本操作，交由 _bounded 返回受控歧义结果
        if (signal?.aborted) throw error
        if (error instanceof WechatV2Error && !error.retryable && !error.ambiguous) {
          throw error
        }
        return {
          providerTradeNo: null,
          metadata: { wechat: { resultCode: '', errCode: error.code || 'REVERSE_NETWORK_ERROR', error: true } },
          callbacks: [event(payment, 'pending', { failureCode: error.code || 'REVERSE_NETWORK_ERROR', failureMessage: '撤销结果未知，禁止重新支付，需要人工核对' })],
          reconciliation: { providerStatus: 'REVERSE_UNKNOWN', reconciliationRequired: true },
        }
      }
      if (String(result.result_code || '') === 'SUCCESS') {
        // recall=Y：按官方撤销协议必须继续重试撤销，绝不标记 closed；
        // 保持待核对并进入重试队列（状态持久化，重启后可继续）。
        if (String(result.recall || '') === 'Y') {
          return {
            providerTradeNo: null,
            metadata: { wechat: { resultCode: 'SUCCESS', recall: 'Y', errCode: '', tradeState: 'REVOKE_RETRY' } },
            callbacks: [event(payment, 'pending', { failureCode: 'REVOKE_RETRY', failureMessage: '微信撤销需重试，继续核对' })],
            reconciliation: { providerStatus: 'REVOKE_RETRY', reconciliationRequired: true },
          }
        }
        // recall=N：撤销已定案，再查询一次确认终态（同一绝对时限内）
        const after = await this._queryPaymentWithSignal(payment, signal)
        if (after.callbacks?.[0]?.status === 'closed' || after.callbacks?.[0]?.status === 'failed') return after
        return {
          providerTradeNo: null,
          metadata: { wechat: { resultCode: 'SUCCESS', recall: 'N', errCode: '', tradeState: 'REVOKED_ACCEPTED' } },
          callbacks: [event(payment, 'closed', { failureCode: 'REVOKED', failureMessage: '微信支付已撤销' })],
        }
      }
      const errCode = String(result.err_code || '')
      if (errCode === 'ORDERNOTEXIST') {
        return {
          providerTradeNo: null,
          metadata: safeMetadata(result),
          callbacks: [event(payment, 'closed', { failureCode: 'ORDERNOTEXIST', failureMessage: '微信订单不存在，视为未支付' })],
        }
      }
      // 撤销结果不明确：继续阻止二次支付并告警
      return {
        providerTradeNo: null,
        metadata: safeMetadata(result),
        callbacks: [event(payment, 'pending', { failureCode: errCode || 'REVERSE_FAIL', failureMessage: '撤销结果不明确，禁止重新支付，需要人工核对' })],
        reconciliation: { providerStatus: 'REVERSE_FAIL', reconciliationRequired: true },
      }
    })
  }

  async refundPayment() {
    throw httpError('微信真实退款尚未开放', 501)
  }

  async verifyCallback(payload) {
    const config = this.config()
    if (!config.configured) throw httpError('微信支付未配置', 501)
    let params = payload
    if (typeof payload === 'string') {
      try {
        params = parseV2Xml(payload)
      } catch {
        throw httpError('微信回调 XML 解析失败', 400)
      }
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw httpError('微信回调格式不正确', 400)
    if (String(params.return_code || '') !== 'SUCCESS') throw httpError('微信回调 return_code 非 SUCCESS', 400)
    if (!verifyV2Signature(params, config.apiV2Key)) throw httpError('微信回调签名校验失败', 401)
    if (params.mch_id && String(params.mch_id) !== config.mchId) throw httpError('微信回调商户号不匹配', 401)
    const tradeState = String(params.trade_state || params.result_code || '')
    const status = tradeState === 'SUCCESS' ? 'success' : tradeState === 'CLOSED' || tradeState === 'REVOKED' ? 'closed' : 'pending'
    return {
      eventId: `wxcb-${crypto.randomUUID()}`,
      paymentNo: '',
      merchantTradeNo: String(params.out_trade_no || ''),
      providerTradeNo: params.transaction_id || null,
      status,
      failureCode: status === 'pending' ? String(params.trade_state || params.err_code || 'PENDING') : '',
      failureMessage: '',
      occurredAt: new Date().toISOString(),
    }
  }
}
