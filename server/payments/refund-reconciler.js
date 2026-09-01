// 微信退款后台核对器：申请退款只代表受理，必须通过 refundquery 确认最终结果。
// 多实例重复查询/重提使用同一个 out_refund_no，微信侧保持幂等；本地完成更新也用
// status=pending 条件更新，确保订单状态只推进一次。
import { paymentService } from './index.js'

const DEFAULT_INTERVAL_MS = 30_000
const MIN_INTERVAL_MS = 5_000
const MAX_INTERVAL_MS = 300_000

function boundedInterval(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_MS || parsed > MAX_INTERVAL_MS) return DEFAULT_INTERVAL_MS
  return parsed
}

export function refundReconcilerEnvConfig(env = process.env, providerNames = ['wechat_pay']) {
  const values = providerNames.map((name) => name === 'alipay' ? env.ALIPAY_REFUND_QUERY_INTERVAL_MS : env.WECHAT_REFUND_QUERY_INTERVAL_MS)
  return { intervalMs: Math.min(...values.map(boundedInterval)) }
}

export class RefundReconciler {
  constructor({ service = paymentService, providerNames = ['wechat_pay'], intervalMs = DEFAULT_INTERVAL_MS, batchSize = 20, alarm = (message) => console.error('[refund-reconciler]', message) } = {}) {
    this.service = service
    this.providerNames = providerNames
    this.intervalMs = intervalMs
    this.batchSize = batchSize
    this.alarm = alarm
    this.timer = null
  }

  start() {
    if (this.timer) return this
    this.timer = setInterval(() => this.tick().catch((error) => this.alarm(`tick 失败：${error.message}`)), this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.tick().catch((error) => this.alarm(`启动扫描失败：${error.message}`))
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick() {
    const refunds = await this.service.prisma.refund.findMany({
      where: { refundMode: 'PAYMENT', status: 'pending', payment: { provider: { in: this.providerNames } } },
      orderBy: { createdAt: 'asc' },
      take: this.batchSize,
    })
    for (const refund of refunds) {
      try {
        await this.service.reconcileRefund(refund.id)
      } catch (error) {
        this.alarm(`退款 ${refund.refundNo} 核对失败：${error.message}`)
      }
    }
  }
}

let instance = null

export function startProviderRefundReconciler(options = {}) {
  if (instance) return instance
  instance = new RefundReconciler(options)
  return instance.start()
}

export function startWechatRefundReconciler(options = {}) { return startProviderRefundReconciler(options) }
