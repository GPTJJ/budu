import crypto from 'node:crypto'
import { PaymentProvider } from './base.js'
import { httpError } from '../../pos-core.js'

export const MOCK_SCENARIOS = Object.freeze([
  'success',
  'failed',
  'pending',
  'timeout',
  'duplicate_callback',
  'delayed_success',
])

const event = (payment, status, extra = {}) => ({
  signature: 'mock-valid',
  eventId: extra.eventId || `mock-event-${crypto.randomUUID()}`,
  paymentNo: payment.paymentNo,
  merchantTradeNo: payment.merchantTradeNo,
  providerTradeNo: payment.providerTradeNo || `MOCK${payment.paymentNo}`,
  status,
  occurredAt: new Date().toISOString(),
  ...extra,
})

export class MockPaymentProvider extends PaymentProvider {
  constructor() { super('mock') }

  async createPayment(payment, options = {}) {
    const scenario = String(options.scenario || 'success')
    if (!MOCK_SCENARIOS.includes(scenario)) throw httpError('Mock 支付场景不正确')
    const delayMs = Math.min(30000, Math.max(20, Number(options.callbackDelayMs) || 1000))
    const providerTradeNo = payment.providerTradeNo || `MOCK${payment.paymentNo}`
    const base = { ...payment, providerTradeNo }
    // The complete code is consumed in memory only. Never return it in
    // metadata because provider metadata is persisted with the payment.
    const metadata = { mockScenario: scenario, authCodeReceived: Boolean(options.authCode) }

    if (scenario === 'success') return { providerTradeNo, metadata, callbacks: [event(base, 'success')] }
    if (scenario === 'failed') return { providerTradeNo, metadata, callbacks: [event(base, 'failed', { failureCode: 'MOCK_FAILED', failureMessage: '模拟支付失败' })] }
    if (scenario === 'pending') return { providerTradeNo, metadata, callbacks: [event(base, 'pending')] }
    if (scenario === 'timeout') return { providerTradeNo, metadata, callbacks: [event(base, 'timeout', { failureCode: 'MOCK_TIMEOUT', failureMessage: '模拟支付超时' })] }
    if (scenario === 'duplicate_callback') {
      const callback = event(base, 'success')
      return { providerTradeNo, metadata, callbacks: [callback, callback] }
    }

    const dueAt = new Date(Date.now() + delayMs).toISOString()
    const scheduledCallback = event(base, 'success')
    return {
      providerTradeNo,
      metadata: { ...metadata, dueAt, scheduledEventId: scheduledCallback.eventId },
      callbacks: [event(base, 'pending')],
      scheduledCallback,
      callbackDelayMs: delayMs,
    }
  }

  async queryPayment(payment) {
    const metadata = payment.providerMetadata || {}
    if (metadata.mockScenario === 'delayed_success' && metadata.dueAt && Date.parse(metadata.dueAt) <= Date.now()) {
      return { callback: event(payment, 'success', { eventId: metadata.scheduledEventId || undefined }) }
    }
    const stableStatus = new Set(['success', 'timeout', 'failed', 'closed'])
    const status = stableStatus.has(payment.status) ? payment.status : 'pending'
    return { callback: event(payment, status) }
  }

  async closePayment(payment) {
    return { callback: event(payment, 'closed') }
  }

  async refundPayment(payment, options = {}) {
    const refundNo = String(options.refundNo || payment.paymentNo)
    return { providerRefundNo: `MOCKRF${refundNo}` }
  }

  async verifyCallback(payload) {
    if (!payload || payload.signature !== 'mock-valid' || !payload.paymentNo || !payload.merchantTradeNo) {
      throw httpError('Mock 支付回调验签失败', 401)
    }
    return { ...payload }
  }
}
