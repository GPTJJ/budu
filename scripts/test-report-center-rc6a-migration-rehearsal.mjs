import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OperatingCostAuthority } from '../server/operating-cost-authority.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const schemaName = `report_center_rc6a_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migration61 = '20260831200000_report_center_product_cost_history'
const migration62 = '20260831203000_report_center_operating_cost_authority'
const sha = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex')
const migrate = (schemaPath) => execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], { cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000 })

test('production 58 → report 59/60 → cost 61/62 preserves historical sales facts', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-report-center-rc6a-migration-'))
  const migrations = path.join(temp, 'migrations')
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma')); fs.mkdirSync(migrations)
    for (const entry of fs.readdirSync(path.join(root, 'prisma', 'migrations'))) {
      if ([migration61, migration62].includes(entry)) continue
      fs.cpSync(path.join(root, 'prisma', 'migrations', entry), path.join(migrations, entry), { recursive: true })
    }
    migrate(path.join(temp, 'schema.prisma'))
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'))[0].count), 60)
    await client.$executeRawUnsafe(`INSERT INTO "Store" ("key","name") VALUES ('cost-store','成本门店')`)
    await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" ("id","name","category","sku","salePriceCents","costPriceCents","isActive") VALUES ('cost-item','成本商品','product','COST-1',1000,300,true)`)
    await client.$executeRawUnsafe(`INSERT INTO "orders" ("id","order_no","store_id","cashier_id","subtotal","payable_amount","business_date","status","payment_status","checkout_key","cart_hash") VALUES ('cost-order','COST-O-1','cost-store','u',1000,1000,DATE '2026-08-30','draft','unpaid','cost-checkout','cost-cart')`)
    await client.$executeRawUnsafe(`INSERT INTO "order_items" ("id","order_id","product_id","product_name_snapshot","sku_snapshot","unit_price","cost_price_snapshot","quantity","line_amount","actual_amount") VALUES ('cost-oi','cost-order','cost-item','成本商品','COST-1',1000,300,2,2000,2000)`)
    await client.$executeRawUnsafe(`INSERT INTO "order_items" ("id","order_id","product_id","product_name_snapshot","sku_snapshot","unit_price","cost_price_snapshot","quantity","line_amount","actual_amount","is_gift") VALUES ('cost-gift','cost-order','cost-item','赠品','COST-1',1000,300,1,1000,0,true)`)
    await client.$executeRawUnsafe(`INSERT INTO "payments" ("id","payment_no","order_id","channel","amount","merchant_trade_no","provider","request_key","status") VALUES ('cost-pay','COST-P-1','cost-order','cash',1000,'COST-M-1','cash','cost-pay-key','success')`)
    await client.$executeRawUnsafe(`UPDATE "orders" SET "status"='completed', "payment_status"='paid' WHERE "id"='cost-order'`)
    const factSql = `SELECT "id","order_id","product_id","unit_price","cost_price_snapshot","quantity","line_amount","actual_amount","is_gift" FROM "order_items" ORDER BY "id"`
    const before = sha(await client.$queryRawUnsafe(factSql))
    fs.cpSync(path.join(root, 'prisma', 'migrations', migration61), path.join(migrations, migration61), { recursive: true }); migrate(path.join(temp, 'schema.prisma'))
    assert.equal(sha(await client.$queryRawUnsafe(factSql)), before)
    assert.equal(Number((await client.$queryRawUnsafe(`SELECT COUNT(*)::int count FROM "inventory_item_cost_histories" WHERE "inventory_item_id"='cost-item'`))[0].count), 1)
    const baseline = await client.$queryRawUnsafe(`SELECT "cost_price_cents", "effective_from"::text FROM "inventory_item_cost_histories" WHERE "inventory_item_id"='cost-item'`)
    assert.equal(BigInt(baseline[0].cost_price_cents), 300n)
    await assert.rejects(client.$executeRawUnsafe(`UPDATE "InventoryItem" SET "costPriceCents"=301 WHERE "id"='cost-item'`), /product cost can only change once/)
    fs.cpSync(path.join(root, 'prisma', 'migrations', migration62), path.join(migrations, migration62), { recursive: true }); migrate(path.join(temp, 'schema.prisma'))
    assert.equal(sha(await client.$queryRawUnsafe(factSql)), before)
    assert.equal(Number((await client.$queryRawUnsafe('SELECT COUNT(*)::int count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'))[0].count), 62)
    await client.$executeRawUnsafe(`INSERT INTO "store_labor_cost_periods" ("id","store_key","period","confirmed_at","confirmed_by") VALUES ('zero-labor','cost-store',DATE '2026-08-01',CURRENT_TIMESTAMP,'tester')`)
    assert.equal(Number((await client.$queryRawUnsafe(`SELECT COUNT(*)::int count FROM "store_labor_cost_entries" WHERE "period_id"='zero-labor'`))[0].count), 0)
    await client.$executeRawUnsafe(`INSERT INTO "store_rent_histories" ("id","store_key","mode","fixed_amount_cents","effective_from") VALUES ('rent-exact','cost-store','FIXED',1000,DATE '2026-08-01')`)
    await client.$executeRawUnsafe(`INSERT INTO "store_utility_costs" ("id","store_key","period","estimated_cents","actual_cents") VALUES ('utility-exact','cost-store',DATE '2026-08-01',600,500)`)
    const days = Array.from({ length: 31 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
    const scope = { range: { from: '2026-08-01', to: '2026-08-31', days, start: new Date('2026-08-01T00:00:00Z'), endExclusive: new Date('2026-09-01T00:00:00Z') }, stores: [{ key: 'cost-store', name: '成本门店' }], days: days.map((date) => ({ storeKey: 'cost-store', storeName: '成本门店', date, authority: 'POS' })) }
    const summary = { daily: days.map((date) => ({ storeKey: 'cost-store', date, revenueCents: date === '2026-08-30' ? '1000' : '0', grossCents: date === '2026-08-30' ? '2000' : '0' })) }
    const reportQuery = { resolveScope: async () => scope, summary: async () => summary }
    const payrollLoader = async () => ({ result: { calculationReady: true, mode: 'EMPLOYEE_ID', payroll: { employees: [{ salary: 100, dailyExplanations: [{ storeKey: 'cost-store', payableHoursSource: 'ACTUAL_HOURS', payableHours: 8 }] }] } } })
    const authority = new OperatingCostAuthority(client, reportQuery, { now: () => new Date('2026-09-30T12:00:00+08:00'), payrollLoader })
    const user = { role: 'finance', permissions: { reportSalesView: true, reportAllStores: true, reportCostView: true, reportLaborView: true } }
    const exact = await authority.report(user, { from: '2026-08-01', to: '2026-08-31' })
    assert.equal(exact.state, 'EXACT')
    assert.equal(exact.totals.cogsCents, '900', '赠品计入快照 COGS，退款状态不会自动冲回')
    await client.$executeRawUnsafe(`UPDATE "store_utility_costs" SET "actual_cents"=NULL WHERE "id"='utility-exact'`)
    const estimated = await authority.report(user, { from: '2026-08-01', to: '2026-08-31' })
    assert.equal(estimated.state, 'ESTIMATED'); assert.equal(estimated.exactOperatingProfitCents, null)
    await client.$executeRawUnsafe(`DELETE FROM "store_utility_costs" WHERE "id"='utility-exact'`)
    const incomplete = await authority.report(user, { from: '2026-08-01', to: '2026-08-31' })
    assert.equal(incomplete.state, 'INCOMPLETE'); assert.equal(incomplete.estimatedOperatingProfitCents, null); assert.ok(incomplete.completenessCodes.includes('INCOMPLETE_UTILITY'))
  } finally {
    await client.$disconnect(); await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); await admin.$disconnect(); fs.rmSync(temp, { recursive: true, force: true })
  }
})
