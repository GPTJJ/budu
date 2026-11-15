/**
 * 历史订单同步：CloudBase `orders` → OS `online_order_archive`。
 *
 * 幂等（按 pay_no upsert），可被三处复用：
 * 1. 管理台「历史订单」页面打开时自动同步 + 「同步最新」按钮；
 * 2. 容器内 CLI（scripts/import-mp-orders.mjs）；
 * 3. 服务器 crontab 每日兜底。
 */
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { getCloudBaseClient } from './online-catalog-media.js'

function toDate(value) {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/** 拉取全部订单文档（分页 100，最多 2 万条防御） */
async function scanOrders(db) {
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
  return docs
}

export function mapOrderDoc(doc) {
  const amount = doc.amountCent && typeof doc.amountCent === 'object' ? doc.amountCent : {}
  const recipient = doc.recipient && typeof doc.recipient === 'object' ? doc.recipient : {}
  const refund = doc.refund && typeof doc.refund === 'object' ? doc.refund : {}
  const totalCents = toInt(amount.totalCent ?? toInt(doc.total) * 100)
  return {
    orderNo: String(doc.orderNo || ''),
    status: String(doc.status || 'UNKNOWN'),
    deliveryType: String(doc.deliveryType || ''),
    storeName: String(doc.storeName || ''),
    goodsCents: BigInt(toInt(amount.goodsCent ?? toInt(doc.goodsTotal) * 100)),
    shippingCents: BigInt(toInt(amount.shippingFeeCent ?? toInt(doc.shippingFee) * 100)),
    totalCents: BigInt(totalCents),
    paidCents: BigInt(toInt(doc.paidAmountCent ?? (doc.paidAt ? totalCents : 0))),
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
    raw: doc,
  }
}

export async function syncOrderArchive({ client = null } = {}) {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const app = client || await getCloudBaseClient()
  if (!app) throw httpError('CloudBase 未配置，无法同步历史订单', 503)
  const db = typeof app.database === 'function' ? app.database() : app

  const docs = await scanOrders(db)
  const existingRows = await prisma.onlineOrderArchive.findMany({
    select: { payNo: true, status: true, paidCents: true, shippedAt: true, receivedAt: true, cancelledAt: true, trackingNo: true },
  })
  const known = new Map(existingRows.map((row) => [row.payNo, row]))

  let created = 0
  let updated = 0
  let unchanged = 0
  let skipped = 0

  for (const doc of docs) {
    const payNo = String(doc.payNo || doc._id || '').trim()
    const createdAt = toDate(doc.createdAt)
    if (!payNo || !createdAt) { skipped += 1; continue }

    const payload = { ...mapOrderDoc(doc), createdAt, importedAt: new Date() }
    const existing = known.get(payNo)
    if (!existing) {
      await prisma.onlineOrderArchive.create({ data: { id: String(doc._id || `mp-${payNo}`), payNo, ...payload } })
      created += 1
      continue
    }
    // 只写真正变化的行：页面每次打开都会同步，避免无谓的全量写库
    const same = existing.status === payload.status
      && existing.paidCents === payload.paidCents
      && String(existing.shippedAt || '') === String(payload.shippedAt || '')
      && String(existing.receivedAt || '') === String(payload.receivedAt || '')
      && String(existing.cancelledAt || '') === String(payload.cancelledAt || '')
      && existing.trackingNo === payload.trackingNo
    if (same) { unchanged += 1; continue }
    await prisma.onlineOrderArchive.update({ where: { payNo }, data: payload })
    updated += 1
  }

  const total = await prisma.onlineOrderArchive.count()
  return { scanned: docs.length, created, updated, unchanged, skipped, total, syncedAt: new Date().toISOString() }
}
