// Exact release data adapter on disposable PostgreSQL 16; never production.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { analyzeSnapshot, releaseReadonlyUrl, assertReleaseReadOnly } from './sku-release-readiness-plan.mjs'
import { reserveProductSku, recordProductSkuAssignment, appendProductSkuAudit } from '../server/product-sku-authority.js'

const target = new URL(process.env.DATABASE_URL || '')
assert.ok(['localhost','127.0.0.1'].includes(target.hostname) &&
  /^sku_authority_test_[a-z0-9_]+$/.test(target.pathname.slice(1)))
const db = new PrismaClient()
const sha = process.env.SKU_RELEASE_CANDIDATE_SHA || 'a'.repeat(40)
const env = { ...process.env, SKU_RELEASE_CONTROLLER: 'sku-authority-schema1',
  SKU_RELEASE_TEST_ONLY: 'YES', GIT_SHA: sha }
function adapter(mode, input, extra = {}) {
  const call = spawnSync('node', ['scripts/sku-release-apply.mjs',mode], {
    input, env: { ...env, SKU_RELEASE_READ_ONLY:mode === 'apply' ? '' : 'YES', ...extra }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(call.status,0,call.stderr)
  return JSON.parse(call.stdout)
}
try {
  const [actual] = await db.$queryRaw`SELECT current_database() AS name,
    host(inet_server_addr()) AS host,inet_server_port() AS port`
  assert.equal(actual.name,decodeURIComponent(target.pathname.slice(1)))
  assert.ok(['127.0.0.1','::1'].includes(actual.host))
  assert.equal(actual.port,Number(target.port || 5432))
  const [{ version }] = await db.$queryRaw`SELECT current_setting('server_version_num')::int AS version`
  assert.equal(Math.floor(version / 10000),16)
  for (const [name, expected] of Object.entries({
    product_sku_insert_guard:'72b0205d3f28128edb4020fb7366ab9a59abdb7da124fa817821b4fcf352dd18',
    product_sku_product_guard:'c14176a7265a374395f236476620e076487898b29c5cc33c772eec2564ce014b',
  })) {
    const [row] = await db.$queryRaw`SELECT prosrc FROM pg_proc WHERE proname=${name}
      AND pronamespace='public'::regnamespace`
    assert.equal(crypto.createHash('sha256').update(row.prosrc.trim()).digest('hex'),expected)
  }
  assert.equal(await db.inventoryItem.count({ where: { category: 'product' } }),0)
  const probe = extra => spawnSync('node',['scripts/sku-release-apply.mjs','db-probe'],
    { env:{ ...env,SKU_RELEASE_READ_ONLY:'',PGOPTIONS:'',...extra },encoding:'utf8' })
  const wrong = new URL(target)
  wrong.searchParams.set('options','-c default_transaction_read_only=off')
  for (const extra of [{}, { DATABASE_URL:wrong.toString() },
    { PGOPTIONS:'-c default_transaction_read_only=on' }]) {
    const result=probe(extra)
    assert.equal(result.status,1)
    assert.equal(result.stderr,'SKU_RELEASE_READONLY_GUARD_FAILED\n')
    assert.equal(result.stdout,'')
  }
  for (const mode of ['plan','reconcile']) {
    const result=spawnSync('node',['scripts/sku-release-apply.mjs',mode],
      { env:{ ...env,SKU_RELEASE_READ_ONLY:'',PGOPTIONS:'-c default_transaction_read_only=on' },encoding:'utf8' })
    assert.equal(result.status,1)
    assert.equal(result.stderr,'SKU_RELEASE_READONLY_GUARD_FAILED\n')
    assert.equal(result.stdout,'')
  }
  const malformed=probe({ DATABASE_URL:'invalid-url-with-private-marker' })
  assert.equal(malformed.status,1)
  assert.equal(malformed.stderr,'SKU_RELEASE_FAILED_DETAILS_SUPPRESSED\n')
  const duplicates = new URL(target)
  duplicates.searchParams.append('options','-c default_transaction_read_only=off')
  duplicates.searchParams.append('options','-c default_transaction_read_only=on -c default_transaction_read_only=off')
  const readonlyUrl=releaseReadonlyUrl(duplicates.toString())
  for (const extra of [{ DATABASE_URL:readonlyUrl },
    { DATABASE_URL:duplicates.toString(),SKU_RELEASE_READ_ONLY:'YES' }]) {
    const result=probe(extra)
    assert.equal(result.status,0,result.stderr)
    assert.equal(result.stdout,'DB_READ_OK\n')
  }
  await db.$executeRawUnsafe('CREATE TABLE sku_release_v6_readonly_test (id integer)')
  const readonly = new PrismaClient({ datasources:{ db:{ url:readonlyUrl } } })
  try {
    await assertReleaseReadOnly(readonly,true)
    await readonly.$transaction(async tx => {
      await assertReleaseReadOnly(tx)
      const [limits]=await tx.$queryRaw`SELECT current_setting('statement_timeout') AS timeout,
        current_setting('temp_file_limit') AS temp`
      assert.equal(limits.timeout,'2min')
      assert.equal(limits.temp,'0')
    })
    await assert.rejects(readonly.$executeRawUnsafe('INSERT INTO sku_release_v6_readonly_test VALUES (1)'),
      error => error.meta?.code === '25006')
    // The same real Prisma connection passes the session guard but a deliberately
    // writable test transaction must still fail the in-transaction guard.
    await readonly.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ WRITE')
      await assert.rejects(assertReleaseReadOnly(tx),/SKU_RELEASE_READONLY_GUARD_FAILED/)
    })
  } finally { await readonly.$disconnect() }
  assert.equal((await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM sku_release_v6_readonly_test'))[0].n,0)
  await db.$executeRawUnsafe('DROP TABLE sku_release_v6_readonly_test')
  console.log('ACTUAL_PRISMA_SESSION_AND_TX=PASS MISSING_WRONG_PGOPTIONS_ONLY=BLOCKED DUPLICATE_OPTIONS=SAFE DATABASE_WRITE_REJECTED=25006')
  const bd = await db.productCategory.create({ data: { id:'gate8a-bd', name:'糖果' } })
  const tp = await db.productCategory.create({ data: { id:'gate8a-tp', name:'pos-森醒' } })
  await db.store.create({ data: { key:'gate8a-store', name:'Gate 8A store' } })
  const products = Array.from({ length:178 }, (_,i) => ({
    id:`gate8a-product-${String(i+1).padStart(3,'0')}`,
    name:`Gate8A商品${String(i+1).padStart(3,'0')}`,
    sku:i<33?null:`LEGACY-${String(i+1).padStart(3,'0')}`,
    category:'product', productCategoryId:i<89?tp.id:bd.id,
    createdAt:new Date(Date.UTC(2026,0,1,0,0,Math.floor(i/4),999-(i%4)*211)),
    isActive:i<87,
    transferEnabled:i>=87 && i<113,
  }))
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('budu.sku_authority_writer','1',true)`
    await tx.inventoryItem.createMany({ data:products })
  })
  await db.onlineProductPolicy.createMany({ data:products.slice(0,153).map((row,i) => ({
    id:`gate8a-online-${String(i+1).padStart(3,'0')}`, namespace:'cloudbase-miniprogram',
    externalProductId:`external-${i+1}`, externalSkuId:`sku-external-${i+1}`,
    productId:row.id, enabled:true, updatedById:'gate8a',
  })) })
  const originalOrder = await db.order.create({ data: { id:'gate8a-old-order',
    orderNo:'gate8a-old-order',storeId:'gate8a-store',cashierId:'gate8a',
    checkoutKey:'gate8a-old-order',cartHash:'fixture' } })
  await db.orderItem.create({ data: { id:'gate8a-old-line',orderId:originalOrder.id,
    productId:products[0].id,productNameSnapshot:products[0].name,
    skuSnapshot:'LEGACY-SNAPSHOT',unitPrice:100n,costPriceSnapshot:50n,
    quantity:1,lineAmount:100n } })
  const readonlyProbe = spawnSync('node', ['--input-type=module', '--eval',
    readFileSync('scripts/sku-release-snapshot-probe.mjs','utf8')], {
    env: { ...process.env, PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=120000' },
    encoding:'utf8', maxBuffer:8 * 1024 * 1024,
  })
  assert.equal(readonlyProbe.status,0,readonlyProbe.stderr)
  const readiness = analyzeSnapshot(JSON.parse(readonlyProbe.stdout))
  const plan = adapter('plan')
  assert.deepEqual(plan.plan.counts,
    { total:178,BD:89,TP:89,missingOldSku:33,aliases:145 })
  assert.equal(readiness.posActive,87)
  assert.equal(readiness.anyChannelEnabled,113)
  assert.equal(readiness.snapshotId,plan.plan.snapshotId)
  assert.equal(readiness.channelDigest,plan.channelDigest)
  assert.equal(readiness.mappingDigest,crypto.createHash('sha256')
    .update(JSON.stringify(plan.plan.mapping)).digest('hex'))
  assert.equal(readiness.onlineDigest,crypto.createHash('sha256')
    .update(JSON.stringify(plan.online.map(row => [row.id,row.namespace,
      row.externalProductId,row.externalSkuId,row.productId,row.enabled]))).digest('hex'))
  assert.equal(plan.anyChannelEnabled,113)
  const approved = JSON.stringify(plan)
  for (const extra of [{}, { SKU_RELEASE_WRITE_AUTHORIZED:'b'.repeat(40) }]) {
    const rejected=spawnSync('node',['scripts/sku-release-apply.mjs','apply'],{
      input:approved,env:{ ...env,SKU_RELEASE_READ_ONLY:'',SKU_RELEASE_WRITE_AUTHORIZED:'',...extra },encoding:'utf8' })
    assert.equal(rejected.status,1)
    assert.equal(rejected.stderr,'SKU_RELEASE_WRITE_AUTHORIZATION_REQUIRED\n')
  }
  const conflict=spawnSync('node',['scripts/sku-release-apply.mjs','apply'],{
    input:approved,env:{ ...env,SKU_RELEASE_READ_ONLY:'YES',SKU_RELEASE_WRITE_AUTHORIZED:sha },encoding:'utf8' })
  assert.equal(conflict.status,1)
  assert.equal(conflict.stderr,'SKU_RELEASE_WRITE_READONLY_CONFLICT\n')
  assert.equal(await db.productSkuAssignment.count(),0)
  const applied = adapter('apply',approved,{ SKU_RELEASE_WRITE_AUTHORIZED:sha })
  assert.equal(applied.digest,plan.plan.sha256)
  assert.equal(adapter('reconcile',approved).result,'PASS')
  assert.equal(await db.productSkuAssignment.count(),178)
  assert.equal(await db.productSkuAlias.count(),145)
  assert.equal((await db.orderItem.findUnique({ where:{ id:'gate8a-old-line' } })).skuSnapshot,
    'LEGACY-SNAPSHOT')

  await db.order.create({ data: { id:'gate8a-post-order',orderNo:'gate8a-post-order',
    storeId:'gate8a-store',cashierId:'gate8a',checkoutKey:'gate8a-post-order',
    cartHash:'post-cutover-fact' } })
  await db.sensitiveRecordAudit.create({ data: { id:'gate8a-post-generic',
    action:'gate8a.payment-like',recordType:'Order',recordId:'gate8a-post-order',
    actorUserId:'gate8a',actorUsername:'gate8a',reason:'post-cutover fact' } })
  const user = { id:'gate8a',username:'gate8a',role:'developer',status:'active' }
  await db.$transaction(async tx => {
    const sku = await reserveProductSku(tx,{ source:'BD',user })
    await tx.inventoryItem.create({ data: { id:'gate8a-post-product',
      name:'Gate8A切流后新品',sku,category:'product',productCategoryId:bd.id } })
    await recordProductSkuAssignment(tx,{ sku,itemId:'gate8a-post-product',user,
      reason:'post-cutover create' })
    await appendProductSkuAudit(tx,{ sku,itemId:'gate8a-post-product',user,
      reason:'post-cutover create' })
  })
  const after = adapter('reconcile',approved,{ SKU_RELEASE_PHASE:'POST_CUTOVER' })
  assert.equal(after.products,179)
  assert.equal(after.assignments,179)
  assert.equal(await db.order.count({ where:{ id:'gate8a-post-order' } }),1)
  assert.equal(await db.sensitiveRecordAudit.count({ where:{ id:'gate8a-post-generic' } }),1)
  console.log('SKU_RELEASE_APPLY_PG16=PASS POST_CUTOVER_ORDER_AND_GENERIC_PRESERVED=PASS')
} finally { await db.$disconnect() }
