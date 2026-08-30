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
const schemaName = `report_center_rc2a_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260830130000_report_center_order_source_external_settlement'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
    timeout: 180000,
  })
}

const sha = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex')

test('RC-2A migration 57→58 backfills all live-count-independent legacy orders without rewriting financial facts', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc2a-migration-'))
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(path.join(temp, 'migrations'))
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
      if (entry === migrationName) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry), path.join(temp, 'migrations', entry), { recursive: true })
    }
    migrate(path.join(temp, 'schema.prisma'))
    const beforeLedger = await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    assert.equal(Number(beforeLedger[0].count), 57)

    await client.$executeRawUnsafe(`INSERT INTO "Store" ("key", "name") VALUES ('legacy-store', '历史门店')`)
    await client.$executeRawUnsafe(`
      INSERT INTO "InventoryItem" ("id", "name", "category", "sku", "salePriceCents", "costPriceCents", "isActive")
      VALUES ('legacy-product', '历史商品', 'product', 'LEGACY-SKU', 10000, 4000, true)
    `)
    const orders = [
      ['legacy-wechat', 'POS-LEGACY-WECHAT', 'checkout-legacy-wechat', 'completed', 'paid', 'wechat', 'wechat_pay'],
      ['legacy-cash', 'POS-LEGACY-CASH', 'checkout-legacy-cash', 'completed', 'paid', 'cash', 'cash'],
      ['legacy-refunded', 'POS-LEGACY-REFUNDED', 'checkout-legacy-refunded', 'refunded', 'refunded', 'cash', 'cash'],
    ]
    for (const [id, orderNo, checkoutKey, status, paymentStatus, paymentMethod, paymentMode] of orders) {
      await client.$executeRawUnsafe(`
        INSERT INTO "orders" (
          "id", "order_no", "store_id", "cashier_id", "cashier_name_snapshot",
          "subtotal", "discount_amount", "payable_amount", "business_date", "discount_percent",
          "status", "payment_status", "payment_method", "payment_mode", "checkout_key", "cart_hash", "completed_at"
        ) VALUES ($1, $2, 'legacy-store', 'legacy-user', '历史员工', 10000, 0, 10000, DATE '2026-08-30', 100, $3, $4, $5, $6, $7, 'legacy-cart', CURRENT_TIMESTAMP)
      `, id, orderNo, status, paymentStatus, paymentMethod, paymentMode, checkoutKey)
      await client.$executeRawUnsafe(`
        INSERT INTO "order_items" (
          "id", "order_id", "product_id", "product_name_snapshot", "sku_snapshot", "unit_snapshot",
          "unit_price", "cost_price_snapshot", "quantity", "line_amount", "discount_amount", "actual_amount", "is_gift"
        ) VALUES ($1, $2, 'legacy-product', '历史商品', 'LEGACY-SKU', '件', 10000, 4000, 1, 10000, 0, 10000, false)
      `, `item-${id}`, id)
      await client.$executeRawUnsafe(`
        INSERT INTO "payments" (
          "id", "payment_no", "order_id", "channel", "payment_method", "amount", "currency", "status",
          "merchant_trade_no", "provider_trade_no", "provider", "request_key", "paid_at"
        ) VALUES ($1, $2, $3, $4, 'cashier-confirm', 10000, 'CNY', $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      `,
      `pay-${id}`,
      `PAY-${id}`,
      id,
      paymentMethod,
      status === 'refunded' ? 'refunded' : 'success',
      `MT-${id}`,
      `PT-${id}`,
      paymentMode,
      `request-${id}`)
    }
    await client.$executeRawUnsafe(`
      INSERT INTO "refunds" (
        "id", "refund_no", "order_id", "payment_id", "refund_amount", "reason", "status", "provider_refund_no",
        "request_key", "requested_by", "approved_by", "completed_at"
      ) VALUES ('refund-legacy', 'RF-LEGACY', 'legacy-refunded', 'pay-legacy-refunded', 10000, '历史退款', 'completed', 'PR-LEGACY', 'refund-request-legacy', 'legacy-user', 'legacy-user', CURRENT_TIMESTAMP)
    `)
    await client.$executeRawUnsafe(`
      INSERT INTO "refund_items" ("id", "refund_id", "order_item_id", "quantity", "amount_cents")
      VALUES ('refund-item-legacy', 'refund-legacy', 'item-legacy-refunded', 1, 10000)
    `)

    const orderProjection = `
      SELECT "id", "order_no", "store_id", "cashier_id", "cashier_name_snapshot", "subtotal", "discount_amount",
             "payable_amount", "business_date", "discount_percent", "remark", "status", "payment_status", "payment_method",
             "payment_mode", "checkout_key", "cart_hash", "version", "created_at", "updated_at", "completed_at", "cancelled_at",
             "cancelled_by", "cancel_reason"
      FROM "orders" ORDER BY "id"
    `
    const before = {
      orders: sha(await client.$queryRawUnsafe(orderProjection)),
      orderItems: sha(await client.$queryRawUnsafe('SELECT * FROM "order_items" ORDER BY "id"')),
      payments: sha(await client.$queryRawUnsafe('SELECT * FROM "payments" ORDER BY "id"')),
      refunds: sha(await client.$queryRawUnsafe('SELECT * FROM "refunds" ORDER BY "id"')),
      refundItems: sha(await client.$queryRawUnsafe('SELECT * FROM "refund_items" ORDER BY "id"')),
    }

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const afterLedger = await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    assert.equal(Number(afterLedger[0].count), 58)
    const dimensions = await client.$queryRawUnsafe(`
      SELECT "id", "order_source", "entry_mode", "settlement_authority", "source_order_ref"
      FROM "orders" ORDER BY "id"
    `)
    assert.equal(dimensions.length, orders.length)
    assert.equal(dimensions.every((row) => row.order_source === 'STORE_POS'
      && row.entry_mode === 'POS_CHECKOUT'
      && row.settlement_authority === 'PAYMENT'
      && row.source_order_ref === null), true)
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "external_settlements"'))[0].count), 0)

    const after = {
      orders: sha(await client.$queryRawUnsafe(orderProjection)),
      orderItems: sha(await client.$queryRawUnsafe('SELECT * FROM "order_items" ORDER BY "id"')),
      payments: sha(await client.$queryRawUnsafe('SELECT * FROM "payments" ORDER BY "id"')),
      refunds: sha(await client.$queryRawUnsafe('SELECT * FROM "refunds" ORDER BY "id"')),
      refundItems: sha(await client.$queryRawUnsafe('SELECT * FROM "refund_items" ORDER BY "id"')),
    }
    assert.deepEqual(after, before)

    const transferColumns = await client.$queryRawUnsafe(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND ((table_name = 'InventoryItem' AND column_name IN ('transferBoxEnabled','transferBoxWeightGrams','transferPieceEnabled','transferPieceWeightGrams'))
          OR (table_name = 'TransferItem' AND column_name IN ('quantityUnit','unitWeightGramsSnapshot')))
      ORDER BY table_name, column_name
    `, schemaName)
    assert.equal(transferColumns.length, 6, 'Migration 57 transfer columns must remain intact')
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
