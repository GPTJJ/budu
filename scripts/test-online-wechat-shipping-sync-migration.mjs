/**
 * PGlite rehearsal for 20260924140000_online_wechat_shipping_sync.
 *
 * 目的：证明这份 forward migration 在真实 PostgreSQL 上可执行，并且它承诺的
 * schema / constraints / index / immutable trigger 真的生效；同时证明 rollback
 * 干净可逆。全程使用进程内 PGlite（disposable，无外部数据库、无生产连接）。
 *
 * 不使用 run-tests.mjs 的统一入口（其物流测试路径注册存在既有缺陷，本任务禁止修改它）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const MIGRATION = read('../prisma/migrations/20260924140000_online_wechat_shipping_sync/migration.sql')
const ROLLBACK = read('../prisma/rollbacks/20260924140000_online_wechat_shipping_sync.rollback.sql')

const SETTLEMENT = 'os-' + 'd'.repeat(64)

/** 只建 FK 需要的最小前置对象；绝不引用任何真实库。 */
const PREREQUISITES = `
CREATE TABLE online_settlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
);
CREATE TABLE online_fulfillment_authorizations (id TEXT PRIMARY KEY, settlement_id TEXT NOT NULL UNIQUE);
INSERT INTO online_settlements (id, user_id, quote_id) VALUES ('${SETTLEMENT}', 'u1', 'q1');
INSERT INTO online_fulfillment_authorizations VALUES ('ofa-1', '${SETTLEMENT}');
`

const INSERT = `
INSERT INTO online_wechat_shipping_sync
  (id, settlement_id, authorization_id, delivery_id, tracking_no, upload_time, payload_fingerprint)
VALUES ('owss-1', '${SETTLEMENT}', 'ofa-1', 'YD', 'YD1234567890', '2026-09-24T02:05:06.789Z', 'fp-1')
`

async function freshDb() {
  const db = new PGlite()
  await db.exec(PREREQUISITES)
  await db.exec(MIGRATION)
  return db
}

test('MIG-01: the forward migration applies on a real PostgreSQL catalog and is additive', async () => {
  const db = await freshDb()
  const columns = await db.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_name = 'online_wechat_shipping_sync'
    ORDER BY ordinal_position`)
  const names = columns.rows.map(r => r.column_name)
  for (const expected of ['id', 'settlement_id', 'authorization_id', 'status', 'delivery_id', 'tracking_no',
    'upload_time', 'payload_fingerprint', 'attempts', 'verify_attempts', 'reupload_count', 'available_at',
    'lease_until', 'lease_owner', 'last_error', 'upload_accepted_at', 'verified_at', 'created_at', 'updated_at']) {
    assert.ok(names.includes(expected), `缺列 ${expected}`)
  }
  assert.equal(columns.rows.find(r => r.column_name === 'status').column_default, "'PENDING_UPLOAD'::text")
  assert.equal(columns.rows.find(r => r.column_name === 'attempts').column_default, '0')
  assert.equal(columns.rows.find(r => r.column_name === 'verify_attempts').column_default, '0')
  assert.equal(columns.rows.find(r => r.column_name === 'reupload_count').column_default, '0',
    '重传预算必须默认 0（首次 upload 不计入）')

  // 加法式：既有表一列未动
  const legacy = await db.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'online_settlements' ORDER BY ordinal_position`)
  assert.deepEqual(legacy.rows.map(r => r.column_name), ['id', 'user_id', 'quote_id', 'status'])

  const index = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'online_wechat_shipping_sync'`)
  assert.ok(index.rows.some(r => r.indexname === 'online_wechat_shipping_sync_status_available_at_idx'))
  await db.close()
})

test('MIG-02: a valid shipment is accepted with the documented defaults', async () => {
  const db = await freshDb()
  await db.exec(INSERT)
  const row = await db.query(`SELECT * FROM online_wechat_shipping_sync WHERE id = 'owss-1'`)
  assert.equal(row.rows.length, 1)
  assert.equal(row.rows[0].status, 'PENDING_UPLOAD')
  assert.equal(row.rows[0].attempts, 0)
  assert.equal(row.rows[0].verify_attempts, 0)
  assert.equal(row.rows[0].reupload_count, 0)
  assert.equal(row.rows[0].verified_at, null)
  assert.equal(row.rows[0].upload_accepted_at, null)
  assert.equal(row.rows[0].delivery_id, 'YD', '必须是微信官方编码，不是页面码 YUNDA')
  await db.close()
})

test('MIG-03: the status enum, counters and length guards are enforced by the database', async () => {
  const db = await freshDb()
  const INSERT_SQL = `INSERT INTO online_wechat_shipping_sync
    (id, settlement_id, authorization_id, status, delivery_id, tracking_no, upload_time,
     payload_fingerprint, attempts, verify_attempts, reupload_count)
    VALUES ($1, $2, 'ofa-1', $3, $4, $5, '2026-09-24T02:05:06.789Z', 'fp', $6, $7, $8)`
  const insert = over => {
    const v = {
      id: 'x', settlementId: SETTLEMENT, status: 'PENDING_UPLOAD', deliveryId: 'SF',
      trackingNo: 'SF1', attempts: 0, verifyAttempts: 0, reuploadCount: 0, ...over,
    }
    return db.query(INSERT_SQL, [v.id, v.settlementId, v.status, v.deliveryId, v.trackingNo,
      v.attempts, v.verifyAttempts, v.reuploadCount])
  }

  await assert.rejects(() => insert({ status: 'NOPE' }), /online_wechat_shipping_sync_status_check/)
  await assert.rejects(() => insert({ attempts: -1 }), /attempts/)
  await assert.rejects(() => insert({ verifyAttempts: -1 }), /verify_attempts/)
  // 重传预算的数据库上限：只能 0 或 1
  await assert.rejects(() => insert({ reuploadCount: 2 }), /reupload_count/)
  await assert.rejects(() => insert({ reuploadCount: -1 }), /reupload_count/)
  await assert.rejects(() => insert({ deliveryId: '' }), /delivery_id/)
  await assert.rejects(() => insert({ trackingNo: 'x'.repeat(129) }), /tracking_no/)
  // 唯一：一个 settlement 只能有一行
  await insert({ id: 'a' })
  await assert.rejects(() => insert({ id: 'b' }), /settlement_id|unique/i)
  // FK：不存在的结算单不允许登记
  await assert.rejects(() => insert({ id: 'c', settlementId: 'os-unknown' }), /foreign key|violates/i)
  await db.close()
})

test('MIG-04: SYNCED and verified_at can never drift apart', async () => {
  const db = await freshDb()
  await db.exec(INSERT)
  await assert.rejects(
    () => db.exec(`UPDATE online_wechat_shipping_sync SET status='SYNCED' WHERE id='owss-1'`),
    /online_wechat_shipping_sync_check/)
  await assert.rejects(
    () => db.exec(`UPDATE online_wechat_shipping_sync SET verified_at=now() WHERE id='owss-1'`),
    /online_wechat_shipping_sync_check/)
  await db.exec(`UPDATE online_wechat_shipping_sync SET status='SYNCED', verified_at=now() WHERE id='owss-1'`)
  const row = await db.query(`SELECT status, verified_at FROM online_wechat_shipping_sync WHERE id='owss-1'`)
  assert.equal(row.rows[0].status, 'SYNCED')
  assert.notEqual(row.rows[0].verified_at, null)
  await db.close()
})

test('MIG-05: once WeChat accepted the upload the payload can never be rewritten', async () => {
  const db = await freshDb()
  await db.exec(INSERT)
  // 还没被接受时允许修正（正常重试路径会改 lease / last_error）
  await db.exec(`UPDATE online_wechat_shipping_sync SET last_error='SHIPPING_UPLOAD_RETRY_-1' WHERE id='owss-1'`)
  await db.exec(`UPDATE online_wechat_shipping_sync SET upload_accepted_at=now(), status='PENDING_VERIFY' WHERE id='owss-1'`)

  for (const mutation of [
    `SET tracking_no='SF999'`,
    `SET delivery_id='YTO'`,
    `SET payload_fingerprint='fp-2'`,
    `SET upload_time='2026-09-24T03:00:00.000Z'`,
  ]) {
    await assert.rejects(
      () => db.exec(`UPDATE online_wechat_shipping_sync ${mutation} WHERE id='owss-1'`),
      /ONLINE_WECHAT_SHIPPING_PAYLOAD_IMMUTABLE/, `${mutation} 必须被触发器拦下`)
  }
  // 租约/状态/错误码/重传预算仍可推进 —— 触发器只钉 payload 本身
  await db.exec(`UPDATE online_wechat_shipping_sync SET lease_owner='w1', lease_until=now(), last_error=NULL WHERE id='owss-1'`)
  await db.exec(`UPDATE online_wechat_shipping_sync SET reupload_count=1 WHERE id='owss-1'`)
  const budget = await db.query(`SELECT reupload_count FROM online_wechat_shipping_sync WHERE id='owss-1'`)
  assert.equal(budget.rows[0].reupload_count, 1, 'payload 不可改写，但重传预算必须还能记')
  await assert.rejects(
    () => db.exec(`UPDATE online_wechat_shipping_sync SET reupload_count=2 WHERE id='owss-1'`),
    /reupload_count/, '重传预算的上限由数据库兜住')
  await db.exec(`UPDATE online_wechat_shipping_sync SET status='SYNCED', verified_at=now(), lease_owner=NULL WHERE id='owss-1'`)
  const row = await db.query(`SELECT status, tracking_no, delivery_id FROM online_wechat_shipping_sync WHERE id='owss-1'`)
  assert.deepEqual(row.rows[0], { status: 'SYNCED', tracking_no: 'YD1234567890', delivery_id: 'YD' })
  await db.close()
})

test('MIG-06: the rollback removes everything the migration created and nothing else', async () => {
  const db = await freshDb()
  await db.exec(INSERT)
  await db.exec(ROLLBACK)
  const gone = await db.query(`
    SELECT to_regclass('public.online_wechat_shipping_sync') AS t,
           to_regclass('public.online_wechat_shipping_sync_status_available_at_idx') AS i`)
  assert.equal(gone.rows[0].t, null)
  assert.equal(gone.rows[0].i, null)
  const fn = await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname='online_wechat_shipping_payload_immutable'`)
  assert.equal(fn.rows[0].n, 0)
  // 前置对象与它们的行完好无损
  const legacy = await db.query(`SELECT count(*)::int AS n FROM online_settlements`)
  assert.equal(legacy.rows[0].n, 1)
  const auth = await db.query(`SELECT count(*)::int AS n FROM online_fulfillment_authorizations`)
  assert.equal(auth.rows[0].n, 1)
  // 可重复执行（幂等回滚）
  await db.exec(ROLLBACK)
  await db.close()
})
