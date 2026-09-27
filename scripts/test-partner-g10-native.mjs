import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'

const databaseUrl = await createDisposablePgDatabase('partner_g10')
process.env.DATABASE_URL = databaseUrl
const { createPartnerDomainRouter } = await import('../server/partner-domain.js')
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
const nativeTransaction = db.$transaction.bind(db)
db.$transaction = async (...args) => {
  try { return await nativeTransaction(...args) }
  catch (error) {
    console.log('native_transaction_error', JSON.stringify({code:error.code,metaKeys:Object.keys(error.meta ?? {}),meta:{code:error.meta?.code,message:typeof error.meta?.message==='string'?error.meta.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[REDACTED_URL]').slice(0,500):null},transaction:{isolationLevel:args[1]?.isolationLevel},clientVersion:error.clientVersion}))
    throw error
  }
}
const concurrency = Number(process.env.G10_CONCURRENCY || 8)
assert([8,16,24].includes(concurrency))
const race = process.env.G10_OVERSHIP === '1'
const quantity = race ? 10000 : 100
const tag = 'g10-' + crypto.randomUUID().slice(0, 8)
let server
try {
  await db.store.create({ data: { key: 'guanshe', name: 'PR-A isolated fulfillment fixture' } })
  const stockBefore = { balances: await db.stockBalance.count(), ledger: await db.stockLedger.count() }
  const actor = await db.user.create({data:{id:tag,username:tag,passwordHash:'NON_LOGIN_TEST_FIXTURE',role:'developer',status:'active'}})
  await db.partner.create({data:{id:tag,name:tag,defaultStoreKey:'guanshe',defaultDiscountBps:6500}})
  await db.partnerStore.create({data:{id:tag,partnerId:tag,name:tag}})
  await db.inventoryItem.create({data:{id:tag,name:tag,sku:tag,unit:'颗',category:'product',salePriceCents:500n,partnerKgBasePriceCents:race?18000n:null,isActive:true,partnerReplenishmentEnabled:true,partnerOrderUnit:race?'KG':'PCS',partnerMinOrderBaseQty:1,partnerOrderStepBaseQty:1}})
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=actor;next()});app.use(createPartnerDomainRouter({db,mirrorUsers:async()=>{}}))
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  const root=`http://127.0.0.1:${server.address().port}/partner-management/replenishment-orders`
  const post=async(path,key,body)=>{const r=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});const json=await r.json();return {status:r.status,json}}
  const body={partnerId:tag,partnerStoreId:tag,items:[{inventoryItemId:tag,quantity:quantity,orderUnit:race?'KG':'PCS'}]}
  const submissions=await Promise.all(Array.from({length:8},()=>post('',tag+'-submit',body)))
  console.log('submit_statuses',submissions.map(r=>r.status))
  assert(submissions.every(r=>[200,201,409].includes(r.status)), 'generic 500 is forbidden for concurrent submission')
  assert.equal(await db.replenishmentOrder.count({where:{partnerId:tag}}),1)
  const order=await db.replenishmentOrder.findFirst({where:{partnerId:tag},include:{items:true}})
  const repeat=await post('',tag+'-submit',body);assert.equal(repeat.status,200);assert.equal(repeat.json.order.id,order.id)
  assert.equal((await post('',tag+'-submit',{...body,items:[{...body.items[0],quantity:101}]})).status,409)
  console.log('NATIVE_SUBMIT_IDEMPOTENCY_PASS')
  const approval={version:order.version,items:order.items.map(i=>({itemId:i.id,approvedQuantityBase:quantity})),reason:'native gate10 fixture'}
  const reviews=await Promise.all(Array.from({length:4},(_,i)=>post('/'+order.id+'/approve',tag+'-approve-'+i,approval)))
  console.log('review_statuses',reviews.map(r=>r.status))
  assert(reviews.every(r=>[200,201,409].includes(r.status)), 'generic 500 is forbidden for concurrent review')
  assert.equal(reviews.filter(r=>r.status===201).length,1)
  assert.equal(await db.partnerAuditLog.count({where:{entityId:order.id,action:'REPLENISHMENT_ORDER_APPROVED'}}),1)
  console.log('NATIVE_REVIEW_RACE_PASS')
  const shipping={fulfillmentStoreKey:'guanshe',carrier:'TEST_ONLY',trackingNumber:tag,freightType:'PREPAID',items:[{orderItemId:order.items[0].id,shippedQuantityBase:quantity}]}
  if(race) {
    const first=await post('/'+order.id+'/shipments',tag+'-first',{...shipping,items:[{...shipping.items[0],shippedQuantityBase:6000}]})
    assert.equal(first.status,201)
    shipping.items[0].shippedQuantityBase=4000
  }
  const shipments=await Promise.all(Array.from({length:race?2:concurrency},(_,i)=>post('/'+order.id+'/shipments',tag+'-shipment'+(race?'-'+i:''),shipping)))
  if(race) {assert.equal(shipments.filter(r=>r.status===201).length,1);assert.equal(shipments.filter(r=>r.status===409).length,1)}
  console.log('shipment_statuses',shipments.map(r=>r.status))
  for(const r of shipments.filter(r=>r.status>=500))console.log('shipment_error',r.json.error)
  assert(shipments.every(r=>[200,201,409].includes(r.status)), 'generic 500 is forbidden for concurrent shipment')
  assert.equal(await db.replenishmentShipment.count({where:{replenishmentOrderId:order.id}}),race?2:1)
  const total=await db.replenishmentShipmentItem.aggregate({where:{replenishmentOrderItemId:order.items[0].id},_sum:{shippedQuantityBase:true}})
  assert.equal(total._sum.shippedQuantityBase,quantity)
  const rows=await db.replenishmentShipment.findMany({where:{replenishmentOrderId:order.id},include:{items:true}})
  assert.equal(rows.reduce((n,r)=>n+r.items.length,0),race?2:1)
  assert.equal(new Set(rows.map(r=>r.idempotencyScope+':'+r.idempotencyKey)).size,rows.length)
  for(const row of rows) assert.equal(await db.partnerAuditLog.count({where:{entityId:row.id,action:'REPLENISHMENT_SHIPMENT_CREATED'}}),1)
  assert.equal((await db.replenishmentOrder.findUnique({where:{id:order.id}})).status,'SHIPPED')
  console.log('INVARIANTS_PASS',JSON.stringify({concurrency:race?2:concurrency,shipments:rows.length,items:rows.reduce((n,r)=>n+r.items.length,0),shipped:total._sum.shippedQuantityBase,remaining:quantity-total._sum.shippedQuantityBase,status:'SHIPPED',audits:rows.length,idempotencyRows:rows.length,overShipRace:race,http500:shipments.filter(r=>r.status>=500).length}))
  console.log('NATIVE_SHIPMENT_RACE_PASS')
  assert.deepEqual({ balances: await db.stockBalance.count(), ledger: await db.stockLedger.count() }, stockBefore, 'replenishment does not write inventory authority')
  console.log('INVENTORY_UNCHANGED_PASS')
} finally {if(server)await new Promise(r=>server.close(r));await db.$disconnect();await dropDisposablePgDatabase(databaseUrl)}
