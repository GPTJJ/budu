import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const projections = Object.freeze({
  Order: `
    SELECT "id", "order_no", "store_id", "cashier_id", "cashier_name_snapshot", "subtotal",
           "discount_amount", "payable_amount", "business_date", "discount_percent", "remark", "status",
           "payment_status", "payment_method", "payment_mode", "checkout_key", "cart_hash", "version",
           "created_at", "updated_at", "completed_at", "cancelled_at", "cancelled_by", "cancel_reason"
    FROM "orders" ORDER BY "id"
  `,
  OrderItem: 'SELECT * FROM "order_items" ORDER BY "id"',
  Payment: 'SELECT * FROM "payments" ORDER BY "id"',
  Refund: `
    SELECT "id", "refund_no", "order_id", "payment_id", "refund_amount", "reason", "status",
           "provider_refund_no", "request_key", "requested_by", "approved_by", "created_at", "completed_at"
    FROM "refunds" ORDER BY "id"
  `,
  RefundItem: 'SELECT * FROM "refund_items" ORDER BY "id"',
  TransferRequest: 'SELECT * FROM "TransferRequest" ORDER BY "id"',
  TransferItem: 'SELECT * FROM "TransferItem" ORDER BY "id"',
  DailyEntry: 'SELECT * FROM "DailyEntry" ORDER BY "id"',
  DailyStoreStaff: 'SELECT * FROM "daily_store_staff" ORDER BY "id"',
  PayrollNotice: 'SELECT * FROM "payroll_notices" ORDER BY "id"',
})

const stableJson = (value) => JSON.stringify(value, (_key, item) => {
  if (typeof item === 'bigint') return item.toString()
  if (Buffer.isBuffer(item)) return item.toString('base64')
  return item
})

try {
  const result = {}
  for (const [authority, sql] of Object.entries(projections)) {
    const rows = await prisma.$queryRawUnsafe(sql)
    result[authority] = {
      count: rows.length,
      digest: crypto.createHash('sha256').update(stableJson(rows)).digest('hex'),
    }
  }
  const combinedDigest = crypto.createHash('sha256').update(stableJson(result)).digest('hex')
  process.stdout.write(JSON.stringify({ combinedDigest, authorities: result }))
} finally {
  await prisma.$disconnect()
}
