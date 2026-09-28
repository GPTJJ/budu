// Diagnostic stdin program. All business objects remain in container memory.
import crypto from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { buildProductSkuPlan } from '/app/server/product-sku-plan.js'

const stable = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? item.toString() : item)
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex')
const pinnedMapping = 'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92'
const pinnedSnapshot = '2b26de9d9563ff7af08393662089be9bd57bca439d835bebd8ba48cb2cb57c41'
const out = { result: 'GATE_8H_BLOCKED', readonlyGuard: 'FAIL', rootCause: 'NOT_YET_ISOLATED' }
const db = new PrismaClient()
function requireValue(ok, code) { if (!ok) throw Error(code) }

try {
  const [database] = await db.$queryRaw`SELECT current_database() AS name`
  const [defaults] = await db.$queryRawUnsafe('SHOW default_transaction_read_only')
  const [session] = await db.$queryRawUnsafe('SHOW transaction_read_only')
  requireValue(database.name === 'budu_bj006' &&
    defaults.default_transaction_read_only === 'on' && session.transaction_read_only === 'on',
  'READONLY_GUARD_FAILED')
  out.readonlyGuard = 'PASS'
  const select = { id: true, name: true, sku: true, category: true, createdAt: true,
    isActive: true, transferCode: true, productCategory: { select: { name: true } } }
  const onlineSelect = { id: true, namespace: true, externalProductId: true,
    externalSkuId: true, productId: true, enabled: true }
  const { products, online } = await db.$transaction(async tx => {
    const [guard] = await tx.$queryRawUnsafe('SHOW transaction_read_only')
    requireValue(guard.transaction_read_only === 'on', 'TRANSACTION_READONLY_GUARD_FAILED')
    const [products, online] = await Promise.all([
      tx.inventoryItem.findMany({ where: { category: 'product' }, select, orderBy: { id: 'asc' } }),
      tx.onlineProductPolicy.findMany({ select: onlineSelect, orderBy: { id: 'asc' } }),
    ])
    return { products, online }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  out.productCount = products.length
  out.onlineCount = online.length
  requireValue(products.length === 178 && online.length === 153, 'SNAPSHOT_COUNTS_DRIFT')
  out.snapshotId = hash({ products, online })
  requireValue(out.snapshotId === pinnedSnapshot, 'SNAPSHOT_ID_DRIFT')
  const options = { actorUserId: 'sku-authority-release',
    reason: 'SKU Authority 1.0 reviewed historical allocation',
    snapshotId: out.snapshotId, expectedCount: 178 }
  // All three calls use the unchanged module imported from the exact image.
  const direct = buildProductSkuPlan(products, options)
  const roundtrip = buildProductSkuPlan(JSON.parse(JSON.stringify(products)), options)
  const normalized = buildProductSkuPlan(products.map(row => ({ ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  })), options)
  out.directMappingDigest = hash(direct.mapping)
  out.directPlanSha256 = direct.sha256
  out.roundtripMappingDigest = hash(roundtrip.mapping)
  out.roundtripPlanSha256 = roundtrip.sha256
  out.normalizedDateMappingDigest = hash(normalized.mapping)
  out.fractionalMillisecondProductCount = products.filter(row =>
    row.createdAt instanceof Date && row.createdAt.getUTCMilliseconds() !== 0).length

  const a = new Map(direct.mapping.map(row => [row.id, row]))
  const b = new Map(roundtrip.mapping.map(row => [row.id, row]))
  requireValue(a.size === 178 && b.size === 178 && [...a.keys()].every(id => b.has(id)),
    'MAPPING_IDENTITY_DRIFT')
  const fields = new Set(['createdAt', 'newSku', 'alias', 'prefix', 'classificationBasis',
    'transferCodeBefore', 'transferCodeAfter', 'isActive', 'oldSku'])
  for (const row of [...direct.mapping, ...roundtrip.mapping]) {
    for (const key of Object.keys(row)) fields.add(key)
  }
  const differences = Object.fromEntries([...fields].map(field => [field, 0]))
  let affected = 0
  for (const [id, left] of a) {
    const right = b.get(id)
    let changed = false
    for (const field of fields) {
      if (stable(left[field]) !== stable(right[field])) {
        differences[field]++
        changed = true
      }
    }
    if (changed) affected++
  }
  out.fieldDifferences = differences
  out.createdAtNormalizationDiffCount = differences.createdAt
  out.totalRowsWithAnyDiff = affected
  out.orderDifferenceCount = direct.mapping.filter((row, index) =>
    row.id !== roundtrip.mapping[index].id).length

  // Establish that every changed timestamp is precisely Date string coercion,
  // and that other differences are only serial numbers resulting from ordering.
  const dateLossExact = products.every(row => row.createdAt instanceof Date &&
    a.get(row.id).createdAt === new Date(String(row.createdAt)).toISOString() &&
    b.get(row.id).createdAt === row.createdAt.toISOString())
  const otherFieldsUnchanged = Object.entries(differences).every(([key, count]) =>
    ['createdAt', 'newSku'].includes(key) || count === 0)
  const sortedAndNumbered = mapping => {
    for (const prefix of ['BD', 'TP']) {
      const subset = mapping.filter(row => row.prefix === prefix)
      const expectedOrder = [...subset].sort((x, y) =>
        x.createdAt.localeCompare(y.createdAt) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      if (!subset.every((row, i) => row.id === expectedOrder[i].id &&
          row.newSku === `${prefix}-${String(i + 1).padStart(6, '0')}`)) return false
    }
    return true
  }
  out.dateOnlyExplanation = dateLossExact && otherFieldsUnchanged &&
    sortedAndNumbered(direct.mapping) && sortedAndNumbered(roundtrip.mapping) &&
    differences.createdAt === out.fractionalMillisecondProductCount
  const proven = out.directMappingDigest !== pinnedMapping &&
    out.roundtripMappingDigest === pinnedMapping && out.normalizedDateMappingDigest === pinnedMapping &&
    out.fractionalMillisecondProductCount > 0 && out.createdAtNormalizationDiffCount > 0 &&
    out.dateOnlyExplanation
  out.result = proven ? 'GATE_8H_PASS' : 'GATE_8H_DIAGNOSIS_INCOMPLETE'
  if (proven) out.rootCause = 'CREATED_AT_DATE_STRING_COERCION_PRECISION_LOSS'
} catch (error) {
  const code = String(error?.code || error?.message || '')
  out.safeCode = /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : 'DETAILS_SUPPRESSED'
  out.errorClass = /^[A-Za-z]{1,40}$/.test(error?.name || '') ? error.name : 'UNKNOWN'
} finally {
  try { await db.$disconnect() } catch { out.result = 'GATE_8H_BLOCKED'; out.safeCode = 'DISCONNECT_FAILED' }
  process.stdout.write(JSON.stringify(out) + '\n')
  if (out.result !== 'GATE_8H_PASS') process.exitCode = 1
}
