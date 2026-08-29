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
const schemaName = `product_material_migration_${process.pid}`
const testUrl = (() => { const url = new URL(adminUrl); url.searchParams.set('schema', schemaName); return url.toString() })()
const migrationName = '20260829010000_product_material_management'

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe', timeout: 180000,
  })
}

test('产品物料 additive migration preserves legacy business facts and seeds the exact old selector', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-product-material-migration-'))
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
    const products = ['NO.1树莓','NO.2柠檬','NO.3百香果','NO.4橙子','NO.5英式伯爵茶','NO.6泰式奶茶','NO.7抹茶','NO.8榛子','NO.9海盐焦糖','NO.10香草','NO.11生椰拿铁','NO.12巧克力']
    const materials = ['物料-8颗礼盒（长）','物料8颗礼盒（方）','物料12颗礼盒','物料24颗礼盒','丝带-红','丝带-蓝','手提袋','散糖袋','冰袋','巧克力豆礼盒','巧克力豆礼盒手提袋','保温袋','酒精','手套','纸巾','湿巾','背贴','胶带','糖果口味卡','生巧保存提示卡','封口贴','试吃签','冰淇淋小勺','冰淇淋碗-圆','冰淇淋碗内-方','小票打印纸']
    let index = 0
    for (const name of [...products, ...materials, 'POS专用产品']) {
      await client.$executeRawUnsafe(`INSERT INTO "InventoryItem" (id, name, category, "isActive", "sortOrder") VALUES ($1, $2, $3, $4, $5)`, `legacy-${index}`, name, materials.includes(name) ? 'material' : 'product', name === 'POS专用产品', 77)
      index += 1
    }
    await client.$executeRawUnsafe(`INSERT INTO "Store" (key, name) VALUES ('from', '调出'), ('to', '调入')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id, "fromStoreKey", "toStoreKey", status, "createdBy") VALUES ('tr', 'from', 'to', 'completed', 'legacy')`)
    await client.$executeRawUnsafe(`INSERT INTO "TransferItem" (id, "requestId", "itemId", quantity, note, "itemNameSnapshot", "itemCodeSnapshot", "categorySnapshot") VALUES ('ti', 'tr', 'legacy-0', 5, '历史', 'NO.1树莓', 'NO.1', 'product')`)
    await client.$executeRawUnsafe(`INSERT INTO "PurchaseRequest" (id, "storeKey", status, "createdBy") VALUES ('pr', 'to', 'completed', 'legacy')`)
    await client.$executeRawUnsafe(`INSERT INTO "PurchaseItem" (id, "requestId", "itemId", "orderedQty", "receivedQty", note) VALUES ('pi', 'pr', 'legacy-20', 7, 7, '历史采购')`)
    const oldProjection = `SELECT i.id, i.name, i.category, i."isActive", i."sortOrder", t.quantity, t.note AS "transferNote", p."orderedQty", p."receivedQty", p.note AS "purchaseNote" FROM "InventoryItem" i LEFT JOIN "TransferItem" t ON t."itemId" = i.id LEFT JOIN "PurchaseItem" p ON p."itemId" = i.id ORDER BY i.id`
    const before = await client.$queryRawUnsafe(oldProjection)
    const digest = crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    const migrations = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    assert.equal(Number(migrations[0].count), 55)
    const after = await client.$queryRawUnsafe(oldProjection)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(after)).digest('hex'), digest)
    const counts = await client.$queryRawUnsafe(`SELECT category, COUNT(*)::int AS count FROM "InventoryItem" WHERE "transferEnabled" = true GROUP BY category ORDER BY category`)
    assert.deepEqual(counts, [{ category: 'material', count: 26 }, { category: 'product', count: 12 }])
    const posOnly = await client.inventoryItem.findUnique({ where: { name: 'POS专用产品' } })
    assert.equal(posOnly.transferEnabled, false)
    assert.equal(posOnly.isActive, true)
    assert.equal(posOnly.sortOrder, 77)
    const purchase = await client.purchaseItem.findUnique({ where: { id: 'pi' } })
    assert.equal(purchase.itemNameSnapshot, '')
  } finally {
    await client.$disconnect()
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await admin.$disconnect()
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
