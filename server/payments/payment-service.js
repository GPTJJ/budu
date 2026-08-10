import crypto from 'node:crypto'
import { httpError } from '../pos-core.js'
import { assertOrderPaymentTransition, assertOrderTransition } from '../order-state.js'
import { MockPaymentProvider } from './providers/mock.js'
import { WechatPayProvider } from './providers/wechat-pay.js'
import { AlipayProvider } from './providers/alipay.js'

const ACTIVE_PAYMENT_STATUSES = ['created', 'pending', 'success']
const CHANNELS = ['wechat', 'alipay', 'cash']

const paymentNo = () => `PAY${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`

export class PaymentService {
  constructor(prismaClient, providers) {
    this.prisma = prismaClient
    this.providers = providers || new Map([
      ['mock', new MockPaymentProvider()],
      ['wechat_pay', new WechatPayProvider()],
      ['alipay', new AlipayProvider()],
    ])
  }

  provider(name) {
    const provider = this.providers.get(name)
    if (!provider) throw httpError(`不支持的支付 Provider：${name}`, 400)
    return provider
  }

  async result(paymentId) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw httpError('支付记录不存在', 404)
    const order = await this.prisma.order.findUnique({
      where: { id: payment.orderId },
      include: { store: true, items: { orderBy: { id: 'asc' } }, payments: { orderBy: { createdAt: 'desc' } } },
    })
    return { payment, order }
  }

  async activePayment(orderId) {
    return this.prisma.payment.findFirst({
      where: { orderId, status: { in: ACTIVE_PAYMENT_STATUSES } },
      orderBy: { createdAt: 'desc' },
    })
  }

  validateReplay(payment, input) {
    if (payment.orderId !== input.orderId || payment.channel !== input.channel) {
      throw httpError('支付请求幂等键已用于另一笔支付', 409)
    }
  }

  async createPayment(input) {
    const orderId = String(input.orderId || '').trim()
    const channel = String(input.channel || '')
    const requestKey = String(input.requestKey || '').trim()
    const providerName = String(input.provider || 'mock')
    if (!orderId) throw httpError('订单 ID 不正确')
    if (!CHANNELS.includes(channel)) throw httpError('支付渠道不正确')
    if (requestKey.length < 8 || requestKey.length > 160) throw httpError('支付请求幂等键不正确')
    if (providerName !== 'mock') throw httpError('当前阶段仅启用 MockPaymentProvider', 501)

    const replay = await this.prisma.payment.findUnique({ where: { requestKey } })
    if (replay) {
      this.validateReplay(replay, { orderId, channel })
      return { ...(await this.result(replay.id)), reused: true }
    }

    const order = await this.prisma.order.findUnique({ where: { id: orderId } })
    if (!order) throw httpError('订单不存在', 404)
    const active = await this.activePayment(order.id)
    if (active) {
      if (active.status === 'success') return { ...(await this.result(active.id)), reused: true }
      if (active.channel !== channel) throw httpError('该订单已有其他渠道的支付处理中，请先查询或关闭原支付', 409)
      return { ...(await this.result(active.id)), reused: true }
    }
    if (order.status !== 'pending_payment' || !['unpaid', 'failed', 'pending'].includes(order.paymentStatus)) {
      throw httpError('当前订单状态不可创建支付', 409)
    }
    if (order.payableAmount <= 0n) throw httpError('订单应付金额必须大于 0')

    const no = paymentNo()
    let payment
    try {
      payment = await this.prisma.payment.create({
        data: {
          id: `pay-${crypto.randomUUID()}`,
          paymentNo: no,
          orderId: order.id,
          channel,
          amount: order.payableAmount,
          currency: 'CNY',
          status: 'created',
          merchantTradeNo: `BUDU${no}`,
          provider: providerName,
          requestKey,
          providerMetadata: {},
        },
      })
    } catch (error) {
      if (error?.code !== 'P2002') throw error
      const existing = await this.prisma.payment.findUnique({ where: { requestKey } }) || await this.activePayment(order.id)
      if (!existing) throw httpError('支付请求冲突，请查询订单后重试', 409)
      if (existing.channel !== channel) throw httpError('该订单已有其他渠道的支付处理中', 409)
      return { ...(await this.result(existing.id)), reused: true }
    }

    if (order.paymentStatus !== 'pending') {
      assertOrderPaymentTransition(order.paymentStatus, 'pending')
      await this.prisma.order.updateMany({
        where: { id: order.id, status: 'pending_payment', paymentStatus: order.paymentStatus },
        data: { paymentStatus: 'pending', version: { increment: 1 } },
      })
    }

    const provider = this.provider(providerName)
    let response
    try {
      response = await provider.createPayment(payment, {
        scenario: input.scenario,
        callbackDelayMs: input.callbackDelayMs,
      })
    } catch (error) {
      await this.handleCallback(providerName, {
        signature: 'mock-valid',
        eventId: `provider-error-${crypto.randomUUID()}`,
        paymentNo: payment.paymentNo,
        merchantTradeNo: payment.merchantTradeNo,
        status: 'failed',
        failureCode: 'PROVIDER_ERROR',
        failureMessage: error.message,
      })
      throw error
    }

    payment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerTradeNo: response.providerTradeNo || null,
        providerMetadata: response.metadata || {},
      },
    })
    for (const callback of response.callbacks || []) await this.handleCallback(providerName, callback)
    if (response.scheduledCallback) {
      const timer = setTimeout(() => {
        this.handleCallback(providerName, response.scheduledCallback).catch((error) => console.error('[mock-payment-delay]', error.message))
      }, response.callbackDelayMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    return { ...(await this.result(payment.id)), reused: false }
  }

  async queryPayment(paymentId) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw httpError('支付记录不存在', 404)
    const response = await this.provider(payment.provider).queryPayment(payment)
    if (response.callback) await this.handleCallback(payment.provider, response.callback)
    return this.result(payment.id)
  }

  async closePayment(paymentId) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw httpError('支付记录不存在', 404)
    if (payment.status === 'success') throw httpError('已支付成功的支付单不能关闭', 409)
    if (payment.status === 'closed') return this.result(payment.id)
    const response = await this.provider(payment.provider).closePayment(payment)
    if (response.callback) await this.handleCallback(payment.provider, response.callback)
    return this.result(payment.id)
  }

  async refundPayment() {
    throw httpError('退款方法与状态已预留，本阶段暂不执行退款', 501)
  }

  async verifyCallback(providerName, payload) {
    return this.provider(providerName).verifyCallback(payload)
  }

  async handleCallback(providerName, payload) {
    const verified = await this.verifyCallback(providerName, payload)
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          { paymentNo: verified.paymentNo },
          { merchantTradeNo: verified.merchantTradeNo },
        ],
      },
    })
    if (!payment) throw httpError('回调对应的支付记录不存在', 404)
    if (payment.provider !== providerName) throw httpError('支付回调 Provider 不匹配', 409)

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.payment.findUnique({ where: { id: payment.id }, include: { order: true } })
      if (!current) throw httpError('支付记录不存在', 404)
      await tx.payment.update({
        where: { id: current.id },
        data: {
          callbackCount: { increment: 1 },
          lastCallbackId: String(verified.eventId || '').slice(0, 120),
          lastCallbackAt: new Date(),
        },
      })
      if (verified.eventId && current.lastCallbackId === String(verified.eventId).slice(0, 120)) return

      if (verified.status === 'success') {
        if (current.status === 'success') return
        const won = await tx.payment.updateMany({
          where: { id: current.id, status: { notIn: ['success', 'refunded'] } },
          data: {
            status: 'success',
            providerTradeNo: verified.providerTradeNo || current.providerTradeNo,
            failureCode: '',
            failureMessage: '',
            paidAt: verified.occurredAt ? new Date(verified.occurredAt) : new Date(),
          },
        })
        if (won.count !== 1) return
        if (current.amount !== current.order.payableAmount) throw httpError('支付金额与订单应付金额不一致', 409)
        if (current.order.status === 'pending_payment') {
          assertOrderTransition('pending_payment', 'paid')
          assertOrderPaymentTransition(current.order.paymentStatus, 'paid')
          const paid = await tx.order.updateMany({
            where: { id: current.order.id, status: 'pending_payment', paymentStatus: current.order.paymentStatus },
            data: {
              status: 'paid',
              paymentStatus: 'paid',
              paymentMethod: current.channel,
              paymentMode: current.provider,
              version: { increment: 1 },
            },
          })
          if (paid.count === 1) {
            assertOrderTransition('paid', 'completed')
            await tx.order.updateMany({
              where: { id: current.order.id, status: 'paid' },
              data: { status: 'completed', completedAt: new Date(), version: { increment: 1 } },
            })
          }
        } else if (current.order.status === 'paid') {
          assertOrderTransition('paid', 'completed')
          await tx.order.updateMany({
            where: { id: current.order.id, status: 'paid' },
            data: { status: 'completed', completedAt: new Date(), version: { increment: 1 } },
          })
        } else if (current.order.status !== 'completed') {
          throw httpError(`订单 ${current.order.status} 状态收到成功支付，需要人工核对`, 409)
        }
        return
      }

      if (current.status === 'success') return
      const eventStatus = verified.status === 'timeout' ? 'timeout' : verified.status === 'closed' ? 'closed' : verified.status === 'failed' ? 'failed' : 'pending'
      await tx.payment.updateMany({
        where: { id: current.id, status: { not: 'success' } },
        data: {
          status: eventStatus,
          providerTradeNo: verified.providerTradeNo || current.providerTradeNo,
          failureCode: String(verified.failureCode || '').slice(0, 80),
          failureMessage: String(verified.failureMessage || '').slice(0, 300),
          ...(eventStatus === 'failed' || eventStatus === 'timeout' ? { failedAt: new Date() } : {}),
          ...(eventStatus === 'closed' ? { closedAt: new Date() } : {}),
        },
      })
      if (current.order.status !== 'pending_payment' || current.order.paymentStatus === 'paid') return
      const nextOrderPaymentStatus = eventStatus === 'pending' ? 'pending' : eventStatus === 'closed' ? 'unpaid' : 'failed'
      assertOrderPaymentTransition(current.order.paymentStatus, nextOrderPaymentStatus)
      await tx.order.updateMany({
        where: { id: current.order.id, status: 'pending_payment', paymentStatus: current.order.paymentStatus },
        data: { paymentStatus: nextOrderPaymentStatus, version: { increment: 1 } },
      })
    })
    return this.result(payment.id)
  }
}

export function serializePayment(payment) {
  return {
    id: payment.id,
    paymentNo: payment.paymentNo,
    orderId: payment.orderId,
    channel: payment.channel,
    amount: payment.amount.toString(),
    currency: payment.currency,
    status: payment.status,
    merchantTradeNo: payment.merchantTradeNo,
    providerTradeNo: payment.providerTradeNo,
    provider: payment.provider,
    failureCode: payment.failureCode,
    failureMessage: payment.failureMessage,
    callbackCount: payment.callbackCount,
    requestedAt: payment.requestedAt,
    paidAt: payment.paidAt,
    failedAt: payment.failedAt,
    closedAt: payment.closedAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  }
}
