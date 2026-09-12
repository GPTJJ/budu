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
async function fixture({shipping=0,price=100,expiryMs=500}={}){
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
 const service=createOnlineCheckout(prisma,{env,wechat:{appId:'wx0123456789abcdef',mchId:'1111111111'},resolveCatalog:async({intent})=>{calls++;return {lines:intent.lines.map(line=>({...line,name:'Synthetic product',unitPriceCents:String(price),discountCents:'0'})),shippingCents:String(shipping),expiresAt:new Date(Date.now()+expiryMs).toISOString()}}})
 const quote=overrides=>service.quote(id,{requestKey:uuid(),lines:[{productId:id,skuId:id,quantity:1}],fulfillment:'PICKUP',walletRef:id,desiredSweetCardCents:'100',...overrides})
 return {id,env,service,quote,calls:()=>calls}
}
async function reconcile(id){
 const [a,l]=await Promise.all([prisma.sweetCardAccount.findUnique({where:{id}}),prisma.sweetCardLedger.aggregate({where:{accountId:id},_sum:{amountCents:true}})])
 assert.equal(a.balanceCents,l._sum.amountCents);return a.balanceCents
}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
test('expired plan and submit report definitive expiry only without settlement',async()=>{
 const f=await fixture(),q=await f.quote(),requestKey=uuid();await wait(600)
 for(const action of ['plan','submit'])await assert.rejects(f.service[action](f.id,{quoteId:q.id,requestKey}),{code:'ONLINE_QUOTE_EXPIRED',status:409})
 assert.equal(await prisma.onlineSettlement.count({where:{userId:f.id}}),0);assert.equal(await reconcile(f.id),100n)
})
test('original settled request remains recoverable after quote expiry; different request is not definitive expiry',async()=>{
 const f=await fixture(),q=await f.quote(),requestKey=uuid(),s=await f.service.submit(f.id,{quoteId:q.id,requestKey});await wait(600)
 assert.equal((await f.service.plan(f.id,{quoteId:q.id,requestKey})).settlementId,s.id)
 assert.equal((await f.service.submit(f.id,{quoteId:q.id,requestKey})).id,s.id)
 for(const action of ['plan','submit'])await assert.rejects(f.service[action](f.id,{quoteId:q.id,requestKey:uuid()}),e=>e.status===409 && e.code!=='ONLINE_QUOTE_EXPIRED')
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),1)
})
