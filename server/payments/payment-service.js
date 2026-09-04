import crypto from 'node:crypto'
import { httpError } from '../pos-core.js'
import { assertOrderPaymentTransition, assertOrderTransition } from '../order-state.js'
import { MockPaymentProvider } from './providers/mock.js'
import { CashPaymentProvider } from './providers/cash.js'
import { WechatPayProvider } from './providers/wechat-pay.js'
import { AlipayProvider } from './providers/alipay.js'
import { settlementCoordinator } from '../settlements/settlement-coordinator.js'
import { completeSweetCardRefund, prepareSweetCardRefund } from '../sweet-card-refunds.js'

const ACTIVE_PAYMENT_STATUSES = ['created', 'pending', 'success']
const CHANNELS = ['wechat', 'alipay', 'cash']
const SENSITIVE_KEYS = /^(authcode|auth_code|code|secret|apikey|api_key|privatekey|private_key|password|cert|key|sign|buyer_id|buyer_logon_id|open_id|user_id)$/i

const paymentNo = () => `PAY${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`
const providerRefundCents = (refund) => refund.providerRefundAmount == null && refund.sweetCardRefundAmount == null
  ? BigInt(refund.refundAmount)
  : BigInt(refund.providerRefundAmount || 0)

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
  constructor(prismaClient, providers, coordinator = settlementCoordinator) {
    this.prisma = prismaClient
    this.settlementCoordinator = coordinator
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
        externalSettlement: true,
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

  /** 订单是否存在未解决的支付；存在时不得取消或开启其他支付渠道。 */
  async unresolvedPayment(orderId) {
    return this.prisma.payment.findFirst({
      where: {
        orderId,
        OR: [{ status: 'created' }, { status: 'pending' }, { reconciliationRequired: true }],
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  // 兼容旧调用与旧测试；通用权威为 unresolvedPayment()。
  async unresolvedWechatPayment(orderId) {
    return this.unresolvedPayment(orderId)
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
    if (order.settlementAuthority !== 'PAYMENT') throw httpError('外部结算订单不能创建 Payment', 409)
    const providerName = this.resolveProvider(channel)
    const active = await this.activePayment(order.id)
    if (active) {
      if (active.status === 'success') return { ...(await this.result(active.id)), reused: true }
      if (active.channel !== channel) throw httpError('该订单已有其他渠道的支付处理中，请先查询或关闭原支付', 409)
      return { ...(await this.result(active.id)), reused: true }
    }
    if (order.status !== 'pending_payment' || !['unpaid', 'failed', 'pending'].includes(order.paymentStatus)) {
      throw httpError('当前订单状态不可创建支付', 409)
    }
    const paymentAmount = order.payableAmount - BigInt(order.sweetCardAmount || 0)
    if (paymentAmount <= 0n) throw httpError('订单已无外部待支付金额')
    // Provider 自己负责配置完整性和门店灰度；UI 永远不是安全边界。
    const provider = this.provider(providerName)
    if (typeof provider.assertAvailable === 'function') {
      provider.assertAvailable({ storeId: order.storeId, mode: paymentMode(), authCode: input.authCode })
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
            amount: paymentAmount,
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

    // C：外部网络请求发出前，以单条原子更新持久化「已尝试发起」崩溃标记：
    //   networkAttemptStartedAt（核对器只恢复 created+已发起 的支付）、
    //   reconciliationRequired=true（进入核对队列）、nextActionAt=null（立即可核对）。
    // 三条字段必须同一条语句写入；进程在标记落库后、响应应用前崩溃时，
    // 核对器重启后即可按 orderquery 恢复，绝不盲查本地未发起的支付。
    if (provider.capability?.('ambiguousResultRecovery')) {
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
        providerTradeNo: payment?.providerTradeNo,
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

  /**
   * 将退款 Provider 的安全状态应用到本地。
   * 微信申请接口只表示受理，因此 pending 时绝不改订单/支付状态；只有查询确认
   * SUCCESS 后才原子完成退款并更新订单为部分退款或已退款。
   */
  async applyRefundProviderResult(refundId, providerResult = {}) {
    const status = String(providerResult.status || 'pending')
    const providerRefundNo = providerResult.providerRefundNo || undefined
    if (status === 'pending') {
      if (providerRefundNo) {
        await this.prisma.refund.update({ where: { id: refundId }, data: { providerRefundNo } })
      }
      return this.refundResult(refundId)
    }
    if (status === 'failed') {
      await this.prisma.refund.updateMany({
        where: { id: refundId, status: 'pending' },
        data: { status: 'failed', ...(providerRefundNo ? { providerRefundNo } : {}) },
      })
      return this.refundResult(refundId)
    }
    if (status !== 'completed') throw httpError('退款 Provider 返回了未知状态', 502)

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUnique({ where: { id: refundId } })
      if (!current || current.status === 'completed') return
      if (current.refundMode !== 'PAYMENT' || current.externalSettlementId || (!current.paymentId && BigInt(current.sweetCardRefundAmount || 0) <= 0n)) {
        throw httpError('退款不属于 Payment authority', 409)
      }
      if (current.status !== 'pending') throw httpError('当前退款状态不可完成', 409)
      const won = await tx.refund.updateMany({
        where: { id: refundId, status: 'pending' },
        data: {
          status: 'completed',
          ...(providerRefundNo ? { providerRefundNo } : {}),
          completedAt: new Date(),
        },
      })
      if (won.count !== 1) return
      await completeSweetCardRefund(tx, current, current.requestedBy)
      const state = await this.settlementCoordinator.applyCompletedRefund(tx, { refundId: current.id })
      const payment = current.paymentId ? await tx.payment.findUnique({ where: { id: current.paymentId } }) : null
      if (payment) await this.logEvent(payment, state.orderBefore, 'refund.completed', {
        status: state.order.paymentStatus,
        providerTradeNo: payment?.providerTradeNo,
        failureCode: '',
        failureMessage: '',
        callbackAt: new Date(),
      }, tx)
    })
    return this.refundResult(refundId)
  }

  /** 查询并推进一条 Provider 退款；按 Provider 能力决定是否允许原退款单号安全重提。 */
  async reconcileRefund(refundId, { resubmitIfMissing = true } = {}) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } })
    if (!refund) throw httpError('退款记录不存在', 404)
    if (refund.refundMode !== 'PAYMENT' || !refund.paymentId || refund.externalSettlementId) {
      throw httpError('Manual External Refund 不进入 Payment 核对', 409)
    }
    if (refund.status !== 'pending') return this.refundResult(refund.id)
    const payment = await this.prisma.payment.findUnique({ where: { id: refund.paymentId } })
    if (!payment) throw httpError('退款对应的支付记录不存在', 404)
    const provider = this.provider(payment.provider)
    const supportsRefundQuery = provider.capability?.('supportsRefundQuery') ?? typeof provider.queryRefund === 'function'
    if (!supportsRefundQuery) return this.refundResult(refund.id)
    let result = await provider.queryRefund(payment, {
      refundNo: refund.refundNo,
      providerRefundNo: refund.providerRefundNo,
      refundAmount: providerRefundCents(refund),
    })
    const ageMs = Date.now() - new Date(refund.createdAt).getTime()
    const resubmitAfterMs = Number(provider.capability?.('refundResubmitAfterMs') || 0)
    if (result.notFound && resubmitIfMissing && resubmitAfterMs > 0 && ageMs >= resubmitAfterMs) {
      result = await provider.refundPayment(payment, {
        refundNo: refund.refundNo,
        refundAmount: providerRefundCents(refund),
        totalAmount: payment.amount,
        reason: refund.reason,
      })
    }
    return this.applyRefundProviderResult(refund.id, result)
  }

  async createRefund(input) {
    const orderId = String(input.orderId || '').trim()
    const requestKey = String(input.requestKey || '').trim()
    const reason = String(input.reason || '').slice(0, 300)
    const operator = String(input.operator || '').slice(0, 80)
    if (!orderId || requestKey.length < 8 || requestKey.length > 160) throw httpError('退款参数不正确')

    const replay = await this.prisma.refund.findUnique({ where: { requestKey } })
    if (replay) {
      if (replay.status === 'pending' && replay.providerRefundAmount === 0n && replay.sweetCardRefundAmount > 0n) return this.applyRefundProviderResult(replay.id, { status: 'completed' })
      return replay.status === 'pending' ? this.reconcileRefund(replay.id) : this.refundResult(replay.id)
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        payments: true,
        refunds: { include: { items: true } },
      },
    })
    if (!order) throw httpError('订单不存在', 404)
    if (order.settlementAuthority !== 'PAYMENT') throw httpError('外部结算退款尚未开放', 409)
    if (!['paid', 'completed', 'partially_refunded'].includes(order.status)) throw httpError('当前订单状态不可退款', 409)
    const payment = order.payments.find((item) => ['success', 'partially_refunded'].includes(item.status))
    if (!payment && BigInt(order.sweetCardAmount || 0) !== BigInt(order.payableAmount)) throw httpError('订单没有完整结算事实，无法退款', 409)
    const pendingRefund = order.refunds.find((refund) => refund.status === 'pending')
    if (pendingRefund) throw httpError('该订单已有退款处理中，请等待退款结果后再操作', 409)
    const provider = payment ? this.provider(payment.provider) : null
    const repeatDelayMs = Number(provider?.capability?.('refundRepeatDelayMs') || 0)
    if (repeatDelayMs > 0 && order.refunds.length > 0) {
      const latestAt = Math.max(...order.refunds.map((refund) => new Date(refund.createdAt).getTime()).filter(Number.isFinite))
      const waitMs = latestAt + repeatDelayMs - Date.now()
      if (Number.isFinite(waitMs) && waitMs > 0) {
        const message = String(provider?.capability?.('refundRepeatMessage') || '同一支付单的多次退款需等待')
        throw httpError(`${message}，请约 ${Math.ceil(waitMs / 1000)} 秒后重试`, 409)
      }
    }

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
    const lineRefundAmount = (item, refundedBefore, quantity) => {
      const lineActual = item.actualAmount == null
        ? (BigInt(item.unitPrice) * BigInt(item.quantity) * discountPercent + 50n) / 100n
        : BigInt(item.actualAmount)
      const totalQuantity = BigInt(item.quantity)
      const before = lineActual * BigInt(refundedBefore) / totalQuantity
      const after = lineActual * BigInt(refundedBefore + quantity) / totalQuantity
      return after - before
    }
    if (rawItems.length === 0) {
      for (const item of order.items) {
        if (item.isGift === true) continue
        const remainingQty = item.quantity - (refundedQty.get(item.id) || 0)
        if (remainingQty <= 0) continue
        const lineAmount = lineRefundAmount(item, refundedQty.get(item.id) || 0, remainingQty)
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
        const lineAmount = lineRefundAmount(item, refundedQty.get(item.id) || 0, quantity)
        lines.push({ orderItemId, quantity, amountCents: lineAmount })
        amount += lineAmount
      }
    }
    if (lines.length === 0 || amount <= 0n) throw httpError('没有可退款的商品', 400)
    if (amount > remainingOrder) throw httpError('退款金额超出订单可退金额', 409)

    const no = `RF${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
    let refund
    try {
      refund = await this.prisma.$transaction(async (tx) => {
        const created = await tx.refund.create({
          data: {
            id: `ref-${crypto.randomUUID()}`,
            refundNo: no,
            orderId: order.id,
            paymentId: payment?.id || null,
            externalSettlementId: null,
            refundMode: 'PAYMENT',
            refundAmount: amount,
            reason,
            status: 'pending',
            requestKey,
            requestedBy: operator,
            approvedBy: operator,
            externalCompletedAt: null,
            externalRefundReference: null,
            completedAt: null,
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
        await prepareSweetCardRefund(tx, { refund: created, order })
        return tx.refund.findUnique({ where: { id: created.id }, include: { items: true } })
      })
    } catch (error) {
      if (error?.code !== 'P2002') throw error
      const sameRequest = await this.prisma.refund.findUnique({ where: { requestKey } })
      if (sameRequest) {
        if (sameRequest.status === 'pending' && sameRequest.providerRefundAmount === 0n && sameRequest.sweetCardRefundAmount > 0n) return this.applyRefundProviderResult(sameRequest.id, { status: 'completed' })
        return sameRequest.status === 'pending' ? this.reconcileRefund(sameRequest.id) : this.refundResult(sameRequest.id)
      }
      throw httpError('该订单已有退款处理中，请等待退款结果后再操作', 409)
    }
    if (providerRefundCents(refund) === 0n) return this.applyRefundProviderResult(refund.id, { status: 'completed' })
    let providerResult
    try {
      providerResult = await provider.refundPayment(payment, {
        refundNo: no,
        refundAmount: providerRefundCents(refund),
        totalAmount: payment.amount,
        reason,
      })
    } catch (error) {
      await this.prisma.refund.updateMany({ where: { id: refund.id, status: 'pending' }, data: { status: 'failed' } })
      throw error
    }
    return this.applyRefundProviderResult(refund.id, providerResult)
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
      if (verified.merchantTradeNo && String(verified.merchantTradeNo) !== current.merchantTradeNo) throw httpError('支付事件商户单号不匹配', 409)
      if (verified.amount != null && BigInt(verified.amount) !== current.amount) throw httpError('支付事件金额不匹配', 409)
      if (verified.currency && String(verified.currency) !== current.currency) throw httpError('支付事件币种不匹配', 409)
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
        await this.settlementCoordinator.settlePayment(tx, {
          paymentId: current.id,
          completedAt: verified.occurredAt ? new Date(verified.occurredAt) : new Date(),
        })
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
