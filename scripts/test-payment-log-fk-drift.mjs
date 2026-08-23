// Blocker 4 验收：00004 迁移必须按「精确外键身份」（pg_constraint conkey/confkey +
// pg_attribute 列名）定位并规范化 payment_logs 外键（真实 PostgreSQL，不伪造）。
//
// 场景（每个场景使用一次性可弃用 schema）：
//  1. 正常链：完整迁移链（含 00003/00004）→ 两对 FK 精确匹配且 confdeltype='r'
//  2. 无关外键漂移：额外向 payments/orders 各加一条「无关」外键 →
//     00004 仍只选中精确匹配的 FK，无关外键不被触碰，业务行不删除
//  3. 精确 FK 缺失：删掉 payment_id FK → 00004 RAISE EXCEPTION 中止（零匹配 fail closed）
//  4. 精确 FK 重复：再加一条同名来源/目标的重复 FK → 00004 RAISE EXCEPTION 中止
//     （多匹配 fail closed，不删除任何约束）
//
// 数据库不可用/部署失败 → 测试套件 FAIL（非零退出），绝不静默跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const MIGRATIONS_SRC = path.join(root, 'prisma', 'migrations')
const SCHEMA_SRC = path.join(root, 'prisma', 'schema.prisma')
const PRISMA_BIN = path.join(root, 'node_modules', '.bin', 'prisma')
const MIGRATION_00004 = path.join(MIGRATIONS_SRC, '20260822000004_payment_log_fk_exact', 'migration.sql')

let started = false

function schemaUrl(name) {
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', name)
  return url.toString()
}

/** 复制 schema.prisma + migrations（可排除某目录）到临时目录，用于部分迁移链部署。 */
function prepareDeployDir(excludeDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-drift-'))
  fs.copyFileSync(SCHEMA_SRC, path.join(tmp, 'schema.prisma'))
  fs.cpSync(MIGRATIONS_SRC, path.join(tmp, 'migrations'), { recursive: true })
  if (excludeDir) fs.rmSync(path.join(tmp, 'migrations', excludeDir), { recursive: true, force: true })
  return tmp
}

function deploy(tmpDir, url) {
  execFileSync(PRISMA_BIN, ['migrate', 'deploy', '--schema', path.join(tmpDir, 'schema.prisma')], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    timeout: 180000,
  })
}

/** 直接执行 00004 迁移 SQL；返回 { status, stdout, stderr }（不抛错，供失败场景断言）。 */
function runMigration00004(url) {
  return spawnSync(PRISMA_BIN, ['db', 'execute', '--url', url, '--file', MIGRATION_00004], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 120000,
  })
}

async function makeClient(url) {
  const { PrismaClient } = await import('@prisma/client')
  const client = new PrismaClient({ datasources: { db: { url } } })
  await client.$connect()
  return client
}

async function seedRows(client, suffix) {
  await client.store.create({ data: { key: `store-${suffix}`, name: `漂移门店 ${suffix}` } })
  await client.order.create({
    data: {
      id: `order-${suffix}`,
      orderNo: `D-${suffix}`,
      storeId: `store-${suffix}`,
      cashierId: 'c',
      checkoutKey: `ck-${suffix}`,
      cartHash: 'h',
      payableAmount: 100n,
    },
  })
  await client.payment.create({
    data: {
      id: `pay-${suffix}`,
      paymentNo: `P${suffix}`,
      orderId: `order-${suffix}`,
      channel: 'cash',
      amount: 100n,
      status: 'success',
      merchantTradeNo: `M${suffix}`,
      provider: 'mock',
      requestKey: `rk-${suffix}`,
    },
  })
  await client.paymentLog.create({
    data: { id: `log-${suffix}`, paymentId: `pay-${suffix}`, orderId: `order-${suffix}`, event: 'payment.success' },
  })
}

async function fkFacts(client) {
  const rows = await client.$queryRaw`
    SELECT fk.conname AS name,
           src.attname AS src_col,
           tgt.attname AS tgt_col,
           fk.confrelid::regclass::text AS target_table,
           fk.confdeltype AS confdeltype
    FROM pg_constraint fk
    JOIN pg_attribute src ON src.attrelid = fk.conrelid AND src.attnum = fk.conkey[1]
    JOIN pg_attribute tgt ON tgt.attrelid = fk.confrelid AND tgt.attnum = fk.confkey[1]
    WHERE fk.conrelid = 'payment_logs'::regclass AND fk.contype = 'f'
    ORDER BY fk.conname`
  return rows.map((row) => ({ name: row.name, src: row.src_col, tgt: row.tgt_col, target: row.target_table, del: row.confdeltype }))
}

test('B7-D 前置：连接本地 PostgreSQL（不可用 → 套件 FAIL）', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const probe = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  try {
    await probe.$queryRaw`SELECT 1`
  } catch (error) {
    await probe.$disconnect().catch(() => {})
    throw new Error(`REAL_DB_HISTORY_TEST_NOT_RUN — 本地 PostgreSQL 不可用：${error.message}`)
  }
  await probe.$disconnect()
  started = true
})

function requireStarted(t) {
  if (!started) {
    assert.fail('REAL_DB_HISTORY_TEST_NOT_RUN — 前置步骤失败（PostgreSQL 不可用），本断言必须失败而非跳过')
    return false
  }
  return true
}

test('B7-D 场景1：正常迁移链 → 两对 FK 精确匹配且 RESTRICT，业务行不删除', async (t) => {
  if (!requireStarted(t)) return
  const name = `drift_ok_${process.pid}`
  const url = schemaUrl(name)
  const probe = new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${name}"`)
  await probe.$disconnect()
  const tmp = prepareDeployDir(null)
  try {
    deploy(tmp, url)
    const client = await makeClient(url)
    await seedRows(client, `${process.pid}-ok`)
    const facts = await fkFacts(client)
    const byName = Object.fromEntries(facts.map((f) => [f.name, f]))
    const pay = byName['payment_logs_payment_id_fkey']
    const ord = byName['payment_logs_order_id_fkey']
    assert.ok(pay && pay.src === 'payment_id' && pay.tgt === 'id' && pay.target === 'payments' && pay.del === 'r', JSON.stringify(pay))
    assert.ok(ord && ord.src === 'order_id' && ord.tgt === 'id' && ord.target === 'orders' && ord.del === 'r', JSON.stringify(ord))
    assert.equal(await client.paymentLog.count(), 1, '业务行必须保留')
    assert.equal(await client.payment.count(), 1)
    assert.equal(await client.order.count(), 1)
    await client.$disconnect()
  } finally {
    await dropSchema(url)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('B7-D 场景2：无关外键漂移 → 00004 只选中精确 FK，无关 FK 不被触碰，业务行保留', async (t) => {
  if (!requireStarted(t)) return
  const name = `drift_extra_${process.pid}`
  const url = schemaUrl(name)
  const probe = new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${name}"`)
  await probe.$disconnect()
  const tmp = prepareDeployDir('20260822000004_payment_log_fk_exact')
  try {
    deploy(tmp, url) // 只部署到 00003
    const client = await makeClient(url)
    await seedRows(client, `${process.pid}-x`)
    // 为两条「无关」外键准备可满足的既有数据：
    //   order_id → payments(id)：需要 payments 中存在 order_id 值
    //   payment_id → orders(id)：需要 orders 中存在 payment_id 值
    await client.order.create({
      data: { id: `pay-${process.pid}-x`, orderNo: `DX-${process.pid}-o`, storeId: `store-${process.pid}-x`, cashierId: 'c', checkoutKey: `ckx-${process.pid}`, cartHash: 'h' },
    })
    await client.payment.create({
      data: { id: `order-${process.pid}-x`, paymentNo: `PX-${process.pid}`, orderId: `pay-${process.pid}-x`, channel: 'cash', amount: 1n, status: 'success', merchantTradeNo: `MX-${process.pid}`, provider: 'mock', requestKey: `rkx-${process.pid}` },
    })
    // 两条「无关」外键：order_id→payments(id)、payment_id→orders(id)（与精确模式列名不同）
    await client.$executeRawUnsafe('ALTER TABLE "payment_logs" ADD CONSTRAINT "plog_extra_to_payments" FOREIGN KEY ("order_id") REFERENCES "payments"("id") ON DELETE NO ACTION')
    await client.$executeRawUnsafe('ALTER TABLE "payment_logs" ADD CONSTRAINT "plog_extra_to_orders" FOREIGN KEY ("payment_id") REFERENCES "orders"("id") ON DELETE NO ACTION')
    const before = await fkFacts(client)
    assert.equal(before.length, 4)
    // 运行 00004：必须成功
    const run = runMigration00004(url)
    assert.equal(run.status, 0, `00004 应成功：${run.stderr}`)
    const after = await fkFacts(client)
    const byName = Object.fromEntries(after.map((f) => [f.name, f]))
    assert.equal(byName['payment_logs_payment_id_fkey'].del, 'r')
    assert.equal(byName['payment_logs_order_id_fkey'].del, 'r')
    assert.equal(byName['plog_extra_to_payments'].del, 'a', '无关外键必须原样保留（NO ACTION，confdeltype=a）')
    assert.equal(byName['plog_extra_to_orders'].del, 'a', '无关外键必须原样保留（NO ACTION，confdeltype=a）')
    assert.equal(after.length, 4, '无关外键不被删除')
    assert.equal(await client.paymentLog.count(), 1, '业务行必须保留')
    await client.$disconnect()
  } finally {
    await dropSchema(url)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('B7-D 场景3：精确 payment_id FK 缺失 → 00004 零匹配 fail closed（RAISE），未做任何修改', async (t) => {
  if (!requireStarted(t)) return
  const name = `drift_missing_${process.pid}`
  const url = schemaUrl(name)
  const probe = new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${name}"`)
  await probe.$disconnect()
  const tmp = prepareDeployDir('20260822000004_payment_log_fk_exact')
  try {
    deploy(tmp, url)
    const client = await makeClient(url)
    await seedRows(client, `${process.pid}-m`)
    await client.$executeRawUnsafe('ALTER TABLE "payment_logs" DROP CONSTRAINT "payment_logs_payment_id_fkey"')
    const run = runMigration00004(url)
    assert.notEqual(run.status, 0, '零匹配必须失败')
    assert.match(run.stderr, /payment_logs\.payment_id -> payments\.id/, '错误信息须指明缺失的关系')
    assert.match(run.stderr, /必须恰好为 1/, '错误信息须说明数量校验')
    // fail closed：未做任何修改
    const facts = await fkFacts(client)
    assert.equal(facts.length, 1, 'order_id 外键必须原样保留')
    assert.equal(facts[0].name, 'payment_logs_order_id_fkey')
    assert.equal(await client.paymentLog.count(), 1, '业务行必须保留')
    await client.$disconnect()
  } finally {
    await dropSchema(url)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('B7-D 场景4：精确 payment_id FK 重复 → 00004 多匹配 fail closed（RAISE），不删除任何约束', async (t) => {
  if (!requireStarted(t)) return
  const name = `drift_dup_${process.pid}`
  const url = schemaUrl(name)
  const probe = new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${name}"`)
  await probe.$disconnect()
  const tmp = prepareDeployDir('20260822000004_payment_log_fk_exact')
  try {
    deploy(tmp, url)
    const client = await makeClient(url)
    await seedRows(client, `${process.pid}-d`)
    // 追加一条与精确匹配完全相同的重复外键（CASCADE，便于识别）
    await client.$executeRawUnsafe('ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_payment_id_fkey_dup" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE')
    const run = runMigration00004(url)
    assert.notEqual(run.status, 0, '多匹配必须失败')
    assert.match(run.stderr, /payment_logs\.payment_id -> payments\.id/, '错误信息须指明重复的关系')
    assert.match(run.stderr, /必须恰好为 1/, '错误信息须说明数量校验')
    // fail closed：两条重复外键都必须原样保留（一条都没被删除）
    const facts = await fkFacts(client)
    const names = facts.map((f) => f.name).sort()
    assert.deepEqual(names, ['payment_logs_order_id_fkey', 'payment_logs_payment_id_fkey', 'payment_logs_payment_id_fkey_dup'])
    assert.equal(await client.paymentLog.count(), 1, '业务行必须保留')
    await client.$disconnect()
  } finally {
    await dropSchema(url)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

async function dropSchema(url) {
  try {
    const { PrismaClient } = await import('@prisma/client')
    const client = new PrismaClient({ datasources: { db: { url } } })
    const name = new URL(url).searchParams.get('schema')
    await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`).catch(() => {})
    await client.$disconnect().catch(() => {})
  } catch { /* 清理失败不影响断言结果 */ }
}
