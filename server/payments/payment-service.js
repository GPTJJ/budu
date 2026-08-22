import crypto from 'node:crypto'
import { httpError } from '../pos-core.js'
import { assertOrderPaymentTransition, assertOrderTransition } from '../order-state.js'
import { MockPaymentProvider } from './providers/mock.js'
import { CashPaymentProvider } from './providers/cash.js'
import { WechatPayProvider } from './providers/wechat-pay.js'
import { AlipayProvider } from './providers/alipay.js'
import { wechatPayConfig, wechatPayStoreAllowed } from './wechat-config.js'

const ACTIVE_PAYMENT_STATUSES = ['created', 'pending', 'success']
const CHANNELS = ['wechat', 'alipay', 'cash']
const SENSITIVE_KEYS = /^(authcode|auth_code|code|secret|apikey|api_key|privatekey|private_key|password|cert|key)$/i

const paymentNo = () => `PAY${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`

export function paymentMode() {
  const mode = String(process.env.PAYMENT_MODE || 'mock').trim().toLowerCase()
  return mode === 'live' ? 'live' : 'mock'
}

export function sanitizePayload(value) {
  if (value == null) return null
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, val] of Object.entries(node)) {
        out[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : walk(val)
      }
      return out
    }
    return node
  }
  try {
    const cleaned = walk(value)
    const text = JSON.stringify(cleaned)
    if (text.length > 20000) return { truncated: true, size: text.length, sample: text.slice(0, 20000) }
    return cleaned
  } catch {
    return { note: '[payload too large or unserializable]' }
  }
}

export class PaymentService {
  constructor(prismaClient, providers) {
    this.prisma = prismaClient
    this.providers = providers || new Map([
      ['mock', new MockPaymentProvider()],
      ['cash', new CashPaymentProvider()],
      ['wechat_pay', new WechatPayProvider()],
      ['alipay', new AlipayProvider()],
    ])
  }

  provider(name) {
    const provider = this.providers.get(name)
    if (!provider) throw httpError(`不支持的支付 Provider：${name}`, 400)
    return provider
  }

  resolveProvider(channel) {
    if (paymentMode() === 'mock') return 'mock'
    if (channel === 'cash') return 'cash'
    if (channel === 'wechat') return 'wechat_pay'
    if (channel === 'alipay') return 'alipay'
    throw httpError('支付渠道不正确')
  }

  async result(paymentId) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw httpError('支付记录不存在', 404)
    const order = await this.prisma.order.findUnique({
      where: { id: payment.orderId },
      include: {
        store: true,
        items: { orderBy: { id: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        refunds: { orderBy: { createdAt: 'desc' } },
      },
    })
    return { payment, order }
  }

  async activePayment(orderId) {
    return this.prisma.payment.findFirst({
      where: { orderId, status: { in: ACTIVE_PAYMENT_STATUSES } },
      orderBy: { createdAt: 'desc' },
    })
  }

  /**
   * 订单是否存在未解决的微信支付（created 已发起 / pending / 待核对）。
   * 存在时订单不得取消、不得开启其他支付渠道。
   */
  async unresolvedWechatPayment(orderId) {
    return this.prisma.payment.findFirst({
      where: {
        orderId,
        provider: 'wechat_pay',
        OR: [{ status: 'created' }, { status: 'pending' }, { reconciliationRequired: true }],
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  validateReplay(payment, input) {
    if (payment.orderId !== input.orderId || payment.channel !== input.channel) {
      throw httpError('支付请求幂等键已用于另一笔支付', 409)
    }
  }

  async logEvent(payment, order, event, extra = {}, client = this.prisma) {
    try {
      await client.paymentLog.create({
        data: {
          id: `plog-${crypto.randomUUID()}`,
          paymentId: payment.id,
          orderId: order.id,
          storeKey: order.storeId || '',
          cashierId: order.cashierId || '',
          event,
          channel: payment.channel || '',
          amount: payment.amount || 0n,
          status: extra.status || payment.status || '',
          providerTradeNo: extra.providerTradeNo || payment.providerTradeNo || null,
          failureCode: extra.failureCode || payment.failureCode || '',
          failureMessage: extra.failureMessage || payment.failureMessage || '',
          callbackAt: extra.callbackAt || null,
        },
      })
    } catch (error) {
      console.error('[payment-log]', error.message)
    }
  }

  /** 应用 Provider 返回的核对提示（未决支付持久化字段）。 */
  async applyReconciliation(paymentId, hint) {
    if (!hint || typeof hint !== 'object') return
    const data = {
      providerStatus: String(hint.providerStatus || '').slice(0, 64),
      reconciliationRequired: hint.reconciliationRequired === true,
    }
    if (hint.nextActionAt) data.nextActionAt = new Date(hint.nextActionAt)
    if (hint.reconciledAt) data.reconciledAt = new Date(hint.reconciledAt)
    await this.prisma.payment.update({ where: { id: paymentId }, data })
  }

  /** 统一应用 Provider 响应：交易号、安全元数据、核对提示。 */
  async applyProviderResponse(payment, response) {
    if (!response) return
    const data = {}
    if (response.providerTradeNo) data.providerTradeNo = response.providerTradeNo
    if (response.metadata) {
      data.providerMetadata = response.metadata
      data.responsePayload = sanitizePayload(response.metadata)
    }
    if (Object.keys(data).length > 0) {
      payment = await this.prisma.payment.update({ where: { id: payment.id }, data })
    }
    if (response.reconciliation) {
      await this.applyReconciliation(payment.id, response.reconciliation)
    }
    return payment
  }

  async createPayment(input) {
    const orderId = String(input.orderId || '').trim()
    const channel = String(input.channel || '')
    const requestKey = String(input.requestKey || '').trim()
    const providerName = this.resolveProvider(channel)
    if (!orderId) throw httpError('订单 ID 不正确')
    if (!CHANNELS.includes(channel)) throw httpError('支付渠道不正确')
    if (requestKey.length < 8 || requestKey.length > 160) throw httpError('支付请求幂等键不正确')

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
    // D：真实微信付款码支付必须服务端按 ORDER storeId 强制校验灰度名单。
    // 客户端/UI 状态不是安全边界。
    if (providerName === 'wechat_pay') {
      const provider = this.provider(providerName)
      const config = typeof provider.config === 'function' ? provider.config() : wechatPayConfig()
      if (!config.enabled || !config.configured || paymentMode() !== 'live') {
        throw httpError('微信支付未开通或配置不完整', 501)
      }
      if (!wechatPayStoreAllowed(order.storeId, config)) {
        throw httpError('当前门店未授权微信支付', 403)
      }
    }

    const no = paymentNo()
    let payment
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payment.create({
          data: {
            id: `pay-${crypto.randomUUID()}`,
            paymentNo: no,
            orderId: order.id,
            channel,
            paymentMethod: String(input.paymentMethod || '').slice(0, 30),
            amount: order.payableAmount,
            currency: 'CNY',
            status: 'created',
            merchantTradeNo: `BUDU${no}`,
            provider: providerName,
            requestKey,
            requestPayload: sanitizePayload({
              channel,
              paymentMethod: String(input.paymentMethod || '').slice(0, 30),
              provider: providerName,
              requestedAt: new Date().toISOString(),
            }),
            providerMetadata: {},
          },
        })
        if (order.paymentStatus !== 'pending') {
          assertOrderPaymentTransition(order.paymentStatus, 'pending')
          const updated = await tx.order.updateMany({
            where: { id: order.id, status: 'pending_payment', paymentStatus: order.paymentStatus },
            data: { paymentStatus: 'pending', version: { increment: 1 } },
          })
          if (updated.count !== 1) throw httpError('订单状态已变化，请刷新后重试', 409)
        }
        return created
      })
    } catch (error) {
      if (error?.code !== 'P2002') throw error
      const existing = (await this.prisma.payment.findUnique({ where: { requestKey } })) || (await this.activePayment(order.id))
      if (!existing) throw httpError('支付请求冲突，请查询订单后重试', 409)
      if (existing.channel !== channel) throw httpError('该订单已有其他渠道的支付处理中', 409)
      return { ...(await this.result(existing.id)), reused: true }
    }

    await this.logEvent(payment, order, 'payment.created', { status: 'created' })

    const provider = this.provider(providerName)
    // C：外部网络请求发出前，以单条原子更新持久化「已尝试发起」崩溃标记：
    //   networkAttemptStartedAt（核对器只恢复 created+已发起 的支付）、
    //   reconciliationRequired=true（进入核对队列）、nextActionAt=null（立即可核对）。
    // 三条字段必须同一条语句写入；进程在标记落库后、响应应用前崩溃时，
    // 核对器重启后即可按 orderquery 恢复，绝不盲查本地未发起的支付。
    if (providerName === 'wechat_pay') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          networkAttemptStartedAt: new Date(),
          reconciliationRequired: true,
          nextActionAt: null,
        },
      })
    }
    let response
    try {
      response = await provider.createPayment(payment, {
        scenario: paymentMode() === 'mock' ? input.scenario : undefined,
        callbackDelayMs: input.callbackDelayMs,
        authCode: input.authCode,
      })
    } catch (error) {
      await this.applyPaymentEvent(providerName, {
        eventId: `internal-${crypto.randomUUID()}`,
        paymentNo: payment.paymentNo,
        merchantTradeNo: payment.merchantTradeNo,
        status: 'failed',
        failureCode: 'PROVIDER_ERROR',
        failureMessage: error.message,
        raw: { internal: true, failureCode: 'PROVIDER_ERROR', failureMessage: error.message },
      }).catch((logError) => console.error('[payment-provider-error]', logError.message))
      throw error
    }

    payment = await this.applyProviderResponse(payment, response)
    if (response.reconciliation) {
      await this.logEvent(payment, order, 'payment.reconciliation.required', {
        status: payment.status,
        providerTradeNo: payment.providerTradeNo,
      })
    }
    await this.logEvent(payment, order, 'payment.provider.response', {
      status: response.callbacks?.[0]?.status || payment.status,
      providerTradeNo: payment.providerTradeNo,
    })
    for (const callback of response.callbacks || []) await this.applyProviderResult(providerName, callback)
    if (response.scheduledCallback) {
      const timer = setTimeout(() => {
        this.applyProviderResult(providerName, response.scheduledCallback).catch((error) => console.error('[mock-payment-delay]', error.message))
      }, response.callbackDelayMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    return { ...(await this.result(payment.id)), reused: false }
  }

  async queryPayment(paymentId) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw httpError('支付记录不存在', 404)
    const response = await this.provider(payment.provider).queryPayment(payment)
    await this.applyProviderResponse(payment, response)
    if (response.callback) await this.applyProviderResult(payment.provider, response.callback)
    for (const callback of response.callbacks || []) await this.applyProviderResult(payment.provider, callback)
    const result = await this.result(payment.id)
    await this.logEvent(result.payment, result.order, 'payment.query', {
      status: result.payment.status,
      providerTradeNo: result.payment.providerTradeNo,
    })
    return result
  }

  async closePayment(paymentId) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw httpError('支付记录不存在', 404)
    if (payment.status === 'success') throw httpError('已支付成功的支付单不能关闭', 409)
    if (payment.status === 'closed') return this.result(payment.id)
    const response = await this.provider(payment.provider).closePayment(payment)
    await this.applyProviderResponse(payment, response)
    if (response.callback) await this.applyProviderResult(payment.provider, response.callback)
    for (const callback of response.callbacks || []) await this.applyProviderResult(payment.provider, callback)
    const result = await this.result(payment.id)
    await this.logEvent(result.payment, result.order, 'payment.closed', {
      status: result.payment.status,
      providerTradeNo: result.payment.providerTradeNo,
    })
    return result
  }

  async refundResult(refundId) {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { items: { include: { orderItem: true } } },
    })
    if (!refund) throw httpError('退款记录不存在', 404)
    return { refund }
  }

  async createRefund(input) {
    const orderId = String(input.orderId || '').trim()
    const requestKey = String(input.requestKey || '').trim()
    const reason = String(input.reason || '').slice(0, 300)
    const operator = String(input.operator || '').slice(0, 80)
    if (!orderId || requestKey.length < 8 || requestKey.length > 160) throw httpError('退款参数不正确')

    const replay = await this.prisma.refund.findUnique({ where: { requestKey } })
    if (replay) return this.refundResult(replay.id)

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        payments: true,
        refunds: { include: { items: true } },
      },
    })
    if (!order) throw httpError('订单不存在', 404)
    if (!['paid', 'completed', 'partially_refunded'].includes(order.status)) throw httpError('当前订单状态不可退款', 409)
    const payment = order.payments.find((item) => ['success', 'partially_refunded'].includes(item.status))
    if (!payment) throw httpError('订单没有成功支付的支付单，无法退款', 409)
    if (payment.provider === 'wechat_pay') throw httpError('微信真实退款尚未开放', 501)

    const refundedTotal = order.refunds
      .filter((refund) => refund.status === 'completed')
      .reduce((sum, refund) => sum + refund.refundAmount, 0n)
    const remainingOrder = order.payableAmount - refundedTotal
    if (remainingOrder <= 0n) throw httpError('订单已全额退款', 409)

    const refundedQty = new Map()
    for (const refund of order.refunds) {
      if (refund.status !== 'completed') continue
      for (const item of refund.items || []) {
        refundedQty.set(item.orderItemId, (refundedQty.get(item.orderItemId) || 0) + item.quantity)
      }
    }
    const byId = new Map(order.items.map((item) => [item.id, item]))

    const rawItems = Array.isArray(input.items) && input.items.length > 0 ? input.items : []
    const lines = []
    let amount = 0n
    const discountPercent = BigInt(order.discountPercent ?? 100)
    const lineRefundAmount = (unitPrice, quantity) => {
      const base = BigInt(unitPrice) * BigInt(quantity) * discountPercent
      return (base + 50n) / 100n
    }
    if (rawItems.length === 0) {
      for (const item of order.items) {
        if (item.isGift === true) continue
        const remainingQty = item.quantity - (refundedQty.get(item.id) || 0)
        if (remainingQty <= 0) continue
        const lineAmount = lineRefundAmount(item.unitPrice, remainingQty)
        lines.push({ orderItemId: item.id, quantity: remainingQty, amountCents: lineAmount })
        amount += lineAmount
      }
      if (lines.length > 0 && amount !== remainingOrder) {
        const difference = remainingOrder - amount
        lines[lines.length - 1] = { ...lines[lines.length - 1], amountCents: lines[lines.length - 1].amountCents + difference }
        amount = remainingOrder
      }
    } else {
      for (const row of rawItems) {
        const orderItemId = String(row.orderItemId || '').trim()
        const quantity = Number(row.quantity)
        const item = byId.get(orderItemId)
        if (!item) throw httpError('退款商品不存在于该订单', 400)
        if (item.isGift === true) throw httpError('赠送商品不可退款', 400)
        if (!Number.isInteger(quantity) || quantity < 1) throw httpError('退款数量必须是正整数', 400)
        const remainingQty = item.quantity - (refundedQty.get(item.id) || 0)
        if (quantity > remainingQty) throw httpError(`「${item.productNameSnapshot}」可退数量不足`, 409)
        const lineAmount = lineRefundAmount(item.unitPrice, quantity)
        lines.push({ orderItemId, quantity, amountCents: lineAmount })
        amount += lineAmount
      }
    }
    if (lines.length === 0 || amount <= 0n) throw httpError('没有可退款的商品', 400)
    if (amount > remainingOrder) throw httpError('退款金额超出订单可退金额', 409)

    const no = `RF${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
    const providerResult = await this.provider(payment.provider).refundPayment(payment, {
      refundNo: no,
      refundAmount: amount,
      reason,
    })

    const refund = await this.prisma.$transaction(async (tx) => {
      const created = await tx.refund.create({
        data: {
          id: `ref-${crypto.randomUUID()}`,
          refundNo: no,
          orderId: order.id,
          paymentId: payment.id,
          refundAmount: amount,
          reason,
          status: 'completed',
          providerRefundNo: providerResult.providerRefundNo || `LOCAL${no}`,
          requestKey,
          requestedBy: operator,
          approvedBy: operator,
          completedAt: new Date(),
          items: {
            create: lines.map((line) => ({
              id: `ri-${crypto.randomUUID()}`,
              orderItemId: line.orderItemId,
              quantity: line.quantity,
              amountCents: line.amountCents,
            })),
          },
        },
        include: { items: true },
      })
      const fullyRefunded = amount >= remainingOrder
      const nextOrderStatus = fullyRefunded ? 'refunded' : 'partially_refunded'
      const nextPaymentStatus = fullyRefunded ? 'refunded' : 'partially_refunded'
      assertOrderTransition(order.status, nextOrderStatus)
      assertOrderPaymentTransition(order.paymentStatus, nextPaymentStatus)
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: order.status, paymentStatus: order.paymentStatus },
        data: { status: nextOrderStatus, paymentStatus: nextPaymentStatus, version: { increment: 1 } },
      })
      if (updated.count !== 1) throw httpError('订单状态已变化，请刷新后重试', 409)
      await tx.payment.updateMany({
        where: { id: payment.id, status: 'success' },
        data: { status: nextPaymentStatus },
      })
      await this.logEvent(payment, order, 'refund.completed', {
        status: nextPaymentStatus,
        providerTradeNo: payment.providerTradeNo,
        failureCode: '',
        failureMessage: '',
        callbackAt: new Date(),
      }, tx)
      return created
    })
    return this.refundResult(refund.id)
  }

  async verifyCallback(providerName, payload) {
    return this.provider(providerName).verifyCallback(payload)
  }

  /**
   * 公开回调路径（不可信输入）：先经 Provider 回调验签，再进入状态机。
   * 仅用于微信支付平台等外部回调；MICROPAY 阶段微信回调已被禁用（见 payment-callbacks.js）。
   */
  async handleCallback(providerName, payload) {
    const verified = await this.verifyCallback(providerName, payload)
    return this.applyPaymentEvent(providerName, { ...verified, raw: payload })
  }

  /**
   * 内部可信结果路径（Provider 已通过微信 V2 客户端验签/交叉校验）：
   * 直接进入支付状态机，绝不重新执行公开回调验签。
   * 适用于 MICROPAY 同步响应、orderquery、reverse 等内部结果。
   */
  async applyProviderResult(providerName, eventResult) {
    // 信任边界 = 调用路径本身：只有 PaymentService 内部在收到 Provider
    // 的 createPayment/queryPayment/closePayment 返回值后才会调用本方法；
    // 公开回调仍必须走 handleCallback → verifyCallback 验签。
    if (!eventResult || typeof eventResult !== 'object') throw httpError('Provider 结果格式不正确', 500)
    return this.applyPaymentEvent(providerName, eventResult)
  }

  async applyPaymentEvent(providerName, verified) {
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
          ...(verified.raw !== undefined ? { rawCallback: sanitizePayload(verified.raw) } : {}),
        },
      })
      if (verified.eventId && current.lastCallbackId === String(verified.eventId).slice(0, 120)) {
        await this.logEvent(current, current.order, 'payment.callback.duplicate', {
          status: current.status,
          providerTradeNo: current.providerTradeNo,
          callbackAt: new Date(),
        }, tx)
        return
      }

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
            // 终态：退出核对队列（崩溃标记在创建时即置 reconciliationRequired=true）
            reconciliationRequired: false,
            reconciledAt: new Date(),
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
        await this.logEvent(current, current.order, 'payment.success', {
          status: 'success',
          providerTradeNo: verified.providerTradeNo || current.providerTradeNo,
          callbackAt: new Date(),
        }, tx)
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
          ...(eventStatus === 'failed' || eventStatus === 'timeout' || eventStatus === 'closed'
            ? { reconciliationRequired: false, reconciledAt: new Date() }
            : {}),
        },
      })
      if (current.order.status !== 'pending_payment' || current.order.paymentStatus === 'paid') return
      const nextOrderPaymentStatus = eventStatus === 'pending' ? 'pending' : eventStatus === 'closed' ? 'unpaid' : 'failed'
      assertOrderPaymentTransition(current.order.paymentStatus, nextOrderPaymentStatus)
      await tx.order.updateMany({
        where: { id: current.order.id, status: 'pending_payment', paymentStatus: current.order.paymentStatus },
        data: { paymentStatus: nextOrderPaymentStatus, version: { increment: 1 } },
      })
      await this.logEvent(current, current.order, `payment.${eventStatus}`, {
        status: eventStatus,
        providerTradeNo: verified.providerTradeNo || current.providerTradeNo,
        failureCode: verified.failureCode,
        failureMessage: verified.failureMessage,
        callbackAt: new Date(),
      }, tx)
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
    paymentMethod: payment.paymentMethod || '',
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
    providerStatus: payment.providerStatus || '',
    queryAttempts: payment.queryAttempts || 0,
    lastQueriedAt: payment.lastQueriedAt,
    nextActionAt: payment.nextActionAt,
    reconciliationRequired: payment.reconciliationRequired === true,
    reconciledAt: payment.reconciledAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  }
}
