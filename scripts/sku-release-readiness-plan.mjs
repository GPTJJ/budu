// Pure release-readiness projection. Allocation uses the existing SKU planner.
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'

export const PINNED = Object.freeze({
  counts: { total: 178, BD: 89, TP: 89, missingOldSku: 33, aliases: 145 },
  posActive: 87,
  anyChannelEnabled: 113,
  online: 153,
  mappingDigest: 'a939e90b70af125919abbc71ea461b2ec0c37773b0fda8e2da326d02451fab92',
  onlineDigest: '8042665cff559a5110a933e499137399d35cbce88dcb3f356f09825ca5924a86',
  idsDigest: '01971cf47e2ee1c2fcf89059a1e7ec41fb4e661c5404ddcab1bc3841462bc28f',
})

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value,
  (_key, item) => typeof item === 'bigint' ? item.toString() : item)).digest('hex')
const requireValue = (ok, code) => { if (!ok) throw Error(code) }
const channelTuple = row => [row.id, row.isActive, row.transferEnabled,
  row.partnerSupplyEnabled, row.partnerReplenishmentEnabled]
const channelEnabled = row => row.isActive || row.transferEnabled ||
  row.partnerSupplyEnabled || row.partnerReplenishmentEnabled

export function analyzeSnapshot({ products, online, channelFlags }) {
  requireValue(Array.isArray(products) && Array.isArray(online) &&
    Array.isArray(channelFlags), 'SKU_READINESS_SNAPSHOT_INVALID')
  const productIds = new Set(products.map(row => row.id))
  requireValue(productIds.size === products.length &&
    online.every(row => productIds.has(row.productId)) &&
    channelFlags.length === products.length &&
    new Set(channelFlags.map(row => row.id)).size === products.length &&
    channelFlags.every(row => productIds.has(row.id)), 'SKU_READINESS_STABLE_ID_INVALID')
  requireValue(channelFlags.every(row => typeof row.isActive === 'boolean' &&
    typeof row.transferEnabled === 'boolean' &&
    typeof row.partnerSupplyEnabled === 'boolean' &&
    typeof row.partnerReplenishmentEnabled === 'boolean'),
  'SKU_READINESS_CHANNEL_FLAGS_INVALID')
  const snapshotId = hash({ products, online })
  const plan = buildProductSkuPlan(products, { actorUserId: 'sku-authority-release',
    reason: 'SKU Authority 1.0 reviewed historical allocation',
    snapshotId, expectedCount: 178 })
  return {
    counts: plan.counts,
    posActive: products.filter(row => row.isActive).length,
    anyChannelEnabled: channelFlags.filter(channelEnabled).length,
    channelDigest: hash(channelFlags.map(channelTuple)),
    online: online.length,
    mappingDigest: hash(plan.mapping),
    onlineDigest: hash(online.map(row => [row.id, row.namespace,
      row.externalProductId, row.externalSkuId, row.productId, row.enabled])),
    idsDigest: hash([...productIds].sort()),
    snapshotId,
  }
}

export function validateSnapshot(snapshot, expected = PINNED) {
  const actual = analyzeSnapshot(snapshot)
  requireValue(JSON.stringify(actual.counts) === JSON.stringify(expected.counts),
    'SKU_READINESS_MAPPING_COUNTS_DRIFT')
  requireValue(actual.posActive === expected.posActive, 'SKU_READINESS_POS_ACTIVE_DRIFT')
  requireValue(actual.anyChannelEnabled === expected.anyChannelEnabled,
    'SKU_READINESS_ANY_CHANNEL_DRIFT')
  requireValue(actual.online === expected.online, 'SKU_READINESS_ONLINE_COUNT_DRIFT')
  requireValue(actual.mappingDigest === expected.mappingDigest,
    'SKU_READINESS_MAPPING_DIGEST_DRIFT')
  requireValue(actual.onlineDigest === expected.onlineDigest,
    'SKU_READINESS_ONLINE_IDENTITY_DRIFT')
  requireValue(actual.idsDigest === expected.idsDigest, 'SKU_READINESS_STABLE_ID_DRIFT')
  return actual
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const result = validateSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('SKU_READINESS_MAPPING_INVALID\n')
    process.exitCode = 1
  }
}
