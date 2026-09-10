import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PrismaClient} from '@prisma/client'
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
test('mixed checkout reserves without economic debit; freight stays WX',async()=>{
 const f=await fixture({shipping:10});const q=await f.quote();assert.equal(q.snapshot.wechatCents,'10')
 const s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()});assert.equal(s.status,'PENDING')
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:s.id}})).status,'RESERVED')
 assert.equal(await reconcile(f.id),100n);assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id}}),1)
})
test('card-only atomically captures and produces paid event without WX',async()=>{
 const f=await fixture();const q=await f.quote();const s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 assert.equal(s.status,'PAID');assert.equal(await reconcile(f.id),0n)
 assert.equal(await prisma.onlineTender.count({where:{settlementId:s.id,type:'WECHAT'}}),0)
 assert.equal((await prisma.onlineOutbox.findUnique({where:{eventKey:`online:${s.id}:1`}})).payload.status,'PAID')
})
test('same checkout request concurrently creates one capture',async()=>{
 const f=await fixture(),q=await f.quote(),requestKey=uuid()
 const rows=await Promise.all([f.service.submit(f.id,{quoteId:q.id,requestKey}),f.service.submit(f.id,{quoteId:q.id,requestKey})])
 assert.equal(rows[0].id,rows[1].id);assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),1)
 assert.equal(await reconcile(f.id),0n)
})
test('two mixed orders cannot reserve same card value twice',async()=>{
 const f=await fixture({shipping:10}),a=await f.quote(),b=await f.quote()
 const result=await Promise.allSettled([f.service.submit(f.id,{quoteId:a.id,requestKey:uuid()}),f.service.submit(f.id,{quoteId:b.id,requestKey:uuid()})])
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1)
 assert.equal(result.find(x=>x.status==='rejected').reason.status,409)
 assert.equal((await prisma.sweetCardReservation.aggregate({where:{accountId:f.id,status:'RESERVED'},_sum:{amountCents:true}}))._sum.amountCents,100n)
 assert.equal(await reconcile(f.id),100n)
})
test('WX-only has no reservation',async()=>{
 const f=await fixture(),q=await f.quote({walletRef:null,desiredSweetCardCents:'0'})
 const s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 assert.equal(s.wechatCents,100n);assert.equal(await prisma.sweetCardReservation.count({where:{settlementId:s.id}}),0)
})
test('quote retry ignores fresh prices but rejects changed intent',async()=>{
 const f=await fixture(),requestKey=uuid(),q=await f.quote({requestKey})
 assert.equal((await f.quote({requestKey})).id,q.id);assert.equal(f.calls(),1)
 await assert.rejects(f.quote({requestKey,desiredSweetCardCents:'99'}),{status:409})
})
test('client price/eligibility fields never become authority',async()=>{
 const f=await fixture();const q=await f.quote({lines:[{productId:f.id,skuId:f.id,quantity:1,unitPriceCents:'1',onlineEligible:true}]})
 assert.equal(q.snapshot.totalCents,'100')
})
test('nonowner quote is denied',async()=>{
 const a=await fixture(),b=await fixture();await assert.rejects(b.quote({walletRef:a.id}),{status:403})
})
test('frozen card after quote cannot submit',async()=>{
 const f=await fixture(),q=await f.quote();await prisma.sweetCardAccount.update({where:{id:f.id},data:{status:'FROZEN'}})
 await assert.rejects(f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()}),{status:403});assert.equal(await reconcile(f.id),100n)
})
test('feature OFF blocks new purchase but permits original submit replay',async()=>{
 const f=await fixture(),q=await f.quote(),requestKey=uuid(),s=await f.service.submit(f.id,{quoteId:q.id,requestKey})
 f.env.SWEET_CARD_ONLINE_PAYMENT_ENABLED='0';assert.equal((await f.service.submit(f.id,{quoteId:q.id,requestKey})).id,s.id)
 await assert.rejects(f.quote(),{status:403})
})
test('revoked product eligibility after quote rejects card checkout',async()=>{
 const f=await fixture(),q=await f.quote();await prisma.onlineProductPolicy.update({where:{id:f.id},data:{enabled:false}})
 await assert.rejects(f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()}),{status:409});assert.equal(await reconcile(f.id),100n)
})
test('same quote with different submit key cannot capture twice',async()=>{
 const f=await fixture(),q=await f.quote();await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 await assert.rejects(f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()}))
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),1)
})
test('WX-only concurrent double-key submit is constrained by immutable quote identity',async()=>{
 const f=await fixture(),q=await f.quote({walletRef:null,desiredSweetCardCents:'0'})
 const results=await Promise.allSettled([f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()}),f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})])
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
 assert.equal(results.find(x=>x.status==='rejected').reason.status,409)
 assert.equal(await prisma.onlineSettlement.count({where:{quoteId:q.id}}),1)
 assert.equal(await reconcile(f.id),100n)
})
