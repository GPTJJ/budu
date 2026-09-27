// GitHub-runner-only analysis of read-only production extracts. Never logs rows.
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const stable = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? item.toString() : item)
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex')
const candidate = process.env.CANDIDATE_DIR
if (!candidate) throw Error('CANDIDATE_DIR_REQUIRED')

if (process.argv[2] === 'history') {
  const rows = input.rows
  if (!Array.isArray(rows)) throw Error('HISTORY_ROWS_INVALID')
  const projection = rows.map(row => ({ id: row.id, digest: hash(row) }))
  const digest = hash(projection)
  const secondPass = hash(JSON.parse(stable(projection)))
  if (digest !== secondPass || digest !== input.originalDigest) {
    throw Error('HISTORY_SERIALIZATION_MISMATCH')
  }
  process.stdout.write(JSON.stringify({ rowCount: rows.length, digest,
    serialization: 'PASS' }) + '\n')
} else if (process.argv[2] === 'snapshot') {
  const { products, online, channelFlags } = input
  const planner = await import(pathToFileURL(candidate + '/server/product-sku-plan.js'))
  const readiness = await import(pathToFileURL(candidate + '/scripts/sku-release-readiness-plan.mjs'))
  const checks = {}
  const check = (name, callback) => {
    try { checks[name] = callback() ? 'PASS' : 'FAIL' }
    catch { checks[name] = 'FAIL' }
  }
  check('ASSERT_ONLINE_COUNT', () => online.length === 153)
  check('ASSERT_POS_ACTIVE', () => products.filter(row => row.isActive).length === 87)
  check('ASSERT_CHANNEL_IDS', () => channelFlags.length === products.length &&
    channelFlags.every((row, index) => row.id === products[index].id &&
      row.isActive === products[index].isActive))
  const anyChannelEnabled = channelFlags.filter(row => row.isActive ||
    row.transferEnabled || row.partnerSupplyEnabled ||
    row.partnerReplenishmentEnabled).length
  check('ASSERT_ANY_CHANNEL', () => anyChannelEnabled === 113)
  const onlineDigest = hash(online.map(row => [row.id, row.namespace,
    row.externalProductId, row.externalSkuId, row.productId, row.enabled]))
  check('ASSERT_ONLINE_DIGEST', () => onlineDigest === readiness.PINNED.onlineDigest)
  const snapshotId = hash({ products, online })
  let plan
  try {
    plan = planner.buildProductSkuPlan(products, {
      actorUserId: 'sku-authority-release',
      reason: 'SKU Authority 1.0 reviewed historical allocation',
      snapshotId, expectedCount: 178,
    })
    checks.ASSERT_PLAN_BUILD = 'PASS'
  } catch { checks.ASSERT_PLAN_BUILD = 'FAIL' }
  check('ASSERT_PLAN_COUNTS', () => stable(plan.counts) === stable(readiness.PINNED.counts))
  const mappingDigest = plan ? hash(plan.mapping) : null
  check('ASSERT_MAPPING_DIGEST', () => mappingDigest === readiness.PINNED.mappingDigest)
  check('ASSERT_MAPPING_IDS', () => plan.mapping.length === 178 &&
    new Set(plan.mapping.map(row => row.id)).size === 178)
  let readinessPlan = 'FAIL'
  try { readiness.validateSnapshot(input); readinessPlan = 'PASS' } catch {}
  process.stdout.write(JSON.stringify({
    productCount: products.length,
    posActive: products.filter(row => row.isActive).length,
    anyChannelEnabled, onlineCount: online.length,
    mappingDigest, onlineDigest, snapshotId,
    channelDigest: hash(channelFlags.map(row => [row.id, row.isActive,
      row.transferEnabled, row.partnerSupplyEnabled,
      row.partnerReplenishmentEnabled])),
    idsDigest: hash([...new Set(products.map(row => row.id))].sort()),
    planCounts: plan?.counts ?? null, readinessPlan, checks,
  }) + '\n')
} else {
  throw Error('AUDIT_MODE_INVALID')
}
