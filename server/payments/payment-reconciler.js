// 未决微信支付后台自动核对器
//
// 规则：
// - USERPAYING / 未知结果由服务端后台任务持续查询（默认每 5 秒一次），
//   不依赖 iPad 页面保持打开。
// - 达到查询上限或超过撤销时限后执行最后查询，仍不明确则执行撤销。
// - 撤销结果不明确时继续阻止二次支付并触发人工告警。
// - 应用重启后自动扫描未决微信支付并恢复核对。
// - 使用条件更新（queryAttempts / reconciliationRequired 参与 where）保证
//   多进程/多实例下同一支付只有一个核对执行者。
import { paymentService } from './index.js'

export class PaymentReconciler {
  constructor({
    service = paymentService,
    providerName = 'wechat_pay',
    intervalMs = 5000,
    maxQueries = 12,
    reverseAfterMs = 60000,
    batchSize = 20,
    alarm = (message) => console.error('[wechat-pay-reconciler]', message),
  } = {}) {
    this.service = service
    this.providerName = providerName
    this.intervalMs = intervalMs
    this.maxQueries = maxQueries
    this.reverseAfterMs = reverseAfterMs
    this.batchSize = batchSize
    this.alarm = alarm
    this.timer = null
    this.running = false
  }

  start() {
    if (this.timer) return this
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.alarm(`tick 失败：${error.message}`))
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    // 启动即扫描一次（覆盖服务重启后的未决支付）
    this.tick().catch((error) => this.alarm(`启动扫描失败：${error.message}`))
    return this
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async pendingPayments() {
    const now = new Date()
    return this.service.prisma.payment.findMany({
      where: {
        provider: this.providerName,
        status: 'pending',
        reconciliationRequired: true,
        OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }],
      },
      orderBy: { requestedAt: 'asc' },
      take: this.batchSize,
    })
  }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      const payments = await this.pendingPayments()
      for (const payment of payments) {
        const elapsedMs = payment.lastQueriedAt ? Date.now() - new Date(payment.lastQueriedAt).getTime() : 0
        if (payment.queryAttempts >= this.maxQueries || elapsedMs >= this.reverseAfterMs) {
          await this.reconcileReverse(payment)
          continue
        }
        await this.reconcileQuery(payment)
      }
    } finally {
      this.running = false
    }
  }

  /** 认领并查询一次。条件更新保证单执行者。 */
  async reconcileQuery(payment) {
    const now = new Date()
    const claimed = await this.service.prisma.payment.updateMany({
      where: {
        id: payment.id,
        queryAttempts: payment.queryAttempts,
        reconciliationRequired: true,
        status: 'pending',
      },
      data: {
        queryAttempts: { increment: 1 },
        lastQueriedAt: now,
        nextActionAt: new Date(now.getTime() + this.intervalMs),
      },
    })
    if (claimed.count !== 1) return
    const provider = this.service.provider(this.providerName)
    const response = await provider.queryPayment(payment)
    for (const callback of response.callbacks || []) {
      await this.service.handleCallback(this.providerName, callback)
    }
    if (response.reconciliation) {
      await this.service.applyReconciliation(payment.id, response.reconciliation)
    }
    await this.markReconciledIfTerminal(payment.id)
  }

  /** 最后查询仍不明确 → 撤销；撤销不明确 → 告警并继续阻止二次支付。 */
  async reconcileReverse(payment) {
    const provider = this.service.provider(this.providerName)
    const response = await provider.closePayment(payment)
    for (const callback of response.callbacks || []) {
      await this.service.handleCallback(this.providerName, callback)
    }
    if (response.reconciliation) {
      await this.service.applyReconciliation(payment.id, response.reconciliation)
    }
    const result = await this.service.result(payment.id)
    if (['success', 'failed', 'closed', 'timeout'].includes(result.payment.status)) {
      await this.markReconciledIfTerminal(payment.id)
    } else {
      this.alarm(`支付 ${payment.paymentNo} 撤销后状态仍不明确（${result.payment.status}），禁止二次支付，需要人工核对`)
      // 继续留在核对队列，降低频率重试
      await this.service.prisma.payment.update({
        where: { id: payment.id },
        data: { nextActionAt: new Date(Date.now() + 30 * 1000) },
      })
    }
  }

  async markReconciledIfTerminal(paymentId) {
    const current = await this.service.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!current) return
    if (['success', 'failed', 'closed', 'timeout'].includes(current.status)) {
      await this.service.prisma.payment.update({
        where: { id: paymentId },
        data: { reconciliationRequired: false, reconciledAt: new Date(), providerStatus: current.status },
      })
    }
  }
}

let _instance = null

/** 启动单例对账器（服务启动时调用一次；未启用微信支付时返回 null）。 */
export function startWechatReconciler(options = {}) {
  if (_instance) return _instance
  _instance = new PaymentReconciler(options)
  return _instance.start()
}
