import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlinePaymentRecovery, startOnlinePaymentRecovery } from '../server/online-payment-recovery.js'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
test('scanner progresses past ambiguous and failed orders, then revisits them', async () => {
  const calls = [], queries = [], ids = ['a', 'b', 'c']
  const prisma = { onlineSettlement: { findFirst:async()=>({id:'c'}), findMany: async q => {
    queries.push(q); return ids.filter(id => !q.where.id.gt || id > q.where.id.gt).slice(0,q.take).map(id=>({id}))
  } } }
  const worker = createOnlinePaymentRecovery(prisma, { recover: async id => {
    calls.push(id); if (id === 'a') throw Error('secret provider message'); return {status:id==='b'?'CLOSING':'PAID'}
  } }, {batchSize:2})
  assert.deepEqual(await worker.tick(), {scanned:2,resolved:0,pending:1,failed:1,stopped:false})
  assert.equal((await worker.tick()).resolved,1)
  await worker.tick(); assert.deepEqual(calls,['a','b','c','a','b'])
  assert.deepEqual(queries[0].where.status,{in:['PENDING','CLOSING']})
  assert.equal(queries[0].where.OR[2].tenders.some.prepayRequestedAt.not,null)
  assert.deepEqual(queries[0].select,{id:true})
})
test('overlapping ticks share actual work instead of starting duplicate provider calls', async () => {
  const gate=deferred();let queries=0,calls=0
  const worker=createOnlinePaymentRecovery({onlineSettlement:{findFirst:async()=>({id:'a'}),findMany:async()=>{queries++;return [{id:'a'}]}}},{recover:async()=>{calls++;await gate.promise;return {status:'PAID'}}})
  const a=worker.tick(),b=worker.tick();assert.equal(a,b);gate.resolve();await a
  assert.equal(queries,1);assert.equal(calls,1)
})
test('database scan failure is surfaced and retry keeps the cursor', async () => {
  let tries=0
  const worker=createOnlinePaymentRecovery({onlineSettlement:{findFirst:async()=>({id:'a'}),findMany:async()=>{if(!tries++)throw Error('db');return []}}},{recover:async()=>assert.fail()})
  await assert.rejects(worker.tick());assert.equal((await worker.tick()).scanned,0)
})
test('abort drains current item and leaves subsequent item for the next tick', async () => {
  const controller=new AbortController(),calls=[]
  const worker=createOnlinePaymentRecovery({onlineSettlement:{findFirst:async()=>({id:'b'}),findMany:async q=>['a','b'].filter(id=>!q.where.id.gt||id>q.where.id.gt).map(id=>({id}))}},{recover:async id=>{calls.push(id);controller.abort();return {status:'PAID'}}})
  const first=await worker.tick({signal:controller.signal});assert.equal(first.stopped,true);assert.deepEqual(calls,['a'])
  await worker.tick();assert.deepEqual(calls,['a','b'])
})
test('scheduler drains on stop and telemetry failure cannot escape', async () => {
  const gate=deferred();let calls=0,stopped=false
  const scheduler=startOnlinePaymentRecovery({tick:async()=>{calls++;await gate.promise;return {scanned:1}}},{intervalMs:100,onResult:()=>{throw Error('telemetry')}})
  const ending=scheduler.stop().then(()=>{stopped=true});await Promise.resolve();assert.equal(stopped,false)
  gate.resolve();await ending;assert.equal(calls,1);assert.equal(stopped,true)
})
test('configuration and already-aborted work fail without I/O', async () => {
  assert.throws(()=>createOnlinePaymentRecovery({}, {}, {batchSize:0}))
  assert.throws(()=>startOnlinePaymentRecovery({}, {intervalMs:0}))
  const worker=createOnlinePaymentRecovery({onlineSettlement:{findMany:()=>assert.fail()}},{recover:()=>assert.fail()})
  assert.equal((await worker.tick({signal:AbortSignal.abort()})).stopped,true)
})
test('continuous later arrivals cannot starve unresolved rows from a prior pass', async () => {
  const ids=['00001','00002','00003','00004'],calls=[]
  const worker=createOnlinePaymentRecovery({onlineSettlement:{
    findFirst:async()=>({id:ids.at(-1)}),
    findMany:async q=>ids.filter(id=>id<=q.where.id.lte&&(!q.where.id.gt||id>q.where.id.gt)).slice(0,q.take).map(id=>({id})),
  }},{recover:async id=>{calls.push(id);return {status:'CLOSING'}}},{batchSize:2})
  for(let i=0;i<3;i++) { await worker.tick();ids.push(String(ids.length+1).padStart(5,'0'),String(ids.length+2).padStart(5,'0')) }
  assert.deepEqual(calls,['00001','00002','00003','00004','00001','00002'])
})
test('async telemetry rejection is absorbed without waiting for telemetry', async () => {
  const scheduler=startOnlinePaymentRecovery({tick:async()=>({scanned:0})},{onResult:async()=>{throw Error('TELEMETRY_REJECTION')}})
  await scheduler.stop();await new Promise(resolve=>setImmediate(resolve))
})
test('database failure mid-pass preserves position and finite upper bound',async()=>{
 let count=0,failed=false;const cursors=[]
 const worker=createOnlinePaymentRecovery({onlineSettlement:{findFirst:async()=>{count++;return {id:'c'}},findMany:async q=>{
  cursors.push(q.where.id);if(q.where.id.gt==='a'&&!failed){failed=true;throw Error('database')}
  return ['a','b','c'].filter(id=>!q.where.id.gt||id>q.where.id.gt).slice(0,1).map(id=>({id}))
 }}},{recover:async()=>({status:'PENDING'})},{batchSize:1})
 await worker.tick();await assert.rejects(worker.tick());await worker.tick()
 assert.equal(count,1);assert.deepEqual(cursors[1],cursors[2]);assert.equal(cursors[2].lte,'c')
})
