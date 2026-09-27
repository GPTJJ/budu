import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
const migration = fs.readFileSync(new URL('../prisma/migrations/20260829200000_developer_safe_delete/migration.sql', import.meta.url), 'utf8')
const service = fs.readFileSync(new URL('../server/developer-safe-delete.js', import.meta.url), 'utf8')
const v2 = fs.readFileSync(new URL('../server/v2.js', import.meta.url), 'utf8')
const partner = fs.readFileSync(new URL('../server/partner-supply.js', import.meta.url), 'utf8')
const notifications = fs.readFileSync(new URL('../server/notifications.js', import.meta.url), 'utf8')

const types = ['mailing', 'invoice', 'transfer', 'purchase', 'partnerSupply']
const models = ['MailingRecord', 'Invoice', 'TransferRequest', 'PurchaseRequest', 'PartnerSupplyOrder']

test('五个业务域只有 additive 软删除字段且审计独立留存', () => {
  for (const model of models) {
    const body = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] || ''
    assert.match(body, /deletedAt\s+DateTime\?/)
    assert.match(body, /deletedBy\s+String/)
    assert.match(body, /deleteReason\s+String/)
  }
  assert.match(schema, /model SensitiveRecordAudit/)
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i)
})

test('删除和恢复覆盖五类、保持原 ID，并且不记录密码', () => {
  for (const type of types) assert.match(service, new RegExp(`${type}: \\{ delegate:`))
  assert.match(service, /updateMany\(\{ where: \{ id, deletedAt: null \}/)
  assert.match(service, /data: \{ deletedAt: null, deletedBy: '', deleteReason: '' \}/)
  assert.doesNotMatch(service, /reason.*secondPassword|secondPassword.*reason/)
  assert.match(service, /MAX_ATTEMPTS = 5/)
  assert.match(service, /sensitiveLockedUntil/)
})

test('正常列表、导出统计和后续操作排除已删除记录', () => {
  assert.match(v2, /get\('\/transfer-requests'[\s\S]*?const where = \{ deletedAt: null \}/)
  assert.match(v2, /get\('\/purchase-requests'[\s\S]*?const where = \{ deletedAt: null/)
  assert.match(v2, /get\('\/invoices'[\s\S]*?deletedAt: null/)
  assert.match(v2, /get\('\/mailing-records'[\s\S]*?const where = \{ deletedAt: null \}/)
  assert.match(partner, /function scopedOrderWhere[\s\S]*?const where = \{ deletedAt: null \}/)
  assert.match(v2, /已删除调拨不可继续操作/)
  assert.match(v2, /已删除采购申请不可继续操作/)
  assert.match(v2, /已删除发票不可继续操作/)
  assert.match(v2, /已删除邮寄记录不可继续操作/)
  assert.match(partner, /已删除供货单不可继续操作/)
  assert.doesNotMatch(v2, /prisma\.(?:purchaseRequest|invoice)\.delete\(/)
  assert.match(notifications, /excludeDeletedBusinessRecords/)
  for (const refType of ['mailing', 'invoice', 'transfer', 'purchase', 'partner-supply-order']) assert.match(notifications, new RegExp(`'${refType}'`))
})
