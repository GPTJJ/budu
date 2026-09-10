import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {onlineFinancialTransaction} from '../server/online-financial-transaction.js'
import {claimOnlineOutbox,acknowledgeOnlineOutbox,failOnlineOutbox,deliverOnlineOutboxOnce} from '../server/online-outbox.js'
const c=JSON.parse(fs.readFileSync(process.env.SC11B_NATIVE_CONFIG))
if(c.host!=='127.0.0.1'||c.database!=='budu_sc11b_native')throw Error('ISOLATED_NATIVE_DB_REQUIRED')
const prisma=new PrismaClient({datasourceUrl:`postgresql://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`})
after(()=>prisma.$disconnect())
async function create({crash=false}={}){
 const id=crypto.randomUUID(),expiresAt=new Date(Date.now()+900000)
 const snapshot={currency:'CNY',merchandiseCents:'100',eligibleMerchandiseCents:'100',shippingCents:'10',totalCents:'110',sweetCardCents:'0',wechatCents:'110'}
 await onlineFinancialTransaction(prisma,id,async tx=>{
  await tx.user.create({data:{id,username:id,passwordHash:'synthetic'}})
  await tx.onlineCheckoutQuote.create({data:{id,userId:id,requestKey:id,requestFingerprint:id,snapshot,expiresAt}})
  await tx.onlineSettlement.create({data:{id,userId:id,quoteId:id,namespace:'native-test',externalOrderId:id,requestKey:id,requestFingerprint:id,merchandiseCents:100n,eligibleMerchandiseCents:100n,shippingCents:10n,totalCents:110n,sweetCardCents:0n,wechatCents:110n,expiresAt,tenders:{create:{id,amountCents:110n,type:'WECHAT',merchantTradeNo:id}}}})
  if(crash)throw Error('SIMULATED_ABORT')
 })
 return id
}
async function drain(){
 // Synthetic fixtures only, never point this test at production.
 for(let i=0;i<1000;i++){
  const event=await claimOnlineOutbox(prisma)
  if(!event)return
  await acknowledgeOnlineOutbox(prisma,event,{eventKey:event.event_key,version:event.version,status:'APPLIED'})
 }
 throw Error('TEST_QUEUE_NOT_DRAINED')
}
test('financial transaction atomically persists safe mirror snapshot',async()=>{
 await drain();const id=await create();const event=await prisma.onlineOutbox.findUnique({where:{eventKey:`online:${id}:1`}})
 assert.equal(event.payload.status,'PENDING');assert.equal(event.payload.wechatCents,'110')
 assert.equal(event.payload.tenders.length,1);assert.equal(event.payload.userId,undefined);assert.equal(event.payload.providerTransactionId,undefined)
})
test('abort before commit leaves no partial settlement or outbox',async()=>{
 const before=await prisma.onlineOutbox.count();const settlements=await prisma.onlineSettlement.count()
 await assert.rejects(create({crash:true}),/SIMULATED_ABORT/)
 assert.equal(await prisma.onlineOutbox.count(),before);assert.equal(await prisma.onlineSettlement.count(),settlements)
})
test('unchanged idempotent transaction emits no duplicate event',async()=>{
 const id=await create();await onlineFinancialTransaction(prisma,id,async()=>{})
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:id}}),1)
})
test('concurrent workers claim one event once',async()=>{
 await drain();await create();let calls=0
 const delivery=async e=>{calls++;await new Promise(r=>setTimeout(r,25));return {eventKey:e.eventKey,version:e.version,status:'APPLIED'}}
 const results=await Promise.all([deliverOnlineOutboxOnce(prisma,delivery),deliverOnlineOutboxOnce(prisma,delivery)])
 assert.equal(calls,1);assert.deepEqual(results.map(r=>r.status).sort(),['DELIVERED','IDLE'])
})
test('mirror failure preserves financial truth and queues retry without raw error',async()=>{
 await drain();const id=await create();const result=await deliverOnlineOutboxOnce(prisma,async()=>{throw Error('sensitive-provider-message')})
 assert.equal(result.status,'RETRY_PENDING');assert.equal((await prisma.onlineSettlement.findUnique({where:{id}})).status,'PENDING')
 const event=await prisma.onlineOutbox.findUnique({where:{eventKey:`online:${id}:1`}})
 assert.equal(event.deliveredAt,null);assert.equal(event.lastError,'MIRROR_DELIVERY_FAILED')
 await prisma.onlineOutbox.update({where:{id:event.id},data:{availableAt:new Date(0)}});await drain()
})
test('expired worker cannot acknowledge or clear replacement lease',async()=>{
 await drain();await create();const old=await claimOnlineOutbox(prisma,{leaseMs:100})
 await new Promise(r=>setTimeout(r,150));const next=await claimOnlineOutbox(prisma)
 assert.equal(next.id,old.id);assert.notEqual(next.lease_owner,old.lease_owner)
 assert.equal(await acknowledgeOnlineOutbox(prisma,old,{eventKey:old.event_key,version:old.version,status:'APPLIED'}),false)
 await failOnlineOutbox(prisma,old)
 assert.equal((await prisma.onlineOutbox.findUnique({where:{id:next.id}})).leaseOwner,next.lease_owner)
 assert.equal(await acknowledgeOnlineOutbox(prisma,next,{eventKey:next.event_key,version:next.version,status:'ALREADY_APPLIED'}),true)
})
test('HTTP success without exact mirror acknowledgement cannot mark delivered',async()=>{
 await drain();const id=await create();assert.equal((await deliverOnlineOutboxOnce(prisma,async()=>({ok:true}))).status,'RETRY_PENDING')
 const e=await prisma.onlineOutbox.findUnique({where:{eventKey:`online:${id}:1`}});assert.equal(e.deliveredAt,null)
 await prisma.onlineOutbox.update({where:{id:e.id},data:{availableAt:new Date(0)}});await drain()
})
async function markPaid(id,{crash=false}={}){
 return onlineFinancialTransaction(prisma,id,async(tx,row)=>{
  if(row.status==='PAID')return 'REUSED'
  await tx.onlineTender.update({where:{settlementId_type:{settlementId:id,type:'WECHAT'}},data:{status:'SUCCEEDED',providerTransactionId:`synthetic-${id}`,verifiedAt:new Date(),providerSuccessAt:new Date()}})
  await tx.onlineSettlement.update({where:{id},data:{status:'PAID',paidAt:new Date(),version:{increment:1}}})
  if(crash)throw Error('BEFORE_COMMIT_ABORT')
  return 'PAID'
 })
}
test('concurrent verified settlement duplicates commit one PAID event',async()=>{
 const id=await create();const result=await Promise.all([markPaid(id),markPaid(id)])
 assert.deepEqual(result.sort(),['PAID','REUSED'])
 const events=await prisma.onlineOutbox.findMany({where:{settlementId:id},orderBy:{version:'asc'}})
 assert.deepEqual(events.map(e=>[e.version,e.payload.status]),[[1,'PENDING'],[2,'PAID']])
})
test('settlement failure rolls back provider fact and PAID mirror together',async()=>{
 const id=await create();await assert.rejects(markPaid(id,{crash:true}),/BEFORE_COMMIT_ABORT/)
 assert.equal((await prisma.onlineSettlement.findUnique({where:{id}})).status,'PENDING')
 assert.equal((await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:id,type:'WECHAT'}}})).providerTransactionId,null)
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:id}}),1)
 await markPaid(id);assert.equal(await prisma.onlineOutbox.count({where:{settlementId:id}}),2)
})
test('financial envelope change without version increment aborts',async()=>{
 const id=await create()
 await assert.rejects(onlineFinancialTransaction(prisma,id,async tx=>{
  await tx.onlineTender.update({where:{settlementId_type:{settlementId:id,type:'WECHAT'}},data:{status:'CLOSED'}})
 }),{status:409})
 assert.equal((await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:id,type:'WECHAT'}}})).status,'PENDING')
})
test('callback mutating its input row cannot suppress outbox event',async()=>{
 const id=await create()
 await onlineFinancialTransaction(prisma,id,async(tx,before)=>{
  const updated=await tx.onlineSettlement.update({where:{id},data:{status:'CLOSING',version:{increment:1}}})
  Object.assign(before,updated)
 })
 const event=await prisma.onlineOutbox.findUnique({where:{eventKey:`online:${id}:2`}})
 assert.equal(event.payload.status,'CLOSING')
})
