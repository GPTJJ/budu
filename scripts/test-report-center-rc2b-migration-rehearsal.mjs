import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const schemaName = `report_center_rc2b_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migration58 = '20260830130000_report_center_order_source_external_settlement'
const migration59 = '20260830170000_report_center_unified_refund_authority'
const sha = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex')

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
    timeout: 180000,
  })
}

test('RC-2B migration rehearsal preserves legacy facts across 57→58→59', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc2b-migration-'))
  const tempMigrations = path.join(temp, 'migrations')
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(tempMigrations)
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
      if ([migration58, migration59].includes(entry)) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry), path.join(tempMigrations, entry), { recursive: true })
    }
    migrate(path.join(temp, 'schema.prisma'))
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'))[0].count), 57)

    await client.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name") VALUES ('legacy-store', '历史门店')`)
    await client.$executeRawUnsafe(`
      INSERT INTO "InventoryItem" ("id", "name", "category", "sku", "salePriceCents", "costPriceCents", "isActive")
      VALUES ('legacy-product', '历史商品', 'product', 'LEGACY-RC2B', 10000, 4321, true)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "orders" (
        "id", "order_no", "store_id", "cashier_id", "cashier_name_snapshot", "subtotal", "discount_amount",
        "payable_amount", "business_date", "discount_percent", "status", "payment_status", "payment_method",
        "payment_mode", "checkout_key", "cart_hash", "completed_at"
      ) VALUES ('legacy-order', 'POS-LEGACY-RC2B', 'legacy-store', 'legacy-user', '历史员工', 10000, 0,
        10000, DATE '2026-08-20', 100, 'refunded', 'refunded', 'cash', 'cash',
        'legacy-checkout-rc2b', 'legacy-cart-rc2b', TIMESTAMP '2026-08-20 10:00:00')
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "order_items" (
        "id", "order_id", "product_id", "product_name_snapshot", "sku_snapshot", "unit_snapshot",
        "unit_price", "cost_price_snapshot", "quantity", "line_amount", "discount_amount", "actual_amount", "is_gift"
      ) VALUES ('legacy-item', 'legacy-order', 'legacy-product', '历史商品', 'LEGACY-RC2B', '件', 10000, 4321, 1, 10000, 0, 10000, false)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "payments" (
        "id", "payment_no", "order_id", "channel", "payment_method", "amount", "currency", "status",
        "merchant_trade_no", "provider_trade_no", "provider", "request_key", "paid_at"
      ) VALUES ('legacy-payment', 'PAY-LEGACY-RC2B', 'legacy-order', 'cash', 'cashier-confirm', 10000, 'CNY', 'refunded',
        'MT-LEGACY-RC2B', 'PT-LEGACY-RC2B', 'cash', 'legacy-payment-request', TIMESTAMP '2026-08-20 10:00:00')
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "refunds" (
        "id", "refund_no", "order_id", "payment_id", "refund_amount", "reason", "status", "provider_refund_no",
        "request_key", "requested_by", "approved_by", "created_at", "completed_at"
      ) VALUES ('legacy-refund', 'RF-LEGACY-RC2B', 'legacy-order', 'legacy-payment', 10000, '历史退款', 'completed',
        'PR-LEGACY-RC2B', 'legacy-refund-request', 'legacy-user', 'legacy-user',
        TIMESTAMP '2026-08-25 10:00:00', TIMESTAMP '2026-08-25 10:00:00')
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "refund_items" ("id", "refund_id", "order_item_id", "quantity", "amount_cents", "created_at")
      VALUES ('legacy-refund-item', 'legacy-refund', 'legacy-item', 1, 10000, TIMESTAMP '2026-08-25 10:00:00')
    `)

    const projections = {
      orders: `SELECT "id", "order_no", "store_id", "cashier_id", "cashier_name_snapshot", "subtotal", "discount_amount",
        "payable_amount", "business_date", "discount_percent", "remark", "status", "payment_status", "payment_method",
        "payment_mode", "checkout_key", "cart_hash", "version", "created_at", "updated_at", "completed_at", "cancelled_at",
        "cancelled_by", "cancel_reason" FROM "orders" ORDER BY "id"`,
      items: 'SELECT * FROM "order_items" ORDER BY "id"',
      payments: 'SELECT * FROM "payments" ORDER BY "id"',
      refunds: `SELECT "id", "refund_no", "order_id", "payment_id", "refund_amount", "reason", "status", "provider_refund_no",
        "request_key", "requested_by", "approved_by", "created_at", "completed_at" FROM "refunds" ORDER BY "id"`,
      refundItems: 'SELECT * FROM "refund_items" ORDER BY "id"',
    }
    const digest = async () => Object.fromEntries(await Promise.all(Object.entries(projections).map(async ([key, sql]) => [key, sha(await client.$queryRawUnsafe(sql))])))
    const before = await digest()
    const duplicates = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM (
      SELECT "refund_id", "order_item_id" FROM "refund_items" GROUP BY 1, 2 HAVING COUNT(*) > 1
    ) duplicate`)
    assert.equal(Number(duplicates[0].count), 0)

    fs.cpSync(path.join(root, 'prisma', 'migrations', migration58), path.join(tempMigrations, migration58), { recursive: true })
    migrate(path.join(temp, 'schema.prisma'))
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'))[0].count), 58)
    assert.deepEqual(await digest(), before)

    fs.cpSync(path.join(root, 'prisma', 'migrations', migration59), path.join(tempMigrations, migration59), { recursive: true })
    migrate(path.join(temp, 'schema.prisma'))
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'))[0].count), 59)
    assert.deepEqual(await digest(), before)

    const backfill = await client.$queryRawUnsafe(`
      SELECT "refund_mode"::text AS mode, "payment_id", "external_settlement_id", "external_completed_at", "external_refund_reference"
      FROM "refunds" WHERE "id" = 'legacy-refund'
    `)
    assert.deepEqual(backfill, [{
      mode: 'PAYMENT', payment_id: 'legacy-payment', external_settlement_id: null,
      external_completed_at: null, external_refund_reference: null,
    }])
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "external_settlements"'))[0].count), 0)
    assert.equal(Number((await client.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema = $1
        AND ((table_name = 'InventoryItem' AND column_name IN ('transferBoxEnabled','transferBoxWeightGrams','transferPieceEnabled','transferPieceWeightGrams'))
          OR (table_name = 'TransferItem' AND column_name IN ('quantityUnit','unitWeightGramsSnapshot')))
    `, schemaName))[0].count), 6)
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
