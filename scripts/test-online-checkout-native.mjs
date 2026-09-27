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
test('quote freezes commerce selections and rejects same-key changed combo/store',async()=>{
 const f=await fixture(),requestKey=uuid()
 const intent={requestKey,storeRef:'synthetic-store',lines:[{productId:f.id,skuId:f.id,quantity:1,options:['礼盒'],comboFlavors:['a','b']}]}
 const q=await f.quote(intent)
 assert.deepEqual(q.snapshot.commerceIntent,{storeRef:'synthetic-store',lines:intent.lines})
 await assert.rejects(f.quote({...intent,storeRef:'another-store'}),{status:409})
 await assert.rejects(f.quote({...intent,lines:[{...intent.lines[0],comboFlavors:['a','c']}]}),{status:409})
 assert.equal((await f.quote(intent)).id,q.id)
 const settled=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 assert.equal(settled.status,'PAID')
 assert.deepEqual((await prisma.onlineCheckoutQuote.findUnique({where:{id:q.id}})).snapshot.commerceIntent,q.snapshot.commerceIntent)
 assert.equal(await reconcile(f.id),0n)
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

// Real existing POS authority and online reservation share the same isolated account.
// No mocked economic operations and no Production configuration are used.
async function posFixture(f) {
 globalThis.__buduPrisma=prisma
 process.env.SWEET_CARD_ENABLED='1'
 process.env.XIDAN_SWEET_CARD_COMMERCIAL='1'
 const {redeemSweetCard}=await import('../server/sweet-card.js')
 const token=`budu:sc:v1:${uuid()}.isolated-only`,orderId=uuid()
 await prisma.sweetCardControl.upsert({where:{id:'GLOBAL'},create:{id:'GLOBAL',enabled:true},update:{enabled:true}})
 await prisma.store.create({data:{key:f.id,name:`Isolated POS competition ${f.id}`,active:true,operationType:'DIRECT',sweetCardPolicy:{create:{eligible:true}}}})
 await prisma.user.update({where:{id:f.id},data:{role:'staff',storeKeys:[f.id],permissions:{modules:{'store-pos':true}}}})
 await prisma.sweetCardCredential.create({data:{id:uuid(),accountId:f.id,publicTokenId:uuid(),tokenHash:crypto.createHash('sha256').update(token).digest('hex'),tokenCiphertext:'isolated',tokenIv:'isolated',tokenTag:'isolated',status:'ACTIVE',carrierType:'ELECTRONIC'}})
 await prisma.order.create({data:{id:orderId,orderNo:orderId,storeId:f.id,cashierId:f.id,subtotal:100n,payableAmount:100n,status:'pending_payment',paymentStatus:'unpaid',checkoutKey:orderId,cartHash:orderId,
  items:{create:{id:uuid(),productId:f.id,productNameSnapshot:'Synthetic',skuSnapshot:f.id,unitPrice:100n,costPriceSnapshot:0n,quantity:1,lineAmount:100n,actualAmount:100n}}}})
 return {orderId,redeem:()=>redeemSweetCard({orderId,token,amountCents:'100',requestKey:`pos:${orderId}`,actor:{id:f.id,name:'Synthetic'}})}
}
test('existing POS redemption cannot spend value held by an online reservation',async()=>{
 const f=await fixture({shipping:10}),p=await posFixture(f),q=await f.quote()
 await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 await assert.rejects(p.redeem(),{status:409})
 assert.equal(await prisma.sweetCardRedemption.count({where:{orderId:p.orderId}}),0)
 assert.equal(await reconcile(f.id),100n)
 assert.equal((await prisma.sweetCardReservation.aggregate({where:{accountId:f.id,status:'RESERVED'},_sum:{amountCents:true}}))._sum.amountCents,100n)
})
test('real POS redemption competes with online reservation without overspending',async()=>{
 const f=await fixture({shipping:10}),p=await posFixture(f),q=await f.quote()
 const results=await Promise.allSettled([p.redeem(),f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.ok([403,409].includes(results.find(r=>r.status==='rejected').reason.status))
 const held=(await prisma.sweetCardReservation.aggregate({where:{accountId:f.id,status:'RESERVED'},_sum:{amountCents:true}}))._sum.amountCents||0n
 const redeemed=(await prisma.sweetCardRedemption.aggregate({where:{accountId:f.id},_sum:{amountCents:true}}))._sum.amountCents||0n
 assert.equal(held+redeemed,100n)
 assert.equal(await reconcile(f.id),100n-redeemed)
 assert.ok((await reconcile(f.id))-held>=0n)
})
test('completed existing POS debit prevents later online reservation of the same value',async()=>{
 const f=await fixture({shipping:10}),p=await posFixture(f),q=await f.quote()
 await p.redeem()
 await assert.rejects(f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()}),error=>[403,409].includes(error.status))
 assert.equal(await prisma.sweetCardRedemption.count({where:{orderId:p.orderId}}),1)
 assert.equal(await prisma.sweetCardReservation.count({where:{accountId:f.id,status:'RESERVED'}}),0)
 assert.equal(await reconcile(f.id),0n)
})
