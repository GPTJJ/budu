// Offline parity and semantic drift tests against the reviewed Gate 7 extract.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { buildProductSkuPlan } from '../server/product-sku-plan.js'
import { analyzeSnapshot, validateSnapshot, PINNED, buildReleaseProductSkuPlan,
  releaseReadonlyUrl, assertReleaseReadOnly } from './sku-release-readiness-plan.mjs'

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

const metadata = { actorUserId:direct.actorUserId,reason:direct.reason,
  snapshotId:exact.snapshotId,expectedCount:178 }
assert.equal(exact.snapshotId,'2b26de9d9563ff7af08393662089be9bd57bca439d835bebd8ba48cb2cb57c41')
const dates = fixture.products.map(row => ({ ...row, createdAt:new Date(row.createdAt) }))
const oldDatePlan = buildProductSkuPlan(dates,metadata)
assert.equal(hash(oldDatePlan.mapping),'ad26daaccec99864da747ce359297c612224c7e81032139a6db07b7f74936bca')
const oldById = new Map(oldDatePlan.mapping.map(row => [row.id,row]))
assert.equal(direct.mapping.filter(row => row.createdAt !== oldById.get(row.id).createdAt).length,178)
assert.equal(direct.mapping.filter(row => row.newSku !== oldById.get(row.id).newSku).length,71)
for (const products of [dates,JSON.parse(JSON.stringify(dates)),
  dates.map(row => ({ ...row,createdAt:row.createdAt.toISOString() }))]) {
  const plan = buildReleaseProductSkuPlan(products,metadata)
  assert.deepEqual(plan,direct) // Every field, row order, metadata and plan hash.
  assert.equal(hash(plan.mapping),PINNED.mappingDigest)
  assert.equal(plan.sha256,'ae92d20236ca92853216aefe0135344b2a316ff76695a5f4bae16078914b5156')
  assert.deepEqual(validateSnapshot({ ...fixture,products }),exact)
}

const synthetic = [
  ['z','2026-01-01T00:00:00.001Z'], ['a','2026-01-01T00:00:00.999Z'],
  ['c','2026-01-01T00:00:01.000Z'], ['b','2026-01-01T00:00:01.000Z'],
].map(([id,createdAt]) => ({ ...fixture.products[0],id,name:id,sku:null,
  transferCode:null,productCategory:{ name:'糖果' },createdAt }))
const synthMeta = { ...metadata,expectedCount:4 }
const isoPlan = buildReleaseProductSkuPlan(synthetic,synthMeta)
assert.deepEqual(isoPlan.mapping.map(row => row.id),['z','a','b','c'])
const immutableDates = synthetic.map(row => Object.freeze({ ...row,
  createdAt:Object.freeze(new Date(row.createdAt)) }))
assert.notDeepEqual(buildProductSkuPlan(immutableDates,synthMeta),isoPlan)
const before = immutableDates.map(row => row.createdAt.getTime())
assert.deepEqual(buildReleaseProductSkuPlan(immutableDates,synthMeta),isoPlan)
assert.deepEqual(immutableDates.map(row => row.createdAt.getTime()),before)
const offsets = synthetic.map(row => ({ ...row,
  createdAt:row.createdAt.replace('T00:','T08:').replace('Z','+08:00') }))
assert.deepEqual(buildReleaseProductSkuPlan(offsets,synthMeta),isoPlan)
for (const createdAt of [undefined,null,'',new Date(NaN),'invalid','2026-13-01T00:00:00Z',
  '2026-02-30T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00',0])
  assert.throws(() => buildReleaseProductSkuPlan([{ ...synthetic[0],createdAt }],
    { ...metadata,expectedCount:1 }),/SKU_RELEASE_CREATED_AT_INVALID/)

const sourceUrl = new URL('postgresql://user%40name:p%2B%26%23@localhost:5439/test?schema=public&connection_limit=4&options=-c%20default_transaction_read_only%3Doff&options=-c%20temp_file_limit%3D-1')
const guardedUrl = new URL(releaseReadonlyUrl(sourceUrl.toString()))
for (const key of ['protocol','username','password','hostname','port','pathname'])
  assert.equal(guardedUrl[key],sourceUrl[key])
assert.equal(guardedUrl.searchParams.get('schema'),'public')
assert.equal(guardedUrl.searchParams.get('connection_limit'),'4')
assert.deepEqual(guardedUrl.searchParams.getAll('options'),[
  '-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0'])
for (const result of [[],[{}],[{ transaction_read_only:'off' }]])
  await assert.rejects(assertReleaseReadOnly({ $queryRawUnsafe:async () => result }),/SKU_RELEASE_READONLY_GUARD_FAILED/)
await assert.rejects(assertReleaseReadOnly({ $queryRawUnsafe:async () => { throw Error('private') } }),
  /SKU_RELEASE_READONLY_GUARD_FAILED/)
console.log('OLD_DATE_LOSS=178 OLD_SKU_DIFFERENCES=71 FIXED_ROW_DIFFERENCES=0 FULL_PLAN_PARITY=PASS DATE_REGRESSION=PASS URL_OPTIONS_POLICY=PASS')

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
