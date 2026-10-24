// Incremental migration + backup/restore verification. Synthetic fixtures only;
// no production URL, file, account or delivery is accepted by this test.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pgBin = '/opt/homebrew/opt/postgresql@16/bin'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const uid = () => crypto.randomUUID()
const migration = '20261024120000_offline_store_services'
const baselineRef = process.env.OFFLINE_SERVICE_BASELINE_REF || 'a86e1507a91b0c79140d962aad3b5c5ea4782497'
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, stdio: 'pipe', timeout: 180000, ...options })

test('90 -> 91 additive migration preserves historical facts; pg_dump/restore preserves new ownership and outbox', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-offline-migration-'))
  fs.chmodSync(temp, 0o700)
  const sourceUrl = await createDisposablePgDatabase('offline_migrate', { applyMigrations: false })
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ datasources: { db: { url: sourceUrl } } })
  let restoredUrl, restored
  try {
    const baselineRoot = path.join(temp, 'baseline')
    fs.mkdirSync(baselineRoot)
    const tarPath = path.join(temp, 'baseline.tar')
    // Keep the exact observed baseline after the task's implementation is
    // committed; do not rename a shared working-tree migration while tests run.
    run('git', ['archive', '--format=tar', '--output=' + tarPath, baselineRef, 'prisma'])
    run('tar', ['-xf', tarPath, '-C', baselineRoot])
    assert.equal(fs.existsSync(path.join(baselineRoot, 'prisma/migrations', migration)), false, 'the selected baseline must predate the feature')
    const migrations = fs.readdirSync(path.join(baselineRoot, 'prisma/migrations')).filter(name => fs.existsSync(path.join(baselineRoot, 'prisma/migrations', name, 'migration.sql')))
    assert.equal(migrations.length, 90, 'revalidate the exact baseline if its migration ledger changes')
    run(path.join(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', path.join(baselineRoot, 'prisma/schema.prisma')], { env: { ...process.env, DATABASE_URL: sourceUrl } })
    const baselineLedger = await db.$queryRawUnsafe('SELECT count(*)::int AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    assert.equal(baselineLedger[0].applied, 90)

    const developer = { id: 'migration-developer', username: 'migration-developer', role: 'developer', status: 'active', storeKeys: [], permissions: {} }
    await db.user.create({ data: { ...developer, passwordHash: 'synthetic-no-login' } })
    await db.store.create({ data: { key: 'migration-store', name: '合成迁移测试门店', active: true } })
    await db.invoice.create({ data: { id: 'legacy-invoice-done', storeKey: 'migration-store', status: 'done', companyName: '合成历史发票', email: 'synthetic@example.invalid', amountCents: 1200n } })
    await db.mailingRecord.create({ data: { id: 'legacy-h5-mailing', storeKey: 'migration-store', method: '顺丰邮寄', postage: '包邮',
      recipient: '合成收件人', phone: '13800000000', address: '合成测试地址', status: 'pending' } })
    const oldTime = new Date('2026-10-01T00:00:00Z'), future = new Date(Date.now() + 3600000)
    for (const [id, type, linked, status] of [
      ['legacy-invoice-request', 'INVOICE', 'legacy-invoice-done', 'SUBMITTED'],
      ['legacy-h5-request', 'MAILING', 'legacy-h5-mailing', 'SUBMITTED'],
      ['legacy-unconsumed-request', 'INVOICE', null, 'WAITING_CUSTOMER'],
    ]) {
      await db.$executeRawUnsafe(`INSERT INTO customer_service_requests
        (id,type,store_key,created_by_user_id,created_by_username,handler_username,status,expires_at,submitted_at,linked_business_record_id,request_metadata)
        VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10::jsonb)`, id, type, 'migration-store', developer.id, developer.username,
        status, future, status === 'SUBMITTED' ? oldTime : null, linked,
        JSON.stringify(type === 'INVOICE' ? { amountCents: 1200, category: '食品' } : { method: '顺丰邮寄', postage: '包邮' }))
      await db.$executeRawUnsafe(`INSERT INTO customer_service_request_tokens (id,request_id,token_hash,status,expires_at,consumed_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, 'token-' + id, id, digest('synthetic-' + id), status === 'SUBMITTED' ? 'CONSUMED' : 'ACTIVE', future, status === 'SUBMITTED' ? oldTime : null)
    }
    async function legacySnapshot() {
      const requests = await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb)::text AS value FROM
        (SELECT id,type,store_key,created_by_user_id,created_by_username,handler_username,status,expires_at,submitted_at,cancelled_at,
        linked_business_record_id,request_metadata,created_at,updated_at FROM customer_service_requests WHERE id LIKE 'legacy-%') r`)
      const tokens = await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text AS value FROM
        (SELECT id,request_id,token_hash,status,expires_at,consumed_at,invalidated_at,created_at FROM customer_service_request_tokens WHERE request_id LIKE 'legacy-%') t`)
      const invoice = await db.$queryRawUnsafe(`SELECT to_jsonb(i)::text AS value FROM "Invoice" i WHERE id='legacy-invoice-done'`)
      const mailing = await db.$queryRawUnsafe(`SELECT to_jsonb(m)::text AS value FROM "MailingRecord" m WHERE id='legacy-h5-mailing'`)
      return digest(JSON.stringify([requests, tokens, invoice, mailing]))
    }
    const beforeMigration = await legacySnapshot()
    run(path.join(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: sourceUrl } })
    assert.equal(await legacySnapshot(), beforeMigration, 'all historical states, fields and original timestamps survive unchanged')
    const historical = await db.customerServiceRequest.findMany({ where: { id: { startsWith: 'legacy-' } } })
    assert.equal(historical.length, 3)
    assert.ok(historical.every(r => r.customerUserId === null && r.customerAppId === null && r.customerEnvId === null && r.customerOpenId === null
      && r.receiptConfirmedAt === null && r.shipmentConfirmedAt === null))
    assert.equal((await db.invoice.findUnique({ where: { id: 'legacy-invoice-done' } })).status, 'done')
    assert.equal(await db.customerServiceRequestToken.count({ where: { miniSceneHash: { not: null } } }), 0)
    const ledger = await db.$queryRawUnsafe('SELECT count(*)::int AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    assert.equal(ledger[0].applied, 91)

    process.env.DATABASE_URL = sourceUrl
    process.env.NODE_ENV = 'test'
    globalThis.__buduPrisma = db
    const { createCustomerServiceRequest, submitCustomerServiceRequest } = await import('../server/customer-requests.js')
    const { confirmService, recordServiceVisit } = await import('../server/store-service-core.js')
    const customer = { userId: 'migration-customer', appId: 'wx0123456789abcdef', envId: 'synthetic-migration', openId: 'synthetic-migration-openid' }
    await db.user.create({ data: { id: customer.userId, username: customer.userId, passwordHash: 'synthetic-no-login', role: 'customer' } })
    await db.weChatAuthIdentity.create({ data: { id: uid(), provider: 'WECHAT_MINIPROGRAM', appId: customer.appId, openId: customer.openId, userId: customer.userId } })
    const created = await createCustomerServiceRequest({ prismaClient: db, user: developer, origin: 'https://synthetic.example.invalid', input: {
      type: 'MAILING', storeKey: 'migration-store', method: '顺丰邮寄', postage: '包邮', shippingTier: 'STANDARD',
    } })
    const scene = crypto.randomBytes(16).toString('hex')
    await db.customerServiceRequestToken.updateMany({ where: { requestId: created.request.id }, data: { miniSceneHash: digest(scene) } })
    await submitCustomerServiceRequest({ prismaClient: db, miniScene: scene, customerIdentity: customer, deliverInternal: false,
      payload: { recipient: '合成收件人', phone: '13800000000', address: '合成迁移验证地址', confirmedAccurate: true } })
    await confirmService(db, { requestId: created.request.id, user: developer, action: 'shipment', input: { carrier: '合成快递', trackingNo: 'SYNTHETIC123' } })
    await recordServiceVisit(db, created.request, customer, 'MALL')
    assert.equal(await legacySnapshot(), beforeMigration, 'new operations do not claim or rewrite prior H5 records')

    const tables = ['Store', 'User', 'Invoice', 'InvoiceCompany', 'MailingRecord', 'customer_service_requests', 'customer_service_request_tokens',
      'wechat_auth_identities', 'store_service_audits', 'store_service_deliveries', 'store_service_visits', 'notifications', 'notification_deliveries', '_prisma_migrations']
    async function snapshot(connection) {
      const summary = {}
      for (const table of tables) {
        const key = table === 'Store' ? 'key' : 'id'
        const [row] = await connection.$queryRawUnsafe(`SELECT count(*)::int AS count, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY "${key}"),'[]'::jsonb)::text AS value FROM "${table}" t`)
        summary[table] = { count: row.count, sha256: digest(row.value) }
      }
      return summary
    }
    const sourceSnapshot = await snapshot(db)
    assert.equal(sourceSnapshot.store_service_deliveries.count, 1)
    assert.equal(sourceSnapshot.store_service_audits.count, 1)
    const dumpPath = path.join(temp, 'synthetic-backup.dump')
    run(path.join(pgBin, 'pg_dump'), ['--dbname', sourceUrl, '--format=custom', '--no-owner', '--no-acl', '--file', dumpPath])
    fs.chmodSync(dumpPath, 0o600)
    assert.ok(fs.statSync(dumpPath).size > 0)
    restoredUrl = await createDisposablePgDatabase('offline_restore', { applyMigrations: false })
    run(path.join(pgBin, 'pg_restore'), ['--dbname', restoredUrl, '--no-owner', '--no-acl', '--exit-on-error', dumpPath])
    restored = new PrismaClient({ datasources: { db: { url: restoredUrl } } })
    const restoredSnapshot = await snapshot(restored)
    assert.deepEqual(restoredSnapshot, sourceSnapshot, 'restored table counts and full-row hashes must be byte-equivalent')
    const recovered = await restored.customerServiceRequest.findUnique({ where: { id: created.request.id } })
    assert.equal(recovered.customerUserId, customer.userId)
    assert.ok(recovered.shipmentConfirmedAt)
    assert.equal((await restored.invoice.findUnique({ where: { id: 'legacy-invoice-done' } })).status, 'done')
    console.log(JSON.stringify({ status: 'PASS', baselineMigrations: 90, candidateMigrations: 91, historicalRequestsPreserved: 3,
      comparedTables: tables.length, requests: sourceSnapshot.customer_service_requests.count, deliveries: 1, audits: 1,
      sourceDigest: digest(JSON.stringify(sourceSnapshot)), restoredDigest: digest(JSON.stringify(restoredSnapshot)), syntheticBackupRestore: true }))
  } finally {
    await restored?.$disconnect()
    await db.$disconnect()
    delete globalThis.__buduPrisma
    if (restoredUrl) await dropDisposablePgDatabase(restoredUrl)
    await dropDisposablePgDatabase(sourceUrl)
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
