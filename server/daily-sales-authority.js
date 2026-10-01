import { prisma } from './pg.js'
import { buildRecognizedRevenueWhere, httpError } from './pos-core.js'

function dateOnly(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError('日期格式应为 YYYY-MM-DD')
  return new Date(`${text}T00:00:00.000Z`)
}

function isoDate(value) {
  if (!value) return ''
  return new Date(value).toISOString().slice(0, 10)
}

export function effectiveSource(store, dateStr) {
  if (store.salesDataSource === 'manual') return 'manual'
  const eff = store.salesDataSourceEffectiveDate ? isoDate(store.salesDataSourceEffectiveDate) : ''
  if (eff && dateStr < eff) return 'manual'
  return store.salesDataSource
}

export async function aggregatePosDay(storeId, dateStr, prismaClient = prisma) {
  const businessDate = dateOnly(dateStr)
  const [orders, refunds] = await Promise.all([
    prismaClient.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId, businessDate }),
      include: { payments: true },
    }),
    prismaClient.refund.findMany({
      where: { status: 'completed', order: { is: { storeId, businessDate } } },
      select: { refundAmount: true },
    }),
  ])
  let originalSales = 0n
  let effectiveSales = 0n
  const refundAmount = refunds.reduce((sum, refund) => sum + refund.refundAmount, 0n)
  let discountAmount = 0n
  let orderCount = 0
  const byChannel = { wechat: 0n, alipay: 0n, cash: 0n, other: 0n }
  for (const order of orders) {
    originalSales += order.subtotal
    discountAmount += order.discountAmount
    effectiveSales += order.payableAmount
    orderCount += 1
    for (const pay of order.payments || []) {
      if (pay.status === 'success') {
        const key = ['wechat', 'alipay', 'cash'].includes(pay.channel) ? pay.channel : 'other'
        byChannel[key] += pay.amount
      }
    }
  }
  // 已退款订单已整体排除，不能再次从干净订单营收中扣减。
  const effectiveAfterRefund = effectiveSales
  const toStr = (value) => value.toString()
  return {
    status: 'synced',
    syncedAt: new Date().toISOString(),
    originalSales: toStr(originalSales),
    effectiveSales: toStr(effectiveSales),
    effectiveAfterRefund: toStr(effectiveAfterRefund),
    refundAmount: toStr(refundAmount),
    discountAmount: toStr(discountAmount),
    orderCount,
    avgOrderCents: toStr(orderCount > 0 ? effectiveAfterRefund / BigInt(orderCount) : 0n),
    byChannel: Object.fromEntries(Object.entries(byChannel).map(([key, value]) => [key, toStr(value)])),
  }
}

export async function aggregatePosPeriod(storeId, start, end, prismaClient = prisma) {
  const [orders, refunds] = await Promise.all([
    prismaClient.order.findMany({
      where: buildRecognizedRevenueWhere({ storeId, businessDate: { gte: start, lt: end } }),
      select: { businessDate: true, subtotal: true, payableAmount: true, discountAmount: true },
    }),
    prismaClient.refund.findMany({
      where: { status: 'completed', order: { is: { storeId, businessDate: { gte: start, lt: end } } } },
      select: { refundAmount: true, order: { select: { businessDate: true } } },
    }),
  ])
  const groups = new Map()
  const ensure = (dateStr) => {
    const current = groups.get(dateStr) || { originalSales: 0n, effectiveSales: 0n, discountAmount: 0n, refundAmount: 0n, orderCount: 0 }
    groups.set(dateStr, current)
    return current
  }
  for (const order of orders) {
    const group = ensure(isoDate(order.businessDate))
    group.originalSales += order.subtotal
    group.effectiveSales += order.payableAmount
    group.discountAmount += order.discountAmount
    group.orderCount += 1
  }
  for (const refund of refunds) ensure(isoDate(refund.order.businessDate)).refundAmount += refund.refundAmount
  return groups
}

// One read projection for POS/manual/hybrid DailyEntry revenue. Never persist it.
export async function resolveDailyEntrySalesRows(client, entries, stores) {
  if (entries.length === 0) return []
  const directory = stores || await client.store.findMany({
    where: { key: { in: [...new Set(entries.map((row) => row.storeKey))] } },
    select: { key: true, salesDataSource: true, salesDataSourceEffectiveDate: true },
  })
  const storeByKey = new Map(directory.map((store) => [store.key, store]))
  const ranges = new Map()
  for (const entry of entries) {
    const store = storeByKey.get(entry.storeKey)
    if (!store || !['manual', 'pos', 'hybrid'].includes(store.salesDataSource)) {
      throw new Error(`Daily sales authority missing for store ${entry.storeKey}`)
    }
    const source = entry.salesDataStatus === 'corrected' ? 'manual' : effectiveSource(store, isoDate(entry.date))
    if (source === 'manual') continue
    const range = ranges.get(entry.storeKey) || { start: entry.date, end: entry.date }
    if (entry.date < range.start) range.start = entry.date
    if (entry.date > range.end) range.end = entry.date
    ranges.set(entry.storeKey, range)
  }
  const groups = new Map(await Promise.all([...ranges].map(async ([storeKey, range]) => {
    const end = new Date(range.end)
    end.setUTCDate(end.getUTCDate() + 1)
    return [storeKey, await aggregatePosPeriod(storeKey, range.start, end, client)]
  })))
  return entries.map((entry) => {
    const source = entry.salesDataStatus === 'corrected' ? 'manual' : effectiveSource(storeByKey.get(entry.storeKey), isoDate(entry.date))
    if (source === 'manual') return entry
    const pos = groups.get(entry.storeKey)?.get(isoDate(entry.date))
    return { ...entry,
      incCents: (pos?.effectiveSales || 0n) + (source === 'hybrid' ? entry.hybridAdjustmentCents || 0n : 0n),
      ord: pos?.orderCount || 0,
    }
  })
}
