// Sent through stdin to the frozen image only when its unmodified plan fails
// without a specific safe code. Emits stage metadata, never business rows.
import crypto from 'node:crypto'

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value,
  (_key, item) => typeof item === 'bigint' ? item.toString() : item)).digest('hex')
const expected = { total: 178, BD: 89, TP: 89, missingOldSku: 33, aliases: 145 }
const mappingDigest = 'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92'
const onlineDigest = '8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86'
const emit = (stage, status, extra = {}) => process.stdout.write(JSON.stringify({ stage, status, ...extra }) + '\n')
let current = 'STAGE_01_URL_PARSE'
let db
let state = {}
let plan
async function run(stage, fn) {
  current = stage
  const started = Date.now()
  const value = await fn()
  emit(stage, 'PASS', { durationMs: Date.now() - started,
    ...(Array.isArray(value) ? { rowCount: value.length } : {}) })
  return value
}
try {
  const target = await run('STAGE_01_URL_PARSE', () => {
    const url = new URL(process.env.DATABASE_URL || '')
    if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
        decodeURIComponent(url.pathname.slice(1)) !== 'budu_bj006') throw Error('URL_INVALID')
    return true
  })
  if (!target) throw Error('URL_INVALID')
  const { Prisma, PrismaClient } = await run('STAGE_02_PRISMA_CLIENT',
    () => import('@prisma/client'))
  db = new PrismaClient()
  await run('STAGE_03_CURRENT_DATABASE', async () => {
    const [row] = await db.$queryRaw`SELECT current_database() AS name, current_setting('transaction_read_only') AS readonly`
    if (row?.name !== 'budu_bj006' || row?.readonly !== 'on') throw Error('DB_GUARD_INVALID')
    return true
  })
  const select = { id: true, name: true, sku: true, category: true, createdAt: true,
    isActive: true, transferCode: true, productCategory: { select: { name: true } } }
  const onlineSelect = { id: true, namespace: true, externalProductId: true,
    externalSkuId: true, productId: true, enabled: true }
  await db.$transaction(async tx => {
  await run('STAGE_04_TRANSACTION_READ_ONLY', async () => {
    const [guard] = await tx.$queryRawUnsafe('SHOW transaction_read_only')
    if (guard?.transaction_read_only !== 'on') throw Error('READ_ONLY_GUARD_FAILED')
    return true
  })
  state.products = await run('STAGE_05_PRODUCTS_QUERY', () => tx.inventoryItem.findMany({
    where: { category: 'product' }, select, orderBy: { id: 'asc' } }))
  state.online = await run('STAGE_06_ONLINE_QUERY', () => tx.onlineProductPolicy.findMany({
    select: onlineSelect, orderBy: { id: 'asc' } }))
  const queries = [
    ['STAGE_07_HISTORY_ORDER_ITEMS', 'SELECT id, product_id, sku_snapshot, product_name_snapshot FROM order_items ORDER BY id'],
    ['STAGE_08_HISTORY_TRANSFER', 'SELECT id, "itemId", "itemCodeSnapshot", "itemNameSnapshot" FROM "TransferItem" ORDER BY id'],
    ['STAGE_09_HISTORY_PARTNER', 'SELECT id, "productId", "productCodeSnapshot", "productNameSnapshot" FROM "PartnerSupplyItem" ORDER BY id'],
    ['STAGE_10_HISTORY_REPLENISHMENT', 'SELECT id, "inventoryItemId", "skuSnapshot", "productCodeSnapshot", "productNameSnapshot" FROM "ReplenishmentOrderItem" ORDER BY id'],
  ]
  state.historical = []
  for (const [stage, sql] of queries) {
    const rows = await run(stage, () => tx.$queryRawUnsafe(sql))
    state.historical.push(rows.map(row => ({ id: row.id, digest: hash(row) })))
  }
  state.channelFlags = await run('STAGE_11_CHANNEL_FLAGS', () => tx.inventoryItem.findMany({
    where: { category: 'product' }, select: { id: true, isActive: true,
      transferEnabled: true, partnerSupplyEnabled: true,
      partnerReplenishmentEnabled: true }, orderBy: { id: 'asc' } }))
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  plan = await run('STAGE_12_PLAN_BUILD', async () => {
    const { buildProductSkuPlan } = await import('/app/server/product-sku-plan.js')
    return buildProductSkuPlan(state.products, {
    actorUserId: 'sku-authority-release',
    reason: 'SKU Authority 1.0 reviewed historical allocation',
    snapshotId: hash({ products: state.products, online: state.online }), expectedCount: 178 })
  })
  await run('STAGE_13_PLAN_COUNTS', () => {
    if (JSON.stringify(plan.counts) !== JSON.stringify(expected)) throw Error('COUNTS_DRIFT')
    return true
  })
  await run('STAGE_14_ONLINE_DIGEST', () => {
    if (hash(state.online.map(row => [row.id, row.namespace, row.externalProductId,
      row.externalSkuId, row.productId, row.enabled])) !== onlineDigest) throw Error('ONLINE_DRIFT')
    return true
  })
  await run('STAGE_15_MAPPING_DIGEST', () => {
    if (hash(plan.mapping) !== mappingDigest) throw Error('MAPPING_DRIFT')
    return true
  })
  await run('STAGE_16_OUTPUT_SERIALIZATION', () => {
    const encoded = JSON.stringify({ plan, online: state.online, historical: state.historical },
      (_key, item) => typeof item === 'bigint' ? item.toString() : item)
    if (!encoded) throw Error('SERIALIZATION_INVALID')
    return true
  })
} catch (error) {
  const code = String(error?.code || error?.message || '')
  emit(current, 'FAIL', { safeCode: /^[A-Z][A-Z0-9_]{0,60}$/.test(code) ? code : 'DETAILS_SUPPRESSED',
    errorClass: /^[A-Za-z]{1,40}$/.test(error?.name || '') ? error.name : 'UNKNOWN' })
  process.exitCode = 1
} finally {
  try { await db?.$disconnect() } catch { process.exitCode = 1 }
}
