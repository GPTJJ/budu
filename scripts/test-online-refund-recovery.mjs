import test from 'node:test'
import assert from 'node:assert/strict'
import {createOnlineRefundRecovery} from '../server/online-refund-service.js'
function model(rows){return {
  findFirst:async()=>rows.length?{id:rows.at(-1).id}:null,
  findMany:async({where,take})=>rows.filter(r=>(!where.id.gt||r.id>where.id.gt)&&r.id<=where.id.lte).slice(0,take),
}}
test('refund worker drains finite pages and retries earlier pending failures after pass',async()=>{
 const rows=[{id:'a',merchantRefundNo:'a'},{id:'b',merchantRefundNo:'b'},{id:'c',merchantRefundNo:'c'}],calls=[]
 const worker=createOnlineRefundRecovery({onlineRefund:model(rows),onlinePaymentCompensation:model([])},{recover:async no=>{calls.push(no);if(no==='a')throw Error('synthetic');return{status:'PENDING'}}},{batchSize:2})
 assert.deepEqual(await worker.tick(),{scanned:2,settled:0,pending:1,failed:1})
 await worker.tick();await worker.tick();assert.deepEqual(calls,['a','b','c','a','b'])
})
test('worker runs refund and compensation obligations independent of purchase flags',async()=>{
 const calls=[],worker=createOnlineRefundRecovery({onlineRefund:model([{id:'a',merchantRefundNo:'r'}]),onlinePaymentCompensation:model([{id:'b',merchantRefundNo:'c'}])},{recover:async no=>{calls.push(no);return{status:'SETTLED'}}})
 assert.deepEqual(await worker.tick(),{scanned:2,settled:2,pending:0,failed:0});assert.deepEqual(calls,['r','c'])
})
test('overlapping ticks share work; aborted scan does not dispatch',async()=>{
 let release,calls=0;const wait=new Promise(r=>{release=r})
 const worker=createOnlineRefundRecovery({onlineRefund:model([{id:'a',merchantRefundNo:'r'}]),onlinePaymentCompensation:model([])},{recover:async()=>{calls++;await wait;return{status:'SETTLED'}}})
 const a=worker.tick(),b=worker.tick();assert.equal(a,b);release();await a;assert.equal(calls,1)
 const controller=new AbortController();controller.abort();assert.equal((await worker.tick({signal:controller.signal})).scanned,0)
})
