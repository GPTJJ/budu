import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'

// Explicit opt-in; reuse the already-existing owned synthetic database only.
// No schema setup, migration, startup task, business provider or production URL.
assert.equal(process.env.CHAOWAI_R1_NATIVE, '1')
const url = new URL('postgresql://127.0.0.1:55439/budu_chaowai_closure_001')
url.username = 'audit_p1'; url.searchParams.set('application_name','chaowai-r1-isolated-test')
const db = new PrismaClient({ datasourceUrl: url.href })
const [identity] = await db.$queryRawUnsafe("SELECT current_database() AS name, current_setting('data_directory') AS directory")
assert.equal(identity.name,'budu_chaowai_closure_001')
assert.equal(identity.directory,'/Users/buxieshi/Documents/Codex/2026-10-13/BUDU-CODE-AUDIT-001-P1-FIX/work/pgdata')
process.env.DATABASE_URL = url.href
for(const key of ['WECHAT_WORK_WEBHOOK_URL','WXWORK_CORP_ID','WXWORK_AGENT_ID','WXWORK_SECRET','MP_APP_ID','MP_APP_SECRET','MP_TEMPLATE_ID'])delete process.env[key]
globalThis.__buduPrisma=db
let externalAttempts=0
const originalFetch=globalThis.fetch
globalThis.fetch=async()=>{externalAttempts++;throw Error('NO_EXTERNAL_IO_IN_NATIVE_FIXTURE')}
const {v2Router}=await import('../server/v2.js')
const {createOnlineCheckout}=await import('../server/online-checkout.js')
const prefix='r1-'+crypto.randomUUID(),customerId=prefix+'-customer',otherId=prefix+'-other',actorId=prefix+'-dev'
const quoteIds=[],settlementIds=[],invoiceIds=[]
const actor={id:actorId,username:actorId,role:'developer',status:'active',storeKeys:['chaowai','guanshe']}
const proofs={identity,externalCalls:0,lockWaits:[]}
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
async function allFacts({ excludeFixture = false } = {}){
  const tables=await db.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  const facts={}
  for(const {tablename} of tables){
    const quoted='"'+tablename.replaceAll('"','""')+'"'
    const [row]=await db.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${quoted} t WHERE coalesce(to_jsonb(t)->>'id','') <> ALL($1::text[])`, excludeFixture ? [customerId,otherId,actorId,...quoteIds,...settlementIds,...invoiceIds,...settlementIds.map((_,i)=>prefix+'-t-'+(i+1))] : [])
    facts[tablename]=row
  }
  return facts
}
const before=await allFacts()
if(process.env.CHAOWAI_R1_NATIVE_PROOF)fs.writeFileSync(process.env.CHAOWAI_R1_NATIVE_PROOF+'.before.json',JSON.stringify({identity,prefix,tables:before},null,2)+'\n')
after(async()=>{
  try{
    // Financial facts are protected against DELETE/UPDATE. Keep this run's
    // owned synthetic fixtures, and compare every PRE-EXISTING row unchanged.
    // Never disable triggers or recreate the database to clean a test fixture.
    assert.deepEqual(await allFacts({excludeFixture:true}),before,'all prior synthetic database rows preserved')
    proofs.fixtureRowsRetained={prefix,users:[customerId,otherId,actorId],quotes:quoteIds,settlements:settlementIds,invoices:invoiceIds}
    assert.equal(externalAttempts,0)
    proofs.databasePreserved={tables:Object.keys(before).length,allPreExistingRowHashesEqual:true}
    if(process.env.CHAOWAI_R1_NATIVE_PROOF)fs.writeFileSync(process.env.CHAOWAI_R1_NATIVE_PROOF,JSON.stringify(proofs,null,2)+'\n')
  }finally{await db.$disconnect();globalThis.fetch=originalFetch}
})
assert.equal((await db.store.findUnique({where:{key:'chaowai'}})).active,false,'reuse existing closed-store fixture; do not toggle it')
assert.equal((await db.store.findUnique({where:{key:'guanshe'}})).active,true)
for(const id of [customerId,otherId,actorId])await db.user.create({data:{id,username:id,role:id===actorId?'developer':'customer',status:'active',storeKeys:actor.storeKeys,passwordHash:'synthetic-not-a-password'}})
async function makeQuote({expired=false}={}){
  const id=prefix+'-q-'+quoteIds.length;quoteIds.push(id)
  return db.onlineCheckoutQuote.create({data:{id,userId:customerId,requestKey:id,requestFingerprint:'synthetic',expiresAt:new Date(expired?0:Date.now()+600000),snapshot:{namespace:'cloudbase-miniprogram',fulfillment:'PICKUP',commerceIntent:{storeRef:'chaowai'},currency:'CNY',merchandiseCents:'100',eligibleMerchandiseCents:'0',shippingCents:'0',totalCents:'100',sweetCardCents:'0',wechatCents:'100'}}})
}
function pendingData(q,requestKey){
  const id='os-'+digest([customerId,requestKey]);settlementIds.push(id)
  return {id,userId:customerId,quoteId:q.id,namespace:'cloudbase-miniprogram',externalOrderId:id,requestKey,requestFingerprint:digest({quoteId:q.id}),status:'PENDING',currency:'CNY',merchandiseCents:100n,eligibleMerchandiseCents:0n,shippingCents:0n,totalCents:100n,sweetCardCents:0n,wechatCents:100n,expiresAt:q.expiresAt,
    tenders:{create:{id:prefix+'-t-'+settlementIds.length,type:'WECHAT',amountCents:100n,merchantTradeNo:'B'+digest(id).slice(0,31)}}}
}
const q=await makeQuote(),requestKey=prefix+'-submit',pending=pendingData(q,requestKey)
await db.onlineSettlement.create({data:pending})
const checkout=createOnlineCheckout(db,{resolveCatalog:async()=>assert.fail('no catalog/provider'),env:{SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST:[customerId,otherId].join(',')}})
for(const storeKey of ['chaowai','guanshe']){
  const id=prefix+'-inv-'+storeKey;invoiceIds.push(id)
  await db.invoice.create({data:{id,storeKey,titleType:'personal',amountCents:100n,status:'pending',createdBy:actor.username}})
}
async function invoiceRoute({storeKey='chaowai',requestActor=actor,create=false}={}){
  const path=create?'/invoices':'/invoices/:id/status',layer=v2Router.stack.find(x=>x.route?.path===path&&x.route.methods.post)
  const req={user:requestActor,body:create?{storeKey,titleType:'personal',amountCents:100}:{status:'done'},params:{id:prefix+'-inv-'+storeKey}}
  const response={statusCode:200,status(v){this.statusCode=v;return this},json(v){this.body=v;return this}}
  await layer.route.stack[0].handle(req,response);return response
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function waitForLock(fragment){
  for(let n=0;n<120;n++){
    const rows=await db.$queryRawUnsafe("SELECT query,wait_event,cardinality(pg_blocking_pids(pid))::int AS blockers FROM pg_stat_activity WHERE datname=current_database() AND application_name='chaowai-r1-isolated-test' AND wait_event_type='Lock'")
    if(rows.some(r=>r.query.includes(fragment)&&r.blockers>0)){proofs.lockWaits.push({fragment,observed:true});return}
    await sleep(20)
  }
  assert.fail('Expected PostgreSQL blocking lock: '+fragment)
}

test('R1-01 原生PG已落库PENDING的plan/submit只读恢复；过期旧报价仍保留身份',async()=>{
  const facts=await allFacts()
  assert.equal((await checkout.plan(customerId,{quoteId:q.id,requestKey})).settlementId,pending.id)
  assert.equal((await checkout.submit(customerId,{quoteId:q.id,requestKey})).status,'PENDING')
  assert.deepEqual(await allFacts(),facts)
  const expired=await makeQuote({expired:true}),expiredKey=prefix+'-expired',expiredData=pendingData(expired,expiredKey)
  await db.onlineSettlement.create({data:expiredData})
  const expiredFacts=await allFacts()
  assert.equal((await checkout.plan(customerId,{quoteId:expired.id,requestKey:expiredKey})).settlementId,expiredData.id)
  assert.equal((await checkout.submit(customerId,{quoteId:expired.id,requestKey:expiredKey})).id,expiredData.id)
  assert.deepEqual(await allFacts(),expiredFacts)
  proofs.existingPendingReplayReadOnly=true
})
test('R1-01 原生PG新闭店交易拒绝，错误key/用户/指纹不能冒认旧身份',async()=>{
  const unused=await makeQuote(),facts=await allFacts()
  for(const action of ['plan','submit']){
    await assert.rejects(checkout[action](customerId,{quoteId:unused.id,requestKey:prefix+'-new'}),e=>e.code==='STORE_CLOSED')
    await assert.rejects(checkout[action](customerId,{quoteId:q.id,requestKey:prefix+'-wrong'}),e=>e.status===409&&e.code!=='STORE_CLOSED')
    await assert.rejects(checkout[action](otherId,{quoteId:q.id,requestKey}),e=>e.status===409&&e.code!=='STORE_CLOSED')
  }
  assert.deepEqual(await allFacts(),facts)
  await assert.rejects(db.onlineSettlement.update({where:{id:pending.id},data:{requestFingerprint:'invalid'}}),/ONLINE_IMMUTABLE_FACT/)
  assert.deepEqual(await allFacts(),facts)
  proofs.newAndConflictingRejectedWithoutWrites=true
})
test('R1-01 原生advisory等待后plan读取刚提交的旧PENDING，无新结算',async()=>{
  const quote=await makeQuote(),key=prefix+'-waiting',data=pendingData(quote,key),held=deferred(),release=deferred()
  const writer=db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`online-settlement:${data.id}`},0))`
    await tx.onlineSettlement.create({data});held.resolve();await release.promise
  },{timeout:10000})
  await held.promise
  const reading=checkout.plan(customerId,{quoteId:quote.id,requestKey:key})
  try{await waitForLock('pg_advisory_xact_lock')}finally{release.resolve()}
  await writer;assert.equal((await reading).settlementId,data.id)
  assert.equal(await db.onlineSettlement.count({where:{quoteId:quote.id}}),1)
  proofs.planWaitSeesCommittedSettlement=true
})
for(const change of [{role:'staff'},{status:'disabled'}])test(`R1-02 账号锁等待后重读${Object.keys(change)[0]}，真实新开票/历史状态均拒绝`,async()=>{
  await db.user.update({where:{id:actorId},data:{role:'developer',status:'active'}})
  const held=deferred(),release=deferred()
  const revoke=db.$transaction(async tx=>{await tx.user.update({where:{id:actorId},data:change});held.resolve();await release.promise},{timeout:10000})
  await held.promise
  const maintenance=invoiceRoute()
  try{await waitForLock('SELECT id FROM "User"')}finally{release.resolve()}
  await revoke
  assert.equal((await maintenance).statusCode,403)
  const facts=await allFacts();assert.equal((await invoiceRoute({create:true})).statusCode,403)
  assert.deepEqual(await allFacts(),facts,'denied invoice must not even update Store name')
  assert.equal((await db.invoice.findUnique({where:{id:invoiceIds[0]}})).status,'pending')
  proofs[Object.keys(change)[0]+'RevocationRejected']=true
})
test('R1-02 先持有账号共享锁再等Store，后发降权等待善后事务完成',async()=>{
  await db.user.update({where:{id:actorId},data:{role:'developer',status:'active'}})
  const held=deferred(),release=deferred()
  const blocker=db.$transaction(async tx=>{await tx.$queryRawUnsafe('SELECT key FROM "Store" WHERE key=$1 FOR UPDATE','chaowai');held.resolve();await release.promise},{timeout:10000})
  await held.promise
  const maintenance=invoiceRoute();let revoke
  try{
    await waitForLock('SELECT key FROM "Store"')
    revoke=db.user.update({where:{id:actorId},data:{role:'staff'}})
    // Prisma promises are lazy: start the update before observing its wait.
    revoke=Promise.resolve(revoke)
    await waitForLock('UPDATE "public"."User"')
  }finally{release.resolve()}
  await blocker;assert.equal((await maintenance).statusCode,200);await revoke
  assert.equal((await db.user.findUnique({where:{id:actorId}})).role,'staff')
  assert.equal((await db.invoice.findUnique({where:{id:invoiceIds[0]}})).status,'done')
  proofs.userBeforeStoreSerialized=true
})
test('R1-02 营业门店admin原有权限保留，closed后过时developer再次拒绝',async()=>{
  await db.user.update({where:{id:actorId},data:{role:'admin',status:'active'}})
  assert.equal((await invoiceRoute({storeKey:'guanshe',requestActor:{...actor,role:'admin'}})).statusCode,200)
  assert.equal((await invoiceRoute()).statusCode,403)
  assert.equal(externalAttempts,0);proofs.operatingStorePermissionPreserved=true
})
