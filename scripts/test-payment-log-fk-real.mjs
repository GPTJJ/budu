// Blocker 7 验收：payment_logs 外键必须为 ON DELETE RESTRICT（真实 PostgreSQL，不伪造）
//
// 使用一次性可弃用 schema 跑完整迁移链（prisma migrate deploy），再验证：
//  1. DELETE /pos/orders/:id 路由 → 409，且订单/支付/日志计数全部不变；
//  2. 直接 DELETE payments → 外键 23503 拒绝（约束为 RESTRICT，非 CASCADE），日志未被级联清除；
//  3. 数据库目录级证明：payment_logs 两个外键 confdeltype='r'（RESTRICT）。
//
// 运行前提：本地 PostgreSQL（默认 postgresql://budu:budu_local_dev@localhost:5432/budu，
// 可用 TEST_DATABASE_URL 覆盖；生产 DATABASE_URL 由测试调度器剥离，绝不触达）。
// 数据库不可用时整体跳过并输出 REAL_DB_HISTORY_TEST_NOT_RUN。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgresql://budu:budu_local_dev@localhost:5432/budu'
const SCHEMA = `r2_fk_${process.pid}`
const TEST_URL = (() => {
  const url = new URL(ADMIN_URL)
  url.searchParams.set('schema', SCHEMA)
  return url.toString()
})()

const SUPERUSER = { id: 'dev-b7', username: 'dev-b7', role: 'developer', status: 'active', storeKeys: ['store-b7'] }

let prisma = null
let started = false
const ORDER_ID = `order-b7-${process.pid}`
const PAYMENT_ID = `pay-b7-${process.pid}`

async function probeDatabase() {
  const { PrismaClient } = await import('@prisma/client')
  const probe = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
  await probe.$queryRaw`SELECT 1`
  await probe.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await probe.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`)
  await probe.$disconnect()
}

test('B7 前置：连接本地 PostgreSQL 并部署完整迁移链（不可用 → 测试套件 FAIL，绝不静默跳过）', async () => {
  try {
    await probeDatabase()
  } catch (error) {
    // R3：发布门禁必须 fail closed——数据库不可用 = 测试失败 = 非零退出
    throw new Error(`REAL_DB_HISTORY_TEST_NOT_RUN — 本地 PostgreSQL 不可用：${error.message}`)
  }
  process.env.DATABASE_URL = TEST_URL
  const prismaBin = path.join(root, 'node_modules', '.bin', 'prisma')
  try {
    execFileSync(prismaBin, ['migrate', 'deploy'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: TEST_URL },
      stdio: 'inherit',
      timeout: 180000,
    })
  } catch (error) {
    throw new Error(`REAL_DB_HISTORY_TEST_NOT_RUN — 迁移链部署失败：${error.message}`)
  }
  const { prisma: p } = await import('../server/pg.js')
  prisma = p
  started = true
})

/** R3：数据库不可用时后续断言一律失败（不跳过、不静默），保证发布门禁非零退出。 */
function requireStarted(t) {
  if (!started) {
    assert.fail('REAL_DB_HISTORY_TEST_NOT_RUN — 前置步骤失败（PostgreSQL 不可用），本断言必须失败而非跳过')
    return false
  }
  return true
}

test('B7：DELETE /pos/orders/:id 路由 → 409，订单/支付/日志计数全部不变', async (t) => {
  if (!requireStarted(t)) return
  await prisma.store.create({ data: { key: 'store-b7', name: `B7 门店 ${process.pid}` } })
  await prisma.order.create({
    data: {
      id: ORDER_ID,
      orderNo: `B7-${process.pid}`,
      storeId: 'store-b7',
      cashierId: 'cashier-b7',
      checkoutKey: `ck-b7-${process.pid}`,
      cartHash: 'hash-b7',
      payableAmount: 100n,
      status: 'paid',
      paymentStatus: 'paid',
      paymentMethod: 'wechat',
      paymentMode: 'wechat_pay',
    },
  })
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      paymentNo: `PAYB7${process.pid}`,
      orderId: ORDER_ID,
      channel: 'wechat',
      amount: 100n,
      status: 'success',
      merchantTradeNo: `B7MTN${process.pid}`,
      provider: 'wechat_pay',
      requestKey: `rk-b7-${process.pid}`,
    },
  })
  await prisma.paymentLog.create({
    data: { id: `plog-b7-${process.pid}`, paymentId: PAYMENT_ID, orderId: ORDER_ID, event: 'payment.success' },
  })

  const { posRouter } = await import('../server/pos.js')
  const expressModule = await import('express')
  const app = expressModule.default()
  app.use(expressModule.json())
  app.use((req, res, next) => { req.user = SUPERUSER; next() }) // 模拟已认证的超管会话
  app.use(posRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const res = await fetch(`${base}/pos/orders/${ORDER_ID}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    assert.equal(res.status, 409, `路由必须返回 409（实际 ${res.status}：${JSON.stringify(body)}）`)
    assert.ok(/不可删除/.test(body.error || ''), `错误信息必须说明不可删除（实际：${body.error}）`)
  } finally {
    server.close()
  }
  assert.equal(await prisma.order.count(), 1, '订单计数不变')
  assert.equal(await prisma.payment.count(), 1, '支付计数不变')
  assert.equal(await prisma.paymentLog.count(), 1, '支付日志计数不变')
})

test('B7：直接 DELETE payments → 外键 RESTRICT 拒绝（23001），日志不被级联清除', async (t) => {
  if (!requireStarted(t)) return
  // Prisma 将 raw 查询错误包装为 P2010，SQLSTATE 内嵌在 message（RESTRICT 违反=23001）
  const isRestrictViolation = (error) => {
    const sqlState = (String(error.message || '').match(/Code: `?(\d{5})`?/) || [])[1] || ''
    return String(error.code || '') === 'P2010' && ['23001', '23503'].includes(sqlState)
  }
  await assert.rejects(
    () => prisma.$executeRawUnsafe('DELETE FROM "payments" WHERE "id" = $1', PAYMENT_ID),
    (error) => isRestrictViolation(error) && /payment_logs/i.test(String(error.message)),
    '删除有日志的支付必须被 payment_logs 外键拒绝（RESTRICT 而非 CASCADE）',
  )
  assert.equal(await prisma.paymentLog.count({ where: { paymentId: PAYMENT_ID } }), 1, '日志必须原样保留')
  assert.equal(await prisma.payment.count(), 1, '支付必须原样保留')
})

test('B7：直接 DELETE orders → 外键拒绝（23001），日志保留', async (t) => {
  if (!requireStarted(t)) return
  const isRestrictViolation = (error) => {
    const sqlState = (String(error.message || '').match(/Code: `?(\d{5})`?/) || [])[1] || ''
    return String(error.code || '') === 'P2010' && ['23001', '23503'].includes(sqlState)
  }
  await assert.rejects(
    () => prisma.$executeRawUnsafe('DELETE FROM "orders" WHERE "id" = $1', ORDER_ID),
    (error) => isRestrictViolation(error),
    '删除有支付/日志的订单必须被外键拒绝',
  )
  assert.equal(await prisma.paymentLog.count({ where: { orderId: ORDER_ID } }), 1, '日志必须原样保留')
  assert.equal(await prisma.order.count(), 1, '订单必须原样保留')
})

test('B7：数据库目录级证明——payment_logs 两个外键均为 RESTRICT（confdeltype=r）', async (t) => {
  if (!requireStarted(t)) return
  const rows = await prisma.$queryRaw`
    SELECT conname, confdeltype
    FROM pg_constraint
    WHERE conrelid = 'payment_logs'::regclass AND contype = 'f'
    ORDER BY conname`
  assert.equal(rows.length, 2, `应恰好有 2 个外键（实际 ${rows.length}）`)
  for (const row of rows) {
    assert.equal(row.confdeltype, 'r', `约束 ${row.conname} 必须为 RESTRICT（confdeltype=r）`)
  }
  const names = rows.map((row) => row.conname).sort()
  assert.deepEqual(names, ['payment_logs_order_id_fkey', 'payment_logs_payment_id_fkey'])
})

test('B7：清理——删除一次性 schema', async (t) => {
  if (!requireStarted(t)) return
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await prisma.$disconnect()
  started = false
})
