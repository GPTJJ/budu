/**
 * 导入小程序历史订单：CloudBase `orders` → OS `online_order_archive`。
 *
 * - 只读归档，不写结算表、不影响发货/退款；
 * - 幂等：按 pay_no upsert，可反复执行（补齐新订单或更新状态）；
 * - 容器内：node /app/scripts/import-mp-orders.mjs（生产每天 03:10 由 cron 自动跑）
 */
import { prisma } from '../server/pg.js'

const sdk = (await import('@cloudbase/node-sdk')).default || (await import('@cloudbase/node-sdk'))
const app = sdk.init({ env: process.env.TCB_ENV_ID, secretId: process.env.TCB_SECRET_ID, secretKey: process.env.TCB_SECRET_KEY })
const db = app.database()

function toDate(value) {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const toInt = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

// 分页扫描全部订单
const docs = []
let skip = 0
while (true) {
  const res = await db.collection('orders').orderBy('createdAt', 'asc').skip(skip).limit(100).get()
  const batch = res.data || []
  docs.push(...batch)
  if (batch.length < 100) break
  skip += 100
  if (skip > 20000) break
}
console.log('scanned orders:', docs.length)

let created = 0
let updated = 0
let skipped = 0
const badDates = []

for (const doc of docs) {
  const payNo = String(doc.payNo || doc._id || '').trim()
  if (!payNo) { skipped += 1; continue }
  const createdAt = toDate(doc.createdAt)
  if (!createdAt) { badDates.push(payNo); skipped += 1; continue }

  const amount = doc.amountCent && typeof doc.amountCent === 'object' ? doc.amountCent : {}
  const goodsCents = toInt(amount.goodsCent ?? toInt(doc.goodsTotal) * 100)
  const shippingCents = toInt(amount.shippingFeeCent ?? toInt(doc.shippingFee) * 100)
  const totalCents = toInt(amount.totalCent ?? toInt(doc.total) * 100)
  const paidCents = toInt(doc.paidAmountCent ?? (doc.paidAt ? totalCents : 0))
  const recipient = doc.recipient && typeof doc.recipient === 'object' ? doc.recipient : {}
  const refund = doc.refund && typeof doc.refund === 'object' ? doc.refund : {}

  const payload = {
    orderNo: String(doc.orderNo || ''),
    status: String(doc.status || 'UNKNOWN'),
    deliveryType: String(doc.deliveryType || ''),
    storeName: String(doc.storeName || ''),
    goodsCents: BigInt(goodsCents),
    shippingCents: BigInt(shippingCents),
    totalCents: BigInt(totalCents),
    paidCents: BigInt(paidCents),
    refundCents: BigInt(toInt(refund.refundAmountCent)),
    items: Array.isArray(doc.items) ? doc.items : [],
    recipientName: String(recipient.name || ''),
    recipientPhone: String(recipient.contact || ''),
    recipientAddress: String(recipient.address || ''),
    carrier: String(doc.carrier || ''),
    trackingNo: String(doc.trackingNo || ''),
    transactionId: String(doc.transactionId || ''),
    paidAt: toDate(doc.paidAt),
    shippedAt: toDate(doc.shippedAt),
    receivedAt: toDate(doc.receivedAt),
    cancelledAt: toDate(doc.cancelledAt),
    createdAt,
    raw: doc,
    importedAt: new Date(),
  }

  const existing = await prisma.onlineOrderArchive.findUnique({ where: { payNo }, select: { id: true } })
  if (existing) {
    await prisma.onlineOrderArchive.update({ where: { payNo }, data: payload })
    updated += 1
  } else {
    await prisma.onlineOrderArchive.create({ data: { id: String(doc._id || `mp-${payNo}`), payNo, ...payload } })
    created += 1
  }
}

const byStatus = await prisma.onlineOrderArchive.groupBy({ by: ['status'], _count: { _all: true } })
console.log(JSON.stringify({
  scanned: docs.length, created, updated, skipped, badDates,
  total: byStatus.reduce((n, g) => n + g._count._all, 0),
  byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
}, null, 1))
process.exit(0)
