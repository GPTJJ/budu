// 未决微信支付自动核对器单元测试（R2：崩溃恢复 + 稳定撤销计时 + 跨进程租约 + nextActionAt 门控）
import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentReconciler, reconcilerEnvConfig } from '../server/payments/payment-reconciler.js'
import { WECHAT_V2_PROVIDER_MAX_OP_MS, WECHAT_V2_MAX_OP_MS } from '../server/payments/wechat-v2-client.js'

function makePayment(overrides = {}) {
  return {
    id: `pay-${Math.random().toString(36).slice(2, 8)}`,
    paymentNo: 'PAYX',
    merchantTradeNo: 'BUDUPAYX',
    provider: 'wechat_pay',
    amount: 7200n,
    status: 'pending',
    providerStatus: '',
    queryAttempts: 0,
    lastQueriedAt: null,
    nextActionAt: null,
    reconciliationRequired: true,
    reconciledAt: null,
    requestedAt: new Date(Date.now() - 60000),
    networkAttemptStartedAt: new Date(Date.now() - 60000),
    reconcileLeaseOwner: '',
    reconcileLeaseUntil: null,
    ...overrides,
  }
}

/** 支持 AND/OR/lt/lte/not 的最小内存存储，暴露 prisma.payment.* 命名空间。 */
class MemoryStore {
  constructor(payments = []) {
    this.payments = payments
    this.payment = {
      findMany: (args) => this.findMany(args),
      updateMany: (args) => this.updateMany(args),
      update: (args) => this.update(args),
      findUnique: (args) => this.findUnique(args),
    }
  }

  match(row, where) {
    if (!where) return true
    if (where.AND) return where.AND.every((part) => this.match(row, part))
    if (where.OR) return where.OR.some((part) => this.match(row, part))
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key]
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if ('in' in expected) return expected.in.includes(actual)
        if ('not' in expected) return actual !== expected.not
        if ('notIn' in expected) return !expected.notIn.includes(actual)
        if ('lt' in expected) return actual === null || actual < expected.lt
        if ('lte' in expected) return actual === null || actual <= expected.lte
      }
      return actual === expected
    })
  }

  async findMany({ where, orderBy, take }) {
    let rows = this.payments.filter((row) => this.match(row, where))
    if (orderBy?.requestedAt === 'asc') rows = [...rows].sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt))
    if (take) rows = rows.slice(0, take)
    return rows
  }

  async updateMany({ where, data }) {
    const rows = this.payments.filter((row) => this.match(row, where))
    for (const row of rows) {
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment
        else row[key] = value
      }
    }
    return { count: rows.length }
  }

  async update({ where, data }) {
    const row = this.payments.find((item) => item.id === where.id)
    if (!row) return null
    for (const [key, value] of Object.entries(data)) row[key] = value
    return row
  }

  async findUnique({ where }) {
    return this.payments.find((item) => item.id === where.id) || null
  }
}

function makeService(store, fakeProvider) {
  return {
    prisma: store,
    provider(name) {
      assert.equal(name, 'wechat_pay')
      return fakeProvider
    },
    async applyProviderResult(providerName, callback) {
      const row = store.payments.find((item) => item.merchantTradeNo === callback.merchantTradeNo)
      if (row && ['success', 'closed', 'failed', 'timeout'].includes(callback.status)) row.status = callback.status
    },
    async applyReconciliation(paymentId, hint) {
      const row = store.payments.find((item) => item.id === paymentId)
      if (!row || !hint) return
      row.providerStatus = String(hint.providerStatus || '')
      row.reconciliationRequired = hint.reconciliationRequired === true
    },
    async result(paymentId) {
      const row = store.payments.find((item) => item.id === paymentId)
      return { payment: row }
    },
  }
}

const fakeProviderWith = (handler) => ({
  async queryPayment(payment) {
    return handler(payment, 'query')
  },
  async closePayment(payment) {
    return handler(payment, 'close')
  },
})

test('核对器：认领后查询，SUCCESS 后结束核对并标记 reconciled，租约被释放', async () => {
  const payment = makePayment({ requestedAt: new Date(Date.now() - 1000) })
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p) => ({
    callbacks: [{ status: 'success', merchantTradeNo: p.merchantTradeNo, providerTradeNo: 'WX-OK' }],
  }))
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, instanceId: 'inst-1', reverseAfterMs: 3600000 })
  await reconciler.tick()
  assert.equal(payment.status, 'success')
  assert.equal(payment.reconciliationRequired, false)
  assert.ok(payment.reconciledAt)
  assert.equal(payment.queryAttempts, 1)
  assert.equal(payment.reconcileLeaseOwner, '')
  assert.equal(payment.reconcileLeaseUntil, null)
  reconciler.stop()
})

test('G：稳定撤销计时——反复查询不推迟撤销期限（以 requestedAt 为基准）', async () => {
  const requestedAt = new Date(Date.now() - 120000) // 2 分钟前发起
  const payment = makePayment({ requestedAt })
  const store = new MemoryStore([payment])
  let queries = 0
  const provider = fakeProviderWith((p, kind) => {
    if (kind === 'close') return { callbacks: [{ status: 'closed', merchantTradeNo: p.merchantTradeNo }] }
    queries += 1
    return {
      callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }],
      reconciliation: { providerStatus: 'USERPAYING', reconciliationRequired: true },
    }
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, reverseAfterMs: 60000, maxQueries: 100, instanceId: 'inst-1' })
  await reconciler.tick()
  assert.equal(queries, 0, '超过稳定撤销时限后不再查询，直接撤销')
  assert.equal(payment.status, 'closed')
  reconciler.stop()
})

test('C：created+networkAttempt 崩溃恢复——重启核对器后由 orderquery 恢复', async () => {
  const payment = makePayment({
    status: 'created',
    queryAttempts: 0,
    lastQueriedAt: null,
    networkAttemptStartedAt: new Date(Date.now() - 30000),
    requestedAt: new Date(Date.now() - 30000),
  })
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p) => ({
    callbacks: [{ status: 'success', merchantTradeNo: p.merchantTradeNo, providerTradeNo: 'WX-RECOVER' }],
  }))
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, instanceId: 'inst-1' })
  await reconciler.tick()
  assert.equal(payment.status, 'success')
  assert.equal(payment.reconciliationRequired, false)
  assert.ok(payment.reconciledAt)
  reconciler.stop()
})

test('C：本地创建但从未发起网络的支付（created 无 networkAttemptStartedAt）绝不盲查', async () => {
  const payment = makePayment({ status: 'created', networkAttemptStartedAt: null, reconciliationRequired: true })
  const store = new MemoryStore([payment])
  let called = 0
  const provider = fakeProviderWith(() => {
    called += 1
    return { callbacks: [{ status: 'pending', merchantTradeNo: 'x' }] }
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service })
  await reconciler.tick()
  assert.equal(called, 0, '从未发起网络请求的支付不得被查询')
  reconciler.stop()
})

test('H：跨进程租约——两个核对器实例对同一支付只有一个执行者', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  let queries = 0
  const provider = fakeProviderWith(async (p) => {
    queries += 1
    return { callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }] }
  })
  const service = makeService(store, provider)
  const reconcilerA = new PaymentReconciler({ service, instanceId: 'inst-A' })
  const reconcilerB = new PaymentReconciler({ service, instanceId: 'inst-B' })
  await Promise.all([reconcilerA.tick(), reconcilerB.tick()])
  assert.equal(queries, 1, '同一租约窗口内只允许一个执行者')
  assert.equal(payment.reconcileLeaseOwner, 'inst-A')
  assert.ok(payment.reconcileLeaseUntil > new Date())
  reconcilerA.stop()
  reconcilerB.stop()
})

test('H：租约过期后其他实例可回收（进程死亡不悬挂）', async () => {
  const payment = makePayment({ reconcileLeaseOwner: 'dead-inst', reconcileLeaseUntil: new Date(Date.now() - 1000) })
  const store = new MemoryStore([payment])
  let queries = 0
  const provider = fakeProviderWith((p) => {
    queries += 1
    return { callbacks: [{ status: 'success', merchantTradeNo: p.merchantTradeNo }] }
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, instanceId: 'inst-new' })
  await reconciler.tick()
  assert.equal(queries, 1, '租约过期后可被新实例认领')
  assert.equal(payment.status, 'success')
  reconciler.stop()
})

test('撤销后仍不明确 → 告警并保持 pending+reconciliationRequired', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p, kind) => {
    if (kind === 'close') {
      return {
        callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }],
        reconciliation: { providerStatus: 'REVERSE_UNKNOWN', reconciliationRequired: true },
      }
    }
    return {
      callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }],
      reconciliation: { providerStatus: 'USERPAYING', reconciliationRequired: true },
    }
  })
  const alarms = []
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({
    service,
    maxQueries: 0,
    reverseAfterMs: 1000,
    now: () => new Date(Date.now() + 120000),
    alarm: (msg) => alarms.push(msg),
  })
  payment.requestedAt = new Date(Date.now() - 120000)
  await reconciler.tick()
  assert.equal(payment.status, 'pending')
  assert.equal(payment.reconciliationRequired, true)
  assert.ok(alarms.length >= 1)
  reconciler.stop()
})

test('M：环境参数生效——非法值回退安全默认，合法值改变行为', () => {
  const valid = reconcilerEnvConfig({
    WECHAT_PAY_QUERY_INTERVAL_MS: '3000',
    WECHAT_PAY_MAX_QUERIES: '20',
    WECHAT_PAY_REVERSE_AFTER_MS: '90000',
    WECHAT_PAY_LEASE_MS: '20000',
  })
  assert.deepEqual(valid, { intervalMs: 3000, maxQueries: 20, reverseAfterMs: 90000, leaseMs: 20000 })
  const bad = reconcilerEnvConfig({
    WECHAT_PAY_QUERY_INTERVAL_MS: '-5',
    WECHAT_PAY_MAX_QUERIES: 'abc',
    WECHAT_PAY_REVERSE_AFTER_MS: '99999999999',
    WECHAT_PAY_LEASE_MS: '0',
  })
  // R2：默认租约必须 ≥ 单次 Provider 调用最坏耗时（closePayment = 3 次 request，
  // 每次含主备域名回退），推导自客户端超时常量，而非拍脑袋的 15s。
  assert.deepEqual(bad, { intervalMs: 5000, maxQueries: 12, reverseAfterMs: 60000, leaseMs: WECHAT_V2_PROVIDER_MAX_OP_MS })
  assert.ok(WECHAT_V2_PROVIDER_MAX_OP_MS > WECHAT_V2_MAX_OP_MS)
})

test('M：租约默认值推导自客户端超时——单次 Provider 调用最坏耗时 ≤ 默认租约', () => {
  // 单次 request() 最坏 = 主备域名 × (连接 5s + 请求 10s)；closePayment 最多 3 次 request
  assert.equal(WECHAT_V2_MAX_OP_MS, 2 * (5000 + 10000))
  assert.equal(WECHAT_V2_PROVIDER_MAX_OP_MS, 3 * WECHAT_V2_MAX_OP_MS)
  const envDefault = reconcilerEnvConfig({}).leaseMs
  assert.ok(envDefault >= WECHAT_V2_PROVIDER_MAX_OP_MS, '默认租约必须覆盖 Provider 调用最坏耗时')
})

test('R2：长调用覆盖——Provider 调用超过旧默认 15s 时租约仍有效，其他实例不得认领', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  let queries = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const provider = fakeProviderWith(async (p) => {
    queries += 1
    if (queries === 1) await gate // 模拟慢请求：挂起远超旧默认 15s 租约
    return { callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }] }
  })
  const service = makeService(store, provider)
  const base = Date.parse('2026-08-22T00:00:00Z')
  let nowMs = base
  const now = () => new Date(nowMs)
  const reconcilerA = new PaymentReconciler({ service, instanceId: 'inst-A', now })
  const reconcilerB = new PaymentReconciler({ service, instanceId: 'inst-B', now })
  const tickA = reconcilerA.tick() // t=0 认领并挂起
  // 等 A 的认领落库（确定性同步点：租约所有者已写入）
  for (let i = 0; i < 100 && payment.reconcileLeaseOwner !== 'inst-A'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(payment.reconcileLeaseOwner, 'inst-A')
  nowMs = base + 20000 // t=20s：已超过旧默认 15s 租约
  await reconcilerB.tick()
  assert.equal(queries, 1, 'A 的调用仍持有有效租约（默认租约 ≥ Provider 最坏耗时），B 不得重复执行')
  assert.equal(payment.reconcileLeaseOwner, 'inst-A')
  release()
  await tickA
  nowMs = base + 100000 // t=100s：租约（90s）已到期，可回收
  await reconcilerB.tick()
  assert.equal(queries, 2, '租约到期后其他实例可回收')
  assert.equal(payment.reconcileLeaseOwner, 'inst-B')
  reconcilerA.stop()
  reconcilerB.stop()
})

test('R2：nextActionAt 门控发现——未到期不进入批次，到期后进入', async () => {
  const now0 = new Date('2026-08-22T00:00:00Z')
  const notDue = makePayment({ id: 'pay-not-due', nextActionAt: new Date(now0.getTime() + 60000) })
  const due = makePayment({ id: 'pay-due', nextActionAt: new Date(now0.getTime() - 1000) })
  const store = new MemoryStore([notDue, due])
  const service = makeService(store, fakeProviderWith(() => ({ callbacks: [] })))
  const reconciler = new PaymentReconciler({ service, instanceId: 'inst-1', now: () => now0 })
  const rows = await reconciler.pendingPayments(now0)
  assert.deepEqual(rows.map((row) => row.id), ['pay-due'], 'nextActionAt 未到期不得被发现')
  reconciler.stop()
})

test('R2：nextActionAt 门控认领——未到期时条件更新不命中，不调用 Provider', async () => {
  const payment = makePayment({ nextActionAt: new Date(Date.now() + 60000) })
  const store = new MemoryStore([payment])
  let called = 0
  const provider = fakeProviderWith(() => {
    called += 1
    return { callbacks: [{ status: 'pending', merchantTradeNo: payment.merchantTradeNo }] }
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, instanceId: 'inst-1' })
  const now = new Date()
  await reconciler.reconcileQuery(payment, now)
  assert.equal(called, 0, 'nextActionAt 未到期不得认领')
  assert.equal(payment.queryAttempts, 0)
  payment.nextActionAt = new Date(now.getTime() - 1000) // 到期
  await reconciler.reconcileQuery(payment, now)
  assert.equal(called, 1, '到期后允许认领')
  assert.equal(payment.queryAttempts, 1)
  reconciler.stop()
})

test('M：配置的对账间隔实际影响 nextActionAt 排期', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p) => ({
    callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }],
    reconciliation: { providerStatus: 'USERPAYING', reconciliationRequired: true },
  }))
  const service = makeService(store, provider)
  const now = new Date('2026-08-22T00:00:00Z')
  const reconciler = new PaymentReconciler({ service, intervalMs: 3000, now: () => now, instanceId: 'inst-1' })
  await reconciler.tick()
  assert.equal(payment.queryAttempts, 1)
  assert.equal(payment.nextActionAt.getTime(), now.getTime() + 3000)
  reconciler.stop()
})
