// 未决微信支付后台自动核对器（R3：崩溃恢复 + 稳定撤销计时 + 跨进程租约 +
// nextActionAt 门控 + 正常完成即释放租约）
//
// 规则：
// - 可恢复支付 = provider=wechat_pay 且 reconciliationRequired=true 且
//     status='pending'（任何未决），或
//     status='created' 且 networkAttemptStartedAt 非空（已向微信发起但响应未落库）。
//   本地创建但从未发起网络请求的支付（created 且无 networkAttemptStartedAt）绝不盲查。
// - 撤销时限以稳定起点 requestedAt（首笔请求时间）推导：now >= requestedAt + reverseAfterMs。
//   反复查询不会推迟撤销期限。
// - 查询采用数据库原子条件更新租约（reconcileLeaseOwner/reconcileLeaseUntil）：
//   同一支付在同一租约窗口内只有一个执行者；租约到期可被其他实例回收，进程死亡不悬挂。
// - nextActionAt 门控：发现（pendingPayments）与认领（两条条件更新）都要求
//   nextActionAt 为空或已到期，避免同一支付在排期时间前被重复执行。
// - R3 租约释放：每次「正常完成」的操作（查询/撤销，含 pending/USERPAYING/
//   recall 重试/歧义/终态）立即按「所有者身份」条件释放租约（owner 匹配才清空），
//   旧 worker 不得清除已被其他 worker 合法认领的租约；真正的节奏由 nextActionAt 控制。
//   进程崩溃/操作未到达清理：租约保持到过期，由其他实例按过期回收。
// - 应用重启后自动扫描未决支付并恢复核对。
// - 撤销结果不明确（含 recall=Y）时保持 reconciliationRequired 并告警。
import crypto from 'node:crypto'
import { SAFE_MINIMUM_LEASE_MS } from './wechat-v2-client.js'
import { paymentService } from './index.js'

const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_MAX_QUERIES = 12
const DEFAULT_REVERSE_AFTER_MS = 60000
// R3：安全最小租约 = Provider 绝对时限（90s）+ 安全边际（30s）= 120s。
// 推导见 wechat-v2-client.js；租约绝不允许被环境配置降到安全最小值以下
//（非法/不安全取值一律回退或钳制到 SAFE_MINIMUM_LEASE_MS）。
const DEFAULT_LEASE_MS = SAFE_MINIMUM_LEASE_MS
const MIN_INTERVAL_MS = 1000
const MAX_INTERVAL_MS = 60000
const MAX_QUERIES_MIN = 3
const MAX_QUERIES_MAX = 600
const REVERSE_AFTER_MIN_MS = 5000
const REVERSE_AFTER_MAX_MS = 3600000
const LEASE_MIN_MS = SAFE_MINIMUM_LEASE_MS
const LEASE_MAX_MS = 3600000

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

/** 从环境变量读取并做有界校验的对账参数（无效值回退安全默认值）。 */
export function reconcilerEnvConfig(env = process.env) {
  return {
    intervalMs: boundedInt(env.WECHAT_PAY_QUERY_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    maxQueries: boundedInt(env.WECHAT_PAY_MAX_QUERIES, DEFAULT_MAX_QUERIES, MAX_QUERIES_MIN, MAX_QUERIES_MAX),
    reverseAfterMs: boundedInt(env.WECHAT_PAY_REVERSE_AFTER_MS, DEFAULT_REVERSE_AFTER_MS, REVERSE_AFTER_MIN_MS, REVERSE_AFTER_MAX_MS),
    leaseMs: boundedInt(env.WECHAT_PAY_LEASE_MS, DEFAULT_LEASE_MS, LEASE_MIN_MS, LEASE_MAX_MS),
  }
}

export class PaymentReconciler {
  constructor({
    service = paymentService,
    providerName = 'wechat_pay',
    intervalMs = DEFAULT_INTERVAL_MS,
    maxQueries = DEFAULT_MAX_QUERIES,
    reverseAfterMs = DEFAULT_REVERSE_AFTER_MS,
    leaseMs = DEFAULT_LEASE_MS,
    batchSize = 20,
    instanceId = null,
    now = null,
    alarm = (message) => console.error('[wechat-pay-reconciler]', message),
  } = {}) {
    this.service = service
    this.providerName = providerName
    this.intervalMs = intervalMs
    this.maxQueries = maxQueries
    this.reverseAfterMs = reverseAfterMs
    this.leaseMs = leaseMs
    this.batchSize = batchSize
    this.instanceId = instanceId || `reconciler-${crypto.randomBytes(6).toString('hex')}`
    this.now = now || (() => new Date())
    this.alarm = alarm
    this.timer = null
  }

  start() {
    if (this.timer) return this
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.alarm(`tick 失败：${error.message}`))
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.tick().catch((error) => this.alarm(`启动扫描失败：${error.message}`))
    return this
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick() {
    const now = this.now()
    const payments = await this.pendingPayments(now)
    for (const payment of payments) {
      const requestedAt = payment.requestedAt ? new Date(payment.requestedAt).getTime() : now.getTime()
      const reverseDue = now.getTime() >= requestedAt + this.reverseAfterMs
      if (payment.queryAttempts >= this.maxQueries || reverseDue) {
        await this.reconcileReverse(payment, now)
        continue
      }
      await this.reconcileQuery(payment, now)
    }
  }

  /** 列出可恢复、已到排期（nextActionAt 为空或已到期）且租约已过期/空闲的未决支付。 */
  async pendingPayments(now) {
    return this.service.prisma.payment.findMany({
      where: {
        AND: [
          { provider: this.providerName },
          { reconciliationRequired: true },
          {
            OR: [
              { status: 'pending' },
              { status: 'created', networkAttemptStartedAt: { not: null } },
            ],
          },
          {
            OR: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { lt: now } }],
          },
          {
            OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }],
          },
        ],
      },
      orderBy: { requestedAt: 'asc' },
      take: this.batchSize,
    })
  }

  /**
   * 原子认领（租约 + 查询计数 + 状态提升一次完成）并查询。
   * 条件更新保证同一支付在同一租约窗口内只有一个执行者；
   * nextActionAt 未到期时条件不命中，防止排期前的重复执行。
   */
  async reconcileQuery(payment, now) {
    const claimed = await this.service.prisma.payment.updateMany({
      where: {
        AND: [
          { id: payment.id },
          { reconciliationRequired: true },
          { OR: [{ status: 'pending' }, { status: 'created' }] },
          { OR: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { lt: now } }] },
          { OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] },
        ],
      },
      data: {
        status: 'pending',
        queryAttempts: { increment: 1 },
        lastQueriedAt: now,
        nextActionAt: new Date(now.getTime() + this.intervalMs),
        reconcileLeaseOwner: this.instanceId,
        reconcileLeaseUntil: new Date(now.getTime() + this.leaseMs),
      },
    })
    if (claimed.count !== 1) return
    const provider = this.service.provider(this.providerName)
    const response = await provider.queryPayment(payment)
    for (const callback of response.callbacks || []) {
      await this.service.applyProviderResult(this.providerName, callback)
    }
    if (response.reconciliation) {
      await this.service.applyReconciliation(payment.id, response.reconciliation)
    }
    await this.markReconciledIfTerminal(payment.id)
    // R3：正常完成（含 pending/USERPAYING/歧义结果）→ 按所有者身份立即释放租约，
    // 真实节奏交给 nextActionAt；进程崩溃时租约保持到过期。
    await this.releaseLease(payment.id)
  }

  /** 最后查询仍不明确或超过撤销时限 → 撤销。 */
  async reconcileReverse(payment, now) {
    const claimed = await this.service.prisma.payment.updateMany({
      where: {
        AND: [
          { id: payment.id },
          { reconciliationRequired: true },
          { OR: [{ status: 'pending' }, { status: 'created' }] },
          { OR: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { lt: now } }] },
          { OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] },
        ],
      },
      data: {
        status: 'pending',
        reconcileLeaseOwner: this.instanceId,
        reconcileLeaseUntil: new Date(now.getTime() + this.leaseMs),
      },
    })
    if (claimed.count !== 1) return
    const provider = this.service.provider(this.providerName)
    const response = await provider.closePayment(payment)
    for (const callback of response.callbacks || []) {
      await this.service.applyProviderResult(this.providerName, callback)
    }
    if (response.reconciliation) {
      await this.service.applyReconciliation(payment.id, response.reconciliation)
    }
    const result = await this.service.result(payment.id)
    if (['success', 'failed', 'closed', 'timeout'].includes(result.payment.status)) {
      await this.markReconciledIfTerminal(payment.id)
    } else {
      this.alarm(`支付 ${payment.paymentNo} 撤销后状态仍不明确（${result.payment.status}），禁止二次支付，需要人工核对`)
      await this.service.prisma.payment.update({
        where: { id: payment.id },
        data: { nextActionAt: new Date(now.getTime() + 30 * 1000) },
      })
    }
    // R3：正常完成（含 recall=Y 重试排期/歧义结果）→ 按所有者身份立即释放租约
    await this.releaseLease(payment.id)
  }

  /**
   * R3：按「所有者身份」条件释放租约。
   * 只清空本实例持有的租约；绝不清除已被其他 worker 合法认领的租约。
   * （进程崩溃时不会走到这里，租约自然保持到过期由其他实例回收。）
   */
  async releaseLease(paymentId) {
    await this.service.prisma.payment.updateMany({
      where: { id: paymentId, reconcileLeaseOwner: this.instanceId },
      data: { reconcileLeaseOwner: '', reconcileLeaseUntil: null },
    })
  }

  async markReconciledIfTerminal(paymentId) {
    const current = await this.service.prisma.payment.findUnique({ where: { id: paymentId } })
    if (!current) return
    if (['success', 'failed', 'closed', 'timeout'].includes(current.status)) {
      await this.service.prisma.payment.update({
        where: { id: paymentId },
        data: {
          reconciliationRequired: false,
          reconciledAt: this.now(),
          providerStatus: current.status,
          // 租约一律交给 releaseLease()（按所有者身份）清理，此处不触碰
        },
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
