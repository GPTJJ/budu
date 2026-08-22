// 未决微信支付自动核对器单元测试（假 Provider + 内存存储，不连接外部）
import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentReconciler } from '../server/payments/payment-reconciler.js'

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
    requestedAt: new Date(),
    ...overrides,
  }
}

class MemoryStore {
  constructor(payments = []) {
    this.payments = payments
    // 模拟 prisma.payment.* 命名空间
    this.payment = {
      findMany: (args) => this.findMany(args),
      updateMany: (args) => this.updateMany(args),
      update: (args) => this.update(args),
      findUnique: (args) => this.findUnique(args),
    }
  }

  async findMany({ where, take }) {
    let rows = this.payments.filter((row) => {
      if (row.provider !== where.provider) return false
      if (row.status !== where.status) return false
      if (row.reconciliationRequired !== where.reconciliationRequired) return false
      const next = where.OR.find((part) => {
        if (part.nextActionAt === null) return row.nextActionAt === null
        if (part.nextActionAt && part.nextActionAt.lte) return row.nextActionAt === null || row.nextActionAt <= part.nextActionAt.lte
        return false
      })
      return Boolean(next)
    })
    if (take) rows = rows.slice(0, take)
    return rows
  }

  async updateMany({ where, data }) {
    const rows = this.payments.filter((row) =>
      Object.entries(where).every(([key, expected]) => {
        if (key === 'queryAttempts') return row.queryAttempts === expected
        if (key === 'reconciliationRequired') return row.reconciliationRequired === expected
        if (key === 'status') return row.status === expected
        return row[key] === expected
      }),
    )
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
  const events = []
  return {
    prisma: store,
    events,
    provider(name) {
      assert.equal(name, 'wechat_pay')
      return fakeProvider
    },
    async handleCallback(providerName, callback) {
      events.push(callback)
      // 模拟状态机：success 事件直接落库
      const row = store.payments.find((item) => item.merchantTradeNo === callback.merchantTradeNo)
      if (row && callback.status === 'success') row.status = 'success'
      if (row && callback.status === 'closed') row.status = 'closed'
      if (row && callback.status === 'failed') row.status = 'failed'
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

function fakeProviderWith(handler) {
  return {
    async queryPayment(payment) {
      return handler(payment, 'query')
    },
    async closePayment(payment) {
      return handler(payment, 'close')
    },
  }
}

test('核对器：认领后查询，SUCCESS 后结束核对并标记 reconciled', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p, kind) => ({
    callbacks: [{ status: 'success', merchantTradeNo: p.merchantTradeNo, providerTradeNo: 'WX-OK' }],
  }))
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, intervalMs: 50 })
  await reconciler.tick()
  assert.equal(payment.status, 'success')
  assert.equal(payment.reconciliationRequired, false)
  assert.ok(payment.reconciledAt)
  assert.equal(payment.queryAttempts, 1)
  reconciler.stop()
})

test('核对器：USERPAYING 持续查询，达到上限后撤销并结束', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p, kind) => {
    if (kind === 'close') return { callbacks: [{ status: 'closed', merchantTradeNo: p.merchantTradeNo }] }
    return {
      callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }],
      reconciliation: { providerStatus: 'USERPAYING', reconciliationRequired: true },
    }
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, intervalMs: 50, maxQueries: 3, reverseAfterMs: 5000 })
  // 模拟时间推进：lastQueriedAt 置为过去以触发 reverse 分支
  payment.lastQueriedAt = new Date(Date.now() - 60000)
  payment.queryAttempts = 3
  await reconciler.tick()
  assert.equal(payment.status, 'closed')
  assert.equal(payment.reconciliationRequired, false)
  reconciler.stop()
})

test('核对器：撤销后仍不明确 → 告警并继续阻止二次支付（保持 pending + 核对）', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith(() => ({
    callbacks: [{ status: 'pending', merchantTradeNo: payment.merchantTradeNo }],
    reconciliation: { providerStatus: 'REVERSE_FAIL', reconciliationRequired: true },
  }))
  const alarms = []
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, intervalMs: 50, maxQueries: 1, reverseAfterMs: 1000, alarm: (msg) => alarms.push(msg) })
  payment.lastQueriedAt = new Date(Date.now() - 60000)
  payment.queryAttempts = 1
  await reconciler.tick()
  assert.equal(payment.status, 'pending')
  assert.equal(payment.reconciliationRequired, true)
  assert.ok(alarms.length >= 1)
  assert.ok(payment.nextActionAt > new Date())
  reconciler.stop()
})

test('核对器：条件更新保证同一支付只有一个执行者（并发认领）', async () => {
  const payment = makePayment()
  const store = new MemoryStore([payment])
  let queryCalls = 0
  const provider = fakeProviderWith(async (p) => {
    queryCalls += 1
    return { callbacks: [{ status: 'pending', merchantTradeNo: p.merchantTradeNo }] }
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, intervalMs: 50 })
  // 模拟两个执行者同时 tick：第二次因 queryAttempts 不匹配而放弃认领
  const first = reconciler.tick()
  const second = reconciler.tick()
  await Promise.all([first, second])
  assert.equal(payment.queryAttempts, 1, '并发下只允许一次查询')
  assert.equal(queryCalls, 1)
  reconciler.stop()
})

test('核对器：重启恢复——pending + reconciliationRequired 的支付被重新认领', async () => {
  const payment = makePayment({ status: 'pending', reconciliationRequired: true, queryAttempts: 2, lastQueriedAt: new Date(Date.now() - 60000), nextActionAt: null })
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith((p) => ({
    callbacks: [{ status: 'success', merchantTradeNo: p.merchantTradeNo }],
  }))
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, intervalMs: 50 })
  await reconciler.tick()
  assert.equal(payment.status, 'success')
  assert.equal(payment.reconciliationRequired, false)
  reconciler.stop()
})

test('核对器：已终态支付不进入核对队列', async () => {
  const payment = makePayment({ status: 'success', reconciliationRequired: false })
  const store = new MemoryStore([payment])
  const provider = fakeProviderWith(() => {
    throw new Error('不应被调用')
  })
  const service = makeService(store, provider)
  const reconciler = new PaymentReconciler({ service, intervalMs: 50 })
  await reconciler.tick()
  assert.equal(payment.status, 'success')
  reconciler.stop()
})
