// Release adapter only. No production invocation is permitted by this file.
// The controller supplies the exact reviewed plan on stdin after a verified backup.
import crypto from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'
import { appendProductSkuAudit } from '../server/product-sku-authority.js'

const mode = process.argv[2]
const db = new PrismaClient()
const DATABASE = 'budu_bj006'
const target = new URL(process.env.DATABASE_URL || '')
const targetDb = decodeURIComponent(target.pathname.slice(1))
const testOnly = process.env.SKU_RELEASE_TEST_ONLY === 'YES' &&
  ['localhost','127.0.0.1','::1'].includes(target.hostname) &&
  /^sku_authority_test_[a-z0-9_]+$/.test(targetDb)
const EXPECTED = { total: 178, BD: 89, TP: 89, missingOldSku: 33, aliases: 145 }
// Gate 7 read-only authoritative extract. Any legitimate production change
// requires a new reviewed baseline before this release may proceed.
const PINNED_MAPPING_DIGEST = 'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92'
const PINNED_ONLINE_DIGEST = '8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86'
const select = { id: true, name: true, sku: true, category: true, createdAt: true,
  isActive: true, transferCode: true, productCategory: { select: { name: true } } }
const onlineSelect = { id: true, namespace: true, externalProductId: true,
  externalSkuId: true, productId: true, enabled: true }
const historyQueries = [
  `SELECT id, product_id, sku_snapshot, product_name_snapshot FROM order_items ORDER BY id`,
  `SELECT id, "itemId", "itemCodeSnapshot", "itemNameSnapshot" FROM "TransferItem" ORDER BY id`,
  `SELECT id, "productId", "productCodeSnapshot", "productNameSnapshot" FROM "PartnerSupplyItem" ORDER BY id`,
  `SELECT id, "inventoryItemId", "skuSnapshot", "productCodeSnapshot", "productNameSnapshot" FROM "ReplenishmentOrderItem" ORDER BY id`,
]

function assert(ok, code) { if (!ok) throw Error(code) }
function stable(value) { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item) }
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex') }
async function snapshot(tx) {
  const [products, online] = await Promise.all([
    tx.inventoryItem.findMany({ where: { category: 'product' }, select, orderBy: { id: 'asc' } }),
    tx.onlineProductPolicy.findMany({ select: onlineSelect, orderBy: { id: 'asc' } }),
  ])
  const historical = []
  for (const sql of historyQueries) historical.push((await tx.$queryRawUnsafe(sql))
    .map(row => ({ id: row.id, digest: hash(row) })))
  return { products, online, historical }
}
function preservedRows(before, after) {
  return before.every((rows, index) => {
    const current = new Map(after[index].map(row => [row.id, row.digest]))
    return rows.every(row => current.get(row.id) === row.digest)
  })
}
function preservedOnline(before, after) {
  const identity = row => row && [row.id,row.namespace,row.externalProductId,
    row.externalSkuId,row.productId]
  const current = new Map(after.map(row => [row.id, identity(row)]))
  return before.every(row => stable(current.get(row.id)) === stable(identity(row)))
}
function countsEqual(counts) { return stable(counts) === stable(EXPECTED) }
function onlineIdentityDigest(rows) { return hash(rows.map(row => [row.id, row.namespace,
  row.externalProductId, row.externalSkuId, row.productId, row.enabled])) }
function verifyPlan(plan) {
  assert(countsEqual(plan.counts), 'SKU_RELEASE_COUNTS_DRIFT')
  assert(/^[0-9a-f]{64}$/.test(plan.sha256), 'SKU_RELEASE_DIGEST_INVALID')
  if (!testOnly) assert(hash(plan.mapping) === PINNED_MAPPING_DIGEST,
    'SKU_RELEASE_MAPPING_BASELINE_DRIFT')
  assert(plan.mapping.length === 178 && new Set(plan.mapping.map(row => row.id)).size === 178,
    'SKU_RELEASE_IDENTITY_DRIFT')
}
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
async function main() {
  assert(['plan', 'apply', 'reconcile'].includes(mode), 'SKU_RELEASE_MODE_INVALID')
  assert(process.env.SKU_RELEASE_CONTROLLER === 'sku-authority-schema1', 'SKU_RELEASE_CONTROLLER_REQUIRED')
  assert(targetDb === DATABASE || testOnly, 'SKU_RELEASE_DATABASE_MISMATCH')
  const [{ name }] = await db.$queryRaw`SELECT current_database() AS name`
  assert(name === targetDb, 'SKU_RELEASE_DATABASE_MISMATCH')
  if (mode === 'plan') {
    const state = await db.$transaction(async tx => ({
      ...await snapshot(tx),
      channelFlags: await tx.inventoryItem.findMany({ where: { category: 'product' },
        select: { id: true, isActive: true, transferEnabled: true,
          partnerSupplyEnabled: true, partnerReplenishmentEnabled: true },
        orderBy: { id: 'asc' } }),
    }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    assert(state.online.length === 153, 'SKU_RELEASE_ONLINE_DRIFT')
    assert(state.products.filter(row => row.isActive).length === 87,
      'SKU_RELEASE_POS_ACTIVE_DRIFT')
    assert(state.channelFlags.length === state.products.length &&
      state.channelFlags.every((row, index) => row.id === state.products[index].id &&
        row.isActive === state.products[index].isActive), 'SKU_RELEASE_CHANNEL_ID_DRIFT')
    const anyChannelEnabled = state.channelFlags.filter(row => row.isActive ||
      row.transferEnabled || row.partnerSupplyEnabled ||
      row.partnerReplenishmentEnabled).length
    assert(anyChannelEnabled === 113, 'SKU_RELEASE_ANY_CHANNEL_DRIFT')
    assert(testOnly || onlineIdentityDigest(state.online) === PINNED_ONLINE_DIGEST,
      'SKU_RELEASE_ONLINE_DRIFT')
    const plan = buildProductSkuPlan(state.products, { actorUserId: 'sku-authority-release',
      reason: 'SKU Authority 1.0 reviewed historical allocation',
      snapshotId: hash({ products: state.products, online: state.online }), expectedCount: 178 })
    verifyPlan(plan)
    const channelDigest = hash(state.channelFlags.map(row => [row.id, row.isActive,
      row.transferEnabled, row.partnerSupplyEnabled,
      row.partnerReplenishmentEnabled]))
    process.stdout.write(stable({ plan, online: state.online, historical: state.historical,
      anyChannelEnabled, channelDigest }) + '\n')
    return
  }
  const approved = await readStdin()
  verifyPlan(approved.plan)
  if (mode === 'apply') {
    assert(process.env.SKU_RELEASE_WRITE_AUTHORIZED === process.env.GIT_SHA &&
      /^[0-9a-f]{40}$/.test(process.env.GIT_SHA || ''), 'SKU_RELEASE_WRITE_AUTHORIZATION_REQUIRED')
    const result = await db.$transaction(async tx => {
      const locks = await tx.$queryRaw`SELECT prefix, next_value FROM product_sku_sequences ORDER BY prefix FOR UPDATE`
      assert(locks.length === 2 && locks.every(row => row.next_value === 1), 'SKU_RELEASE_SEQUENCE_DRIFT')
      assert(await tx.productSkuAssignment.count() === 0 && await tx.productSkuAlias.count() === 0,
        'SKU_RELEASE_ALREADY_APPLIED')
      const before = await snapshot(tx)
      const current = buildProductSkuPlan(before.products, { actorUserId: approved.plan.actorUserId,
        reason: approved.plan.reason, snapshotId: approved.plan.snapshotId, expectedCount: 178 })
      assert(stable(current) === stable(approved.plan), 'SKU_RELEASE_MAPPING_DIGEST_DRIFT')
      assert(stable(before.online) === stable(approved.online) &&
        stable(before.historical) === stable(approved.historical), 'SKU_RELEASE_SNAPSHOT_DRIFT')
      for (const row of current.mapping) {
        const changed = await tx.inventoryItem.updateMany({ where: { id: row.id,
          category: 'product', sku: row.oldSku, name: row.name,
          createdAt: new Date(row.createdAt), isActive: row.isActive,
          transferCode: row.transferCodeBefore },
          data: { sku: row.newSku, version: { increment: 1 } } })
        assert(changed.count === 1, 'SKU_RELEASE_ITEM_DRIFT')
        await tx.productSkuAssignment.create({ data: { sku: row.newSku, itemId: row.id,
          oldSku: row.oldSku, actorUserId: current.actorUserId, reason: current.reason } })
        if (row.alias) await tx.productSkuAlias.create({ data: { alias: row.alias, itemId: row.id,
          actorUserId: current.actorUserId, reason: current.reason } })
        await appendProductSkuAudit(tx, { itemId: row.id, sku: row.newSku,
          oldSku: row.oldSku, user: { id: current.actorUserId, username: current.actorUserId },
          reason: current.reason })
      }
      for (const prefix of ['BD', 'TP']) await tx.productSkuSequence.update({
        where: { prefix }, data: { nextValue: current.counts[prefix] + 1 } })
      const after = await snapshot(tx)
      assert(stable(before.products.map(row => row.id).sort()) ===
        stable(after.products.map(row => row.id).sort()), 'SKU_RELEASE_IDENTITY_DRIFT')
      assert(stable(before.online) === stable(after.online) &&
        stable(before.historical) === stable(after.historical), 'SKU_RELEASE_HISTORICAL_DRIFT')
      return { digest: current.sha256, counts: current.counts }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 120000 })
    process.stdout.write(stable(result) + '\n')
    return
  }
  const [state, assignments, aliases, sequences] = await Promise.all([
    db.$transaction(snapshot, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
    db.productSkuAssignment.findMany({ select: { sku: true, itemId: true }, orderBy: { sku: 'asc' } }),
    db.productSkuAlias.findMany({ select: { alias: true, itemId: true }, orderBy: { alias: 'asc' } }),
    db.productSkuSequence.findMany({ orderBy: { prefix: 'asc' } }),
  ])
  const postCutover = process.env.SKU_RELEASE_PHASE === 'POST_CUTOVER'
  assert(state.products.length >= 178 && state.online.length >= 153 &&
    assignments.length >= 178 && aliases.length >= 145, 'SKU_RELEASE_RECONCILIATION_FAILED')
  if (!postCutover) assert(state.products.length === 178 && state.online.length === 153 &&
    assignments.length === 178 && aliases.length === 145, 'SKU_RELEASE_RECONCILIATION_FAILED')
  assert(preservedOnline(approved.online, state.online) &&
    preservedRows(approved.historical, state.historical), 'SKU_RELEASE_HISTORICAL_DRIFT')
  if (!postCutover) assert(stable(state.products.map(row => row.id).sort()) ===
    stable(approved.plan.mapping.map(row => row.id).sort()), 'SKU_RELEASE_IDENTITY_DRIFT')
  const byId = new Map(state.products.map(row => [row.id, row]))
  assert(approved.plan.mapping.every(row => byId.get(row.id)?.sku === row.newSku &&
    assignments.some(a => a.itemId === row.id && a.sku === row.newSku)), 'SKU_RELEASE_ASSIGNMENT_MISMATCH')
  assert(approved.plan.mapping.filter(row => row.alias).every(row =>
    aliases.some(a => a.itemId === row.id && a.alias === row.alias)), 'SKU_RELEASE_ALIAS_MISMATCH')
  assert(assignments.length === state.products.length &&
    state.products.every(row => assignments.some(a => a.itemId === row.id && a.sku === row.sku)) &&
    state.products.every(row => /^(BD|TP)-\d{6}$/.test(row.sku || '')),
    'SKU_RELEASE_ORPHAN_PRODUCT')
  const highWater = { BD: 0, TP: 0 }
  for (const row of assignments) {
    const match = /^(BD|TP)-(\d{6})$/.exec(row.sku)
    assert(match, 'SKU_RELEASE_ASSIGNMENT_FORMAT_INVALID')
    highWater[match[1]] = Math.max(highWater[match[1]],Number(match[2]))
  }
  assert(sequences.length === 2 && sequences.every(row =>
    postCutover ? row.nextValue >= Math.max(90,highWater[row.prefix]+1) :
      row.nextValue === 90),
    'SKU_RELEASE_SEQUENCE_MISMATCH')
  process.stdout.write(stable({ result: 'PASS', digest: approved.plan.sha256,
    products: state.products.length, assignments: assignments.length,
    aliases: aliases.length, online: state.online.length, orphan: 0 }) + '\n')
}

try { await main() } catch (error) {
  process.stderr.write((/^SKU_RELEASE_[A-Z_]+$/.test(error.message) ? error.message :
    'SKU_RELEASE_FAILED_DETAILS_SUPPRESSED') + '\n')
  process.exitCode = 1
} finally { await db.$disconnect() }
