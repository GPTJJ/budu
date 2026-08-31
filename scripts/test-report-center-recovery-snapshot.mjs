import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  const ledger = await prisma.$queryRawUnsafe(`
    SELECT "migration_name", "finished_at", "rolled_back_at"
    FROM "_prisma_migrations"
    ORDER BY "started_at"
  `)
  assert.equal(ledger.length, 60)
  assert.equal(ledger.every((row) => row.finished_at && !row.rolled_back_at), true)
  assert.deepEqual(ledger.slice(-3).map((row) => row.migration_name), [
    '20260830130000_transfer_actual_shipment',
    '20260831190000_report_center_order_source_external_settlement',
    '20260831193000_report_center_unified_refund_authority',
  ])

  const [orders, invalidOrderDimensions, externalSettlements, refunds, invalidRefundBackfill] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "orders"'),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "orders"
      WHERE "order_source" <> 'STORE_POS'
         OR "entry_mode" <> 'POS_CHECKOUT'
         OR "settlement_authority" <> 'PAYMENT'
         OR "source_order_ref" IS NOT NULL
    `),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "external_settlements"'),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "refunds"'),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM "refunds"
      WHERE "refund_mode" <> 'PAYMENT'
         OR "payment_id" IS NULL
         OR "external_settlement_id" IS NOT NULL
         OR "external_completed_at" IS NOT NULL
         OR "external_refund_reference" IS NOT NULL
    `),
  ])
  assert.equal(Number(invalidOrderDimensions[0].count), 0)
  assert.equal(Number(externalSettlements[0].count), 0)
  assert.equal(Number(invalidRefundBackfill[0].count), 0)

  const transferColumns = await prisma.$queryRawUnsafe(`
    SELECT "column_name" FROM information_schema.columns
    WHERE "table_schema" = 'public'
      AND "table_name" = 'TransferItem'
      AND "column_name" = 'shippedQuantity'
  `)
  assert.equal(transferColumns.length, 1)

  process.stdout.write(JSON.stringify({
    migrations: ledger.length,
    orders: Number(orders[0].count),
    invalidOrderDimensions: Number(invalidOrderDimensions[0].count),
    externalSettlements: Number(externalSettlements[0].count),
    refunds: Number(refunds[0].count),
    invalidRefundBackfill: Number(invalidRefundBackfill[0].count),
    transferMigration58Preserved: true,
  }))
} finally {
  await prisma.$disconnect()
}
