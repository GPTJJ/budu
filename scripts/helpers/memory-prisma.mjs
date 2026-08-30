// 测试共享：内存版 prisma（支付域子集），供支付/微信支付/对账测试复用。
export function matches(row, where = {}) {
  if (where.AND) return where.AND.every((part) => matches(row, part))
  if (where.OR) return where.OR.some((part) => matches(row, part))
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('in' in expected) return expected.in.includes(actual)
      if ('notIn' in expected) return !expected.notIn.includes(actual)
      if ('not' in expected) return actual !== expected.not
      if ('lt' in expected) return actual === null || actual < expected.lt
      if ('lte' in expected) return actual === null || actual <= expected.lte
    }
    return actual === expected
  })
}

export function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment
    else row[key] = value
  }
  row.updatedAt = new Date()
  return row
}

export class MemoryPrisma {
  constructor() {
    this.orders = [{
      id: 'order-1', orderNo: 'POS-1', storeId: 'store-1', cashierId: 'user-1', cashierNameSnapshot: '员工1',
      subtotal: 7200n, discountAmount: 0n, payableAmount: 7200n, status: 'pending_payment', paymentStatus: 'unpaid',
      paymentMethod: null, paymentMode: 'mock', checkoutKey: 'checkout-1', cartHash: 'hash', version: 1,
      orderSource: 'STORE_POS', entryMode: 'POS_CHECKOUT', settlementAuthority: 'PAYMENT', sourceOrderRef: null,
      createdAt: new Date(), updatedAt: new Date(), completedAt: null,
    }]
    this.payments = []
    this.paymentLogs = []
    this.refunds = []
    this.refundItems = []
    this.payment = {
      findUnique: async ({ where, include }) => {
        const row = this.payments.find((item) => matches(item, where))
        if (!row) return null
        return include?.order ? { ...row, order: this.orders.find((order) => order.id === row.orderId) } : row
      },
      findFirst: async ({ where }) => this.payments.find((item) => matches(item, where)) || null,
      findMany: async ({ where, orderBy, take }) => {
        let rows = this.payments.filter((item) => matches(item, where))
        if (orderBy?.requestedAt === 'asc') rows = [...rows].sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt))
        if (take) rows = rows.slice(0, take)
        return rows
      },
      count: async ({ where } = {}) => this.payments.filter((item) => matches(item, where)).length,
      create: async ({ data }) => {
        const duplicate = this.payments.some((item) => item.requestKey === data.requestKey || item.paymentNo === data.paymentNo || item.merchantTradeNo === data.merchantTradeNo)
        const active = this.payments.some((item) => item.orderId === data.orderId && ['created', 'pending', 'success'].includes(item.status))
        if (duplicate || active) { const error = new Error('unique'); error.code = 'P2002'; throw error }
        const row = {
          providerTradeNo: null, failureCode: '', failureMessage: '', providerMetadata: {}, callbackCount: 0,
          lastCallbackId: '', lastCallbackAt: null, requestedAt: new Date(), paidAt: null, failedAt: null, closedAt: null,
          providerStatus: '', queryAttempts: 0, lastQueriedAt: null, nextActionAt: null,
          reconciliationRequired: false, reconciledAt: null,
          networkAttemptStartedAt: null, reconcileLeaseOwner: '', reconcileLeaseUntil: null,
          createdAt: new Date(), updatedAt: new Date(), ...data,
        }
        this.payments.push(row)
        return row
      },
      update: async ({ where, data }) => applyData(this.payments.find((item) => matches(item, where)), data),
      updateMany: async ({ where, data }) => {
        const rows = this.payments.filter((item) => matches(item, where))
        rows.forEach((row) => applyData(row, data))
        return { count: rows.length }
      },
    }
    this.paymentLog = {
      create: async ({ data }) => {
        this.paymentLogs.push(data)
        return data
      },
    }
    this.externalSettlements = []
    this.externalSettlement = {
      count: async ({ where } = {}) => this.externalSettlements.filter((item) => matches(item, where)).length,
      findUnique: async ({ where, include }) => {
        const row = this.externalSettlements.find((item) => matches(item, where))
        if (!row) return null
        return include?.order ? { ...row, order: this.orders.find((order) => order.id === row.orderId) } : row
      },
    }
    this.refund = {
      findUnique: async ({ where, include }) => {
        const row = this.refunds.find((item) => matches(item, where))
        if (!row) return null
        const items = include?.items
          ? this.refundItems.filter((item) => item.refundId === row.id).map((item) => {
            const orderItem = this.orders.flatMap((order) => order.items || []).find((oi) => oi.id === item.orderItemId)
            return include?.items?.include?.orderItem ? { ...item, orderItem: orderItem || null } : item
          })
          : undefined
        return { ...row, ...(items ? { items } : {}) }
      },
      create: async ({ data, include }) => {
        const duplicate = this.refunds.some((item) => item.requestKey === data.requestKey
          || item.refundNo === data.refundNo
          || (item.orderId === data.orderId && item.status === 'pending' && data.status === 'pending'))
        if (duplicate) { const error = new Error('unique'); error.code = 'P2002'; throw error }
        const row = { providerRefundNo: null, createdAt: new Date(), completedAt: null, ...data }
        const nested = row.items
        delete row.items
        this.refunds.push(row)
        for (const item of nested?.create || []) this.refundItems.push({ ...item, refundId: row.id })
        const items = include?.items ? this.refundItems.filter((item) => item.refundId === row.id) : undefined
        return { ...row, ...(items ? { items } : {}) }
      },
      findMany: async ({ where, orderBy, take }) => {
        let rows = this.refunds.filter((item) => {
          if (where?.payment?.provider) {
            const payment = this.payments.find((candidate) => candidate.id === item.paymentId)
            if (payment?.provider !== where.payment.provider) return false
          }
          const plainWhere = { ...(where || {}) }
          delete plainWhere.payment
          return matches(item, plainWhere)
        })
        if (orderBy?.createdAt === 'asc') rows = [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        if (take) rows = rows.slice(0, take)
        return rows
      },
      update: async ({ where, data }) => applyData(this.refunds.find((item) => matches(item, where)), data),
      updateMany: async ({ where, data }) => {
        const rows = this.refunds.filter((item) => matches(item, where))
        rows.forEach((row) => applyData(row, data))
        return { count: rows.length }
      },
    }
    this.order = {
      findUnique: async ({ where, include }) => {
        const row = this.orders.find((item) => matches(item, where))
        if (!row) return null
        return include ? {
          ...row,
          store: { key: row.storeId, name: '测试门店' },
          items: row.items || [],
          payments: [...this.payments].filter((payment) => payment.orderId === row.id).reverse(),
          externalSettlement: this.externalSettlements.find((settlement) => settlement.orderId === row.id) || null,
          refunds: this.refunds.filter((refund) => refund.orderId === row.id).map((refund) => ({
            ...refund,
            items: this.refundItems.filter((item) => item.refundId === refund.id),
          })),
        } : row
      },
      updateMany: async ({ where, data }) => {
        const rows = this.orders.filter((item) => matches(item, where))
        rows.forEach((row) => applyData(row, data))
        return { count: rows.length }
      },
    }
  }

  async $transaction(handler) { return handler(this) }
}
