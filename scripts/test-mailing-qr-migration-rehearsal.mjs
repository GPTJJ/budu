import { copyBeforeMigration, migrationNames, assertMigrationHistory } from './migration-rehearsal-plan.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const migrationName = '20260828160000_mailing_qr_only_shipping_contract'
let testUrl = ''

function migrate(schemaPath) {
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
    timeout: 180000,
  })
}

test('Mailing QR-only additive migration preserves legacy records and old-app rollback reads', async () => {
  testUrl = await createDisposablePgDatabase('mailing_qr_migration', { applyMigrations: false })
  process.env.DATABASE_URL = testUrl
  const { PrismaClient } = await import('@prisma/client')
  const client = new PrismaClient({ datasources: { db: { url: testUrl } } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-mailing-qr-migration-'))
  try {
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(temp, 'schema.prisma'))
    fs.mkdirSync(path.join(temp, 'migrations'))
    copyBeforeMigration(root, temp, migrationName)
    migrate(path.join(temp, 'schema.prisma'))
    await client.$executeRawUnsafe(`
      INSERT INTO "MailingRecord" (id, method, postage, fee, address, recipient, phone, remark, status, "createdBy", "createdAt")
      VALUES ('legacy-mailing', '顺丰邮寄', '不包邮', '生鲜航运30¥', '测试地址1号', '测试顾客', '13800000001', '历史记录', 'pending', 'tester', NOW())
    `)
    const legacyBefore = await client.$queryRawUnsafe(`SELECT id, method, postage, fee, address, recipient, phone, remark, status, "createdBy" FROM "MailingRecord" ORDER BY id`)
    const beforeDigest = crypto.createHash('sha256').update(JSON.stringify(legacyBefore)).digest('hex')

    migrate(path.join(root, 'prisma', 'schema.prisma'))
    await assertMigrationHistory(client, migrationNames(root))
    const legacyAfter = await client.$queryRawUnsafe(`SELECT id, method, postage, fee, address, recipient, phone, remark, status, "createdBy" FROM "MailingRecord" ORDER BY id`)
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(legacyAfter)).digest('hex'), beforeDigest)

    const current = await client.mailingRecord.findUnique({ where: { id: 'legacy-mailing' } })
    assert.equal(current.storeKey, null)
    assert.equal(current.shippingTier, null)
    assert.equal(current.shippingAmountCents, null)
    assert.equal(current.shippingPaymentMode, null)

    // This exact old-column projection is the rollback contract used by the
    // migration48 application. Extra nullable columns do not break it.
    const oldApplicationRead = await client.$queryRawUnsafe(`SELECT id, method, postage, fee, address, recipient, phone, remark, status, "createdBy", "createdAt", "shippedAt" FROM "MailingRecord" WHERE id = 'legacy-mailing'`)
    assert.equal(oldApplicationRead.length, 1)
    assert.equal(oldApplicationRead[0].fee, '生鲜航运30¥')
  } finally {
    await client.$disconnect()
    await dropDisposablePgDatabase(testUrl)
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
