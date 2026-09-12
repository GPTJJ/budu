import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {createOnlineRefund} from '../server/online-refund.js'
import {createOnlineFulfillment} from '../server/online-fulfillment.js'
import {createOnlineCheckout} from '../server/online-checkout.js'
const config=JSON.parse(fs.readFileSync(process.env.SC11B_NATIVE_CONFIG))
if(config.host!=='127.0.0.1'||config.database!=='budu_sc11b_native')throw Error('ISOLATED_NATIVE_DB_REQUIRED')
const prisma=new PrismaClient({datasourceUrl:`postgresql://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`})
after(()=>prisma.$disconnect())
const uuid=()=>crypto.randomUUID()
async function fixture({shipping=0,price=100}={}){
 const id=uuid(),token=uuid();const expiresAt=new Date(Date.now()+86400000)
 await prisma.$transaction(async tx=>{
  await tx.user.create({data:{id,username:id,passwordHash:'synthetic'}})
  await tx.weChatAuthIdentity.create({data:{id:uuid(),provider:'WECHAT_MINIPROGRAM',appId:'wx0123456789abcdef',openId:id,userId:id}})
  await tx.inventoryItem.create({data:{id,name:`Synthetic ${id}`,sku:id,isActive:true,salePriceCents:BigInt(price)}})
  await tx.onlineProductPolicy.create({data:{id,namespace:'cloudbase-miniprogram',externalProductId:id,externalSkuId:id,productId:id,enabled:true,updatedById:id}})
  await tx.sweetCardAccount.create({data:{id,publicCardNo:id,initialAmountCents:100n,balanceCents:100n,validityType:'LONG_TERM',status:'ACTIVE',carrierType:'ELECTRONIC',bindingMode:'REQUIRED',
   onlinePolicy:{create:{enabled:true,updatedById:id}},binding:{create:{id,userId:id,boundById:id}},
   ledger:{create:{id,type:'ISSUE',amountCents:100n,balanceAfterCents:100n,requestKey:id}}}})
  await tx.sweetCardClaimToken.create({data:{id:token,accountId:id,tokenHash:uuid(),proofHash:uuid(),expiresAt,createdById:id}})
  await tx.sweetCardClaim.create({data:{id,accountId:id,userId:id,tokenId:token,sourceCarrier:'ELECTRONIC',requestKeyHash:id}})
 })
 const env={SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST:id}
 let calls=0
 const service=createOnlineCheckout(prisma,{env,wechat:{appId:'wx0123456789abcdef',mchId:'1111111111'},resolveCatalog:async({intent})=>{calls++;return {lines:intent.lines.map(line=>({...line,name:'Synthetic product',unitPriceCents:String(price),discountCents:'0'})),shippingCents:String(shipping)}}})
 const quote=overrides=>service.quote(id,{requestKey:uuid(),lines:[{productId:id,skuId:id,quantity:1}],fulfillment:'PICKUP',walletRef:id,desiredSweetCardCents:'100',...overrides})
 return {id,env,service,quote,calls:()=>calls}
}
async function reconcile(id){
 const [a,l]=await Promise.all([prisma.sweetCardAccount.findUnique({where:{id}}),prisma.sweetCardLedger.aggregate({where:{accountId:id},_sum:{amountCents:true}})])
 assert.equal(a.balanceCents,l._sum.amountCents);return a.balanceCents
}
async function paid(){const f=await fixture(),q=await f.quote(),s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()});return {...f,s}}
const authorize=async(tx,{settlement})=>({actorId:settlement.userId}) // Synthetic permission authority, not production ownership policy.
test('PAID pickup authorization is durable/idempotent and leaves money/version/outbox unchanged',async()=>{
 const f=await paid(),service=createOnlineFulfillment(prisma,{authorize}),input={settlementId:f.s.id,requestKey:uuid(),method:'PICKUP'}
 const count=await prisma.onlineOutbox.count({where:{settlementId:f.s.id}})
 const [a,b]=await Promise.all([service.authorize(input),service.authorize(input)]);assert.equal(a.id,b.id)
 assert.equal(await prisma.onlineFulfillmentAuthorization.count({where:{settlementId:f.s.id}}),1)
 assert.equal(await reconcile(f.id),0n);assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).version,f.s.version)
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:f.s.id}}),count)
 await assert.rejects(service.authorize({...input,requestKey:uuid()}));
 await assert.rejects(prisma.onlineFulfillmentAuthorization.update({where:{id:a.id},data:{actorId:'tamper'}}))
 await assert.rejects(prisma.onlineFulfillmentAuthorization.delete({where:{id:a.id}}))
})
test('pending settlement and delivery/pickup mismatch deny without authorization record',async()=>{
 const f=await fixture({shipping:10}),q=await f.quote(),s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 const service=createOnlineFulfillment(prisma,{authorize});await assert.rejects(service.authorize({settlementId:s.id,requestKey:uuid(),method:'PICKUP'}))
 const p=await paid();await assert.rejects(service.authorize({settlementId:p.s.id,requestKey:uuid(),method:'DELIVERY',carrierCode:'SF',trackingNo:'SF123'}))
 assert.equal(await prisma.onlineFulfillmentAuthorization.count({where:{settlementId:{in:[s.id,p.s.id]}}}),0)
})
test('permission required on initial request and replay; no customer authority fallback',async()=>{
 assert.throws(()=>createOnlineFulfillment(prisma),/AUTHORITY_REQUIRED/)
 const f=await paid(),input={settlementId:f.s.id,requestKey:uuid(),method:'PICKUP'}
 let allowed=true;const service=createOnlineFulfillment(prisma,{authorize:async()=>allowed?{actorId:'synthetic-authorized-merchant'}:null})
 await service.authorize(input);allowed=false;await assert.rejects(service.authorize(input),e=>e.status===403)
})
test('delivery requires bounded carrier/tracking and persists immutable identifiers',async()=>{
 const f=await fixture(),q=await f.quote({fulfillment:'DELIVERY',addressRef:'synthetic-address'}),s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 const service=createOnlineFulfillment(prisma,{authorize}),input={settlementId:s.id,requestKey:uuid(),method:'DELIVERY',carrierCode:'SF',trackingNo:'SF12345'}
 const a=await service.authorize(input);assert.equal(a.carrierCode,'SF');assert.equal(a.trackingNo,'SF12345')
 await assert.rejects(service.authorize({...input,trackingNo:'SF12346'}));await assert.rejects(service.authorize({...input,carrierCode:'bad\n'}))
})
test('refund approval wins shared settlement lock: fulfillment waits then denies',async()=>{
 const f=await paid();let entered,release;const acquired=new Promise(r=>entered=r),barrier=new Promise(r=>release=r)
 const refund=createOnlineRefund(prisma,{authorize:async()=>{entered();await barrier;return 'synthetic-merchant'}})
 const refunding=refund({settlementId:f.s.id,requestKey:uuid(),items:[{productId:f.id,skuId:f.id,quantity:1}]})
 await acquired
 const fulfilling=createOnlineFulfillment(prisma,{authorize}).authorize({settlementId:f.s.id,requestKey:uuid(),method:'PICKUP'})
 const denied=assert.rejects(fulfilling,e=>e.status===409);release();await refunding;await denied
 assert.equal(await prisma.onlineFulfillmentAuthorization.count({where:{settlementId:f.s.id}}),0)
 assert.equal(await reconcile(f.id),100n)
})
test('authorized fulfillment remains immutable after later legitimate refund; replay creates nothing',async()=>{
 const f=await paid(),service=createOnlineFulfillment(prisma,{authorize}),input={settlementId:f.s.id,requestKey:uuid(),method:'PICKUP'}
 const original=await service.authorize(input)
 await createOnlineRefund(prisma,{authorize:async()=> 'synthetic-merchant'})({settlementId:f.s.id,requestKey:uuid(),items:[{productId:f.id,skuId:f.id,quantity:1}]})
 const replay=await service.authorize(input);assert.equal(replay.id,original.id);assert.deepEqual(replay.authorizedAt,original.authorizedAt)
 assert.equal(await prisma.onlineFulfillmentAuthorization.count({where:{settlementId:f.s.id}}),1);assert.equal(await reconcile(f.id),100n)
})
