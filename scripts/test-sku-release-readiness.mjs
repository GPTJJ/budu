// Offline parity and semantic drift tests against the reviewed Gate 7 extract.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'
import { analyzeSnapshot, validateSnapshot, PINNED } from './sku-release-readiness-plan.mjs'

const fixture = JSON.parse(readFileSync('.github/fixtures/sku-release-gate7-readiness.json','utf8'))
const clone = () => structuredClone(fixture)
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exact = validateSnapshot(fixture)
assert.deepEqual(exact.counts,PINNED.counts)
assert.equal(exact.posActive,87)
assert.equal(exact.anyChannelEnabled,113)
assert.equal(exact.online,153)
assert.equal(exact.mappingDigest,PINNED.mappingDigest)
assert.equal(exact.onlineDigest,PINNED.onlineDigest)
assert.equal(exact.idsDigest,PINNED.idsDigest)
assert.deepEqual(Object.keys(fixture.products[0]),
  ['id','name','sku','category','createdAt','isActive','transferCode','productCategory'])
assert.deepEqual(Object.keys(fixture.channelFlags[0]),
  ['id','isActive','transferEnabled','partnerSupplyEnabled','partnerReplenishmentEnabled'])

const direct = buildProductSkuPlan(fixture.products, {
  actorUserId:'sku-authority-release', reason:'SKU Authority 1.0 reviewed historical allocation',
  snapshotId:exact.snapshotId, expectedCount:178,
})
assert.equal(hash(direct.mapping),exact.mappingDigest)
assert.deepEqual(direct.counts,{ total:178,BD:89,TP:89,missingOldSku:33,aliases:145 })

const wrongPos = clone()
const formerlyOther = wrongPos.channelFlags.filter(row => !row.isActive &&
  (row.transferEnabled || row.partnerSupplyEnabled || row.partnerReplenishmentEnabled))
assert.equal(formerlyOther.length,26)
for (const row of formerlyOther) {
  row.isActive = true
  wrongPos.products.find(product => product.id === row.id).isActive = true
}
assert.equal(analyzeSnapshot(wrongPos).posActive,113)
assert.equal(analyzeSnapshot(wrongPos).anyChannelEnabled,113)
assert.throws(() => validateSnapshot(wrongPos),/SKU_READINESS_POS_ACTIVE_DRIFT/)

const wrongAny = clone()
const otherOnly = wrongAny.channelFlags.find(row => !row.isActive && row.transferEnabled &&
  !row.partnerSupplyEnabled && !row.partnerReplenishmentEnabled)
assert.ok(otherOnly)
otherOnly.transferEnabled = false
assert.equal(analyzeSnapshot(wrongAny).mappingDigest,PINNED.mappingDigest)
assert.throws(() => validateSnapshot(wrongAny),/SKU_READINESS_ANY_CHANNEL_DRIFT/)

const wrongMapping = clone()
wrongMapping.products.find(row => row.sku).sku = 'UNUSED-LEGACY-CODE'
assert.throws(() => validateSnapshot(wrongMapping),/SKU_READINESS_MAPPING_DIGEST_DRIFT/)

const wrongOnline = clone()
wrongOnline.online[0].externalProductId += '-drift'
assert.throws(() => validateSnapshot(wrongOnline),/SKU_READINESS_ONLINE_IDENTITY_DRIFT/)

const wrongCount = clone()
wrongCount.products.pop()
wrongCount.channelFlags.pop()
assert.throws(() => validateSnapshot(wrongCount))

console.log('GATE7_ACTIVE_SEMANTICS=PASS PINNED_MAPPING=PASS PINNED_ONLINE=PASS PLANNER_PARITY=PASS')
