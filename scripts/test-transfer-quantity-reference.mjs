import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// Isolated embedded PostgreSQL engine + actual production HTTP router. The
// adapter below only implements the Prisma operations used by these handlers.
// Native Prisma/PostgreSQL concurrency remains a separate deployment gate.
process.env.APP_ENV = 'test'
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/isolated_pglite_adapter'
const db = new PGlite()
await db.exec(`
  CREATE TABLE "TransferRequest" (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', purpose TEXT DEFAULT 'TEST',
    "fromStoreKey" TEXT DEFAULT 'guanshe', "toStoreKey" TEXT DEFAULT 'tongying', "createdBy" TEXT DEFAULT 'owner',
    "shippedBy" TEXT DEFAULT '', "shippedAt" TIMESTAMPTZ, "updatedAt" TIMESTAMPTZ DEFAULT NOW(), "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "deletedAt" TIMESTAMPTZ, "withdrawnBy" TEXT DEFAULT '', "withdrawnAt" TIMESTAMPTZ, note TEXT DEFAULT '');
  CREATE TABLE "TransferItem" (id TEXT PRIMARY KEY, "requestId" TEXT REFERENCES "TransferRequest"(id), "itemId" TEXT NOT NULL,
    quantity INTEGER NOT NULL, "quantityUnit" TEXT DEFAULT 'legacy', "shippedQuantity" INTEGER,
    "unitWeightGramsSnapshot" INTEGER, "itemNameSnapshot" TEXT DEFAULT '测试货品', "categorySnapshot" TEXT DEFAULT 'material',
    "itemCodeSnapshot" TEXT DEFAULT '', "productCategoryNameSnapshot" TEXT DEFAULT '', note TEXT DEFAULT '',
    CONSTRAINT "TransferItem_shippedQuantity_valid" CHECK ("shippedQuantity" IS NULL OR ("shippedQuantity" >= 0 AND "shippedQuantity" <= quantity)),
    CONSTRAINT "TransferItem_request_item_unit_unique" UNIQUE ("requestId", "itemId", "quantityUnit"));
  CREATE TABLE "StockSentinel" (quantity INTEGER); INSERT INTO "StockSentinel" VALUES (0);
  INSERT INTO "TransferRequest" (id,status) VALUES ('historical','shipped');
  INSERT INTO "TransferItem" (id,"requestId","itemId",quantity,"shippedQuantity") VALUES ('old-null','historical','a',4,NULL),('old-less','historical','b',4,2),('old-equal','historical','c',4,4);
`)
const historical = (await db.query('SELECT * FROM "TransferItem" ORDER BY id')).rows
await assert.rejects(db.query(`UPDATE "TransferItem" SET "shippedQuantity"=6 WHERE id='old-equal'`))
await db.exec(await fs.readFile(new URL('../prisma/migrations/20261002000000_transfer_actual_quantity_reference/migration.sql', import.meta.url), 'utf8'))
assert.deepEqual((await db.query('SELECT * FROM "TransferItem" ORDER BY id')).rows, historical)

const load = async (args, sql = db) => {
  const row = (await sql.query('SELECT * FROM "TransferRequest" WHERE id=$1 AND "deletedAt" IS NULL', [args.where.id])).rows[0]
  if (!row) return null
  row.items = (await sql.query('SELECT * FROM "TransferItem" WHERE "requestId"=$1 ORDER BY id', [row.id])).rows.map(item => ({ ...item, item: { name: '测试货品', category: 'material' } }))
  row.fromStore = { key: row.fromStoreKey, name: '官舍店' }
  row.toStore = { key: row.toStoreKey, name: '通盈店' }
  return row
}
const adapter = sql => ({
  transferRequest: {
    findFirst: args => load(args, sql), findUnique: args => load(args, sql),
    updateMany: async ({ where, data }) => {
      const keys = Object.keys(data)
      const result = await sql.query(`UPDATE "TransferRequest" SET ${keys.map((key, i) => `"${key}"=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} AND status=$${keys.length + 2} AND "deletedAt" IS NULL RETURNING id`, [...keys.map(key => data[key]), where.id, where.status])
      return { count: result.rows.length }
    },
  },
  transferItem: {
    updateMany: async ({ where, data }) => {
      const result = await sql.query('UPDATE "TransferItem" SET "shippedQuantity"=$1 WHERE id=$2 AND "requestId"=$3 AND "shippedQuantity" IS NULL RETURNING id', [data.shippedQuantity, where.id, where.requestId])
      return { count: result.rows.length }
    },
  },
})
globalThis.__buduPrisma = { ...adapter(db), $transaction: callback => db.transaction(tx => callback(adapter(tx))) }
const { v2Router } = await import('../server/v2.js')
const actors = {
  sender: { username: 'sender', role: 'manager', storeKeys: ['guanshe'] },
  receiver: { username: 'receiver', role: 'manager', storeKeys: ['tongying'] },
  outsider: { username: 'outsider', role: 'staff', storeKeys: ['xidan'] },
}
const app = express()
app.use(express.json())
app.use((req, res, next) => { req.user = actors[req.get('x-test-actor') || 'sender']; next() })
app.use('/api/v2', v2Router)
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let sequence = 0
async function fixture(units = ['legacy']) {
  const id = `isolated-${++sequence}`
  await db.query('INSERT INTO "TransferRequest" (id) VALUES ($1)', [id])
  for (const unit of units) await db.query('INSERT INTO "TransferItem" (id,"requestId","itemId",quantity,"quantityUnit") VALUES ($1,$2,$3,4,$4)', [id + unit, id, 'item', unit])
  return id
}
async function ship(id, items, actor = 'sender') {
  const response = await fetch(`${origin}/api/v2/transfer-requests/${id}/ship`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-actor': actor }, body: JSON.stringify({ items }) })
  return { status: response.status, body: await response.json() }
}
test('exact new migration preserves historical facts; DB rejects negative/overflow and preserves uniqueness', async () => {
  for (const value of [0, 2, 4, 6, 999999, null]) {
    await db.query('UPDATE "TransferItem" SET "shippedQuantity"=$1 WHERE id=$2', [value, 'old-equal'])
    assert.equal((await db.query('SELECT "shippedQuantity" FROM "TransferItem" WHERE id=$1', ['old-equal'])).rows[0].shippedQuantity, value)
  }
  for (const value of [-1, 1000000]) await assert.rejects(db.query('UPDATE "TransferItem" SET "shippedQuantity"=$1 WHERE id=$2', [value, 'old-equal']))
  await assert.rejects(db.query(`INSERT INTO "TransferItem" (id,"requestId","itemId",quantity) VALUES ('duplicate','historical','a',4)`))
})
test('production HTTP accepts less/equal/more and keeps requested and actual facts independent', async () => {
  for (const quantity of [2, 4, 6, 999999]) {
    const id = await fixture()
    const result = await ship(id, [{ itemId: 'item', shippedQuantity: quantity }])
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.request.items[0].quantity, 4)
    assert.equal(result.body.request.items[0].shippedQuantity, quantity)
    assert.equal((await ship(id, [{ itemId: 'item', shippedQuantity: quantity }])).status, 409)
  }
})
test('HTTP rejects all zero, negative, fractional, empty, null, missing, overflow and mismatched units', async () => {
  for (const quantity of [0, -1, 1.5, '', null, undefined, 1000000]) {
    const id = await fixture()
    assert.equal((await ship(id, [{ itemId: 'item', shippedQuantity: quantity }])).status, 400)
    assert.equal((await load({ where: { id } })).status, 'pending')
  }
  const id = await fixture(['box'])
  assert.equal((await ship(id, [{ itemId: 'item', shippedBoxQuantity: 6, shippedPieceQuantity: 1 }])).status, 400)
  assert.equal((await ship(id, [{ itemId: 'item', shippedQuantity: 6 }])).status, 400)
  assert.equal((await ship(id, [{ itemId: 'unrequested', shippedBoxQuantity: 6, shippedPieceQuantity: 0 }])).status, 400)
})
test('existing box/piece units accept over-request and single zero without adding a physical unit', async () => {
  const id = await fixture(['box', 'piece'])
  const result = await ship(id, [{ itemId: 'item', shippedBoxQuantity: 0, shippedPieceQuantity: 6 }])
  assert.equal(result.status, 200)
  assert.equal(result.body.request.items[0].shippedBoxQuantity, 0)
  assert.equal(result.body.request.items[0].shippedPieceQuantity, 6)
  assert.equal((await db.query('SELECT COUNT(*)::INT AS count FROM "TransferItem" WHERE "requestId"=$1', [id])).rows[0].count, 2)
})
test('ordinary single zero is recorded; an already-recorded line rolls back the claimed state', async () => {
  const id = await fixture()
  await db.query('INSERT INTO "TransferItem" (id,"requestId","itemId",quantity) VALUES ($1,$2,$3,4)', [id + 'second', id, 'second'])
  const result = await ship(id, [{ itemId: 'item', shippedQuantity: 0 }, { itemId: 'second', shippedQuantity: 6 }])
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.request.items.map(item => [item.itemId, item.shippedQuantity]), [['item', 0], ['second', 6]])
  const conflict = await fixture()
  await db.query('UPDATE "TransferItem" SET "shippedQuantity"=1 WHERE "requestId"=$1', [conflict])
  assert.equal((await ship(conflict, [{ itemId: 'item', shippedQuantity: 6 }])).status, 409)
  const unchanged = await load({ where: { id: conflict } })
  assert.equal(unchanged.status, 'pending')
  assert.equal(unchanged.items[0].shippedQuantity, 1)
})
test('sender authority and concurrent duplicate CAS remain intact; stock sentinel unchanged', async () => {
  const id = await fixture()
  const items = [{ itemId: 'item', shippedQuantity: 6 }]
  for (const actor of ['receiver', 'outsider']) assert.equal((await ship(id, items, actor)).status, 403)
  const results = await Promise.all([ship(id, items), ship(id, items)])
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409])
  assert.equal((await load({ where: { id } })).items[0].shippedQuantity, 6)
  assert.deepEqual((await db.query('SELECT * FROM "StockSentinel"')).rows, [{ quantity: 0 }])
})
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); delete globalThis.__buduPrisma })
