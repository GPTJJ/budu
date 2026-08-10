import crypto from 'node:crypto'
import { PaymentProvider } from './base.js'
import { httpError } from '../../pos-core.js'

const event = (payment, status, extra = {}) => ({
  signature: 'cash-valid',
  eventId: extra.eventId || `cash-event-${crypto.randomUUID()}`,
  paymentNo: payment.paymentNo,
  merchantTradeNo: payment.merchantTradeNo,
  providerTradeNo: payment.providerTradeNo || `CASH${payment.paymentNo}`,
  status,
  occurredAt: new Date().toISOString(),
  ...extra,
})

/**
 * 现金支付：由收银员当面确认收款后立即完成，不经过第三方支付平台。
 * 复用统一回调管道完成订单，保证“支付成功”只由后端业务逻辑确认。
 */
export class CashPaymentProvider extends PaymentProvider {
  constructor() {
    super('cash')
  }

  async createPayment(payment, options = {}) {
    const providerTradeNo = payment.providerTradeNo || `CASH${payment.paymentNo}`
    return {
      providerTradeNo,
      metadata: { cashConfirmed: true },
      callbacks: [event({ ...payment, providerTradeNo }, 'success', {
        failureCode: '',
        failureMessage: '',
      })],
    }
  }

  async queryPayment(payment) {
    const status = payment.status === 'success' ? 'success' : payment.status === 'closed' ? 'closed' : payment.status === 'failed' ? 'failed' : 'pending'
    return { callback: event(payment, status) }
  }

  async closePayment(payment) {
    return { callback: event(payment, 'closed') }
  }

  async refundPayment(payment, options = {}) {
    const refundNo = String(options.refundNo || payment.paymentNo)
    return { providerRefundNo: `CASHRF${refundNo}` }
  }

  async verifyCallback(payload) {
    if (!payload || payload.signature !== 'cash-valid' || !payload.paymentNo || !payload.merchantTradeNo) {
      throw httpError('Cash 支付回调验签失败', 401)
    }
    return { ...payload }
  }
}
