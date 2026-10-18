import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

// Disposable in-process PostgreSQL only. Never opens a network database.
const root = new URL('../prisma/migrations/', import.meta.url)
const migrationName = '20261018114000_store_pickup_enabled'
const read = name => fs.readFileSync(new URL(`${name}/migration.sql`, root), 'utf8')

test('自提单列迁移：88份既有SQL加新增SQL执行兼容，保留旧店、旧写入与关闭设置', async () => {
  const db = new PGlite({ extensions: { btree_gist } })
  try {
    const baseline = fs.readdirSync(root).filter(name => name < migrationName && fs.existsSync(new URL(`${name}/migration.sql`, root))).sort()
    assert.equal(baseline.length, 88)
    for (const name of baseline) await db.exec(read(name))
    await db.exec(`INSERT INTO "Store" ("key","name","active") VALUES
      ('synthetic-open','合成原营业店',true),('synthetic-closed','合成原停用店',false)`)
    const before = (await db.query('SELECT to_jsonb(s) AS row FROM "Store" s ORDER BY key')).rows
    await db.exec(read(migrationName))
    const after = (await db.query(`SELECT to_jsonb(s) - 'pickup_enabled' AS row FROM "Store" s ORDER BY key`)).rows
    assert.deepEqual(after, before)
    assert.equal((await db.query('SELECT count(*) AS count FROM "Store" WHERE pickup_enabled IS NOT TRUE')).rows[0].count, 0)
    const column = (await db.query(`SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name='Store' AND column_name='pickup_enabled'`)).rows[0]
    assert.equal(column.is_nullable, 'NO')
    assert.equal(column.column_default, 'true')

    // An old application that omits the new field still creates a normal store.
    await db.exec(`INSERT INTO "Store" ("key","name") VALUES ('synthetic-old-writer','合成旧写入')`)
    assert.deepEqual((await db.query(`SELECT active,pickup_enabled FROM "Store" WHERE key='synthetic-old-writer'`)).rows[0], { active: true, pickup_enabled: true })
    await db.exec(`UPDATE "Store" SET pickup_enabled=false WHERE key='synthetic-open'`)
    await db.exec(`UPDATE "Store" SET name='合成仓库改名' WHERE key='synthetic-open'`)
    assert.deepEqual((await db.query(`SELECT active,pickup_enabled FROM "Store" WHERE key='synthetic-open'`)).rows[0], { active: true, pickup_enabled: false })
    await assert.rejects(db.exec(`UPDATE "Store" SET pickup_enabled=NULL WHERE key='synthetic-open'`), /null/i)
    // Rolling application code back does not require deleting this column.
    // Old code cannot enforce false; publication handoff records that boundary.
    assert.equal((await db.query(`SELECT key,name,active FROM "Store" WHERE key='synthetic-closed'`)).rows[0].active, false)
  } finally {
    await db.close()
  }
})
