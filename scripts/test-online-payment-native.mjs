import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {createOnlinePaymentFinalizer} from '../server/online-payment-finalizer.js'
import {createOnlinePaymentCancellation} from '../server/online-payment-cancellation.js'
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
 const service=createOnlineCheckout(prisma,{env,resolveCatalog:async({intent})=>{calls++;return {lines:intent.lines.map(line=>({...line,name:'Synthetic product',unitPriceCents:String(price),discountCents:'0'})),shippingCents:String(shipping)}}})
 const quote=overrides=>service.quote(id,{requestKey:uuid(),lines:[{productId:id,skuId:id,quantity:1}],fulfillment:'PICKUP',walletRef:id,desiredSweetCardCents:'100',...overrides})
 return {id,env,service,quote,calls:()=>calls}
}
async function reconcile(id){
 const [a,l]=await Promise.all([prisma.sweetCardAccount.findUnique({where:{id}}),prisma.sweetCardLedger.aggregate({where:{accountId:id},_sum:{amountCents:true}})])
 assert.equal(a.balanceCents,l._sum.amountCents);return a.balanceCents
}
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048})
const cfg={appId:'wx0123456789abcdef',mchId:'1111111111',platformKeyId:'SYNTHETIC',platformPublicKey:keys.publicKey.export({type:'spki',format:'pem'}),apiV3Key:'1'.repeat(32)}
const finalize=createOnlinePaymentFinalizer(prisma,cfg)
const cancellation=createOnlinePaymentCancellation(prisma,cfg)
function signed(result,{notify=false}={}){
 let body=result
 if(notify){
  const nonce='123456789012',aad='transaction',cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(cfg.apiV3Key),Buffer.from(nonce))
  cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(JSON.stringify(result)),cipher.final(),cipher.getAuthTag()])
  body={event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',nonce,associated_data:aad,ciphertext:encrypted.toString('base64')}}
 }
 const rawBody=Buffer.from(JSON.stringify(body)),timestamp=String(Math.floor(Date.now()/1000)),nonce=uuid()
 return {source:notify?'NOTIFY':'QUERY',statusCode:200,rawBody,headers:{'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':cfg.platformKeyId,
  'wechatpay-signature':crypto.sign('RSA-SHA256',Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`),rawBody,Buffer.from('\n')]),keys.privateKey).toString('base64')}}
}
async function pending({wxOnly=false,expiresIn=null}={}){
 const f=await fixture({shipping:10})
 if(expiresIn)await prisma.sweetCardAccount.update({where:{id:f.id},data:{expiresAt:new Date(Date.now()+expiresIn)}})
 const q=await f.quote(wxOnly?{walletRef:null,desiredSweetCardCents:'0'}:{}),s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 await prisma.weChatAuthIdentity.create({data:{id:uuid(),provider:'WECHAT_MINIPROGRAM',appId:cfg.appId,openId:f.id,userId:f.id}})
 const t=await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:s.id,type:'WECHAT'}}})
 const result={appid:cfg.appId,mchid:cfg.mchId,trade_type:'JSAPI',out_trade_no:t.merchantTradeNo,trade_state:'SUCCESS',transaction_id:uuid(),
  amount:{total:Number(s.wechatCents),currency:'CNY'},payer:{openid:f.id},success_time:new Date().toISOString()}
 return {...f,s,result}
}
test('signed mixed payment captures once with exact ledger and paid outbox',async()=>{
 const f=await pending(),r=await finalize(signed(f.result));assert.equal(r.status,'PAID');assert.equal(await reconcile(f.id),0n)
 assert.equal((await prisma.onlineOutbox.findUnique({where:{eventKey:`online:${f.s.id}:2`}})).payload.status,'PAID')
})
test('signed notification and query race produce one capture/event',async()=>{
 const f=await pending();const r=await Promise.all([finalize(signed(f.result)),finalize(signed(f.result,{notify:true}))])
 assert.ok(r.every(x=>x.status==='PAID'));assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),1)
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:f.s.id}}),2);assert.equal(await reconcile(f.id),0n)
})
test('WeChat-only verified payment creates no card ledger/reservation',async()=>{
 const f=await pending({wxOnly:true});assert.equal((await finalize(signed(f.result))).status,'PAID');assert.equal(await reconcile(f.id),100n)
 assert.equal(await prisma.sweetCardReservation.count({where:{settlementId:f.s.id}}),0)
})
test('forged or altered bytes never enter financial transaction',async()=>{
 const f=await pending(),input=signed(f.result);input.rawBody=Buffer.from(JSON.stringify({...f.result,transaction_id:'changed'}))
 await assert.rejects(finalize(input),{status:401});assert.equal(await reconcile(f.id),100n)
 assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'PENDING')
})
test('valid signature with wrong amount, currency, app, merchant or payer denied',async()=>{
 const f=await pending()
 for(const change of [{amount:{total:11,currency:'CNY'}},{amount:{total:10,currency:'USD'}},{appid:'wrong'},{mchid:'wrong'},{payer:{openid:'wrong'}}])
  await assert.rejects(finalize(signed({...f.result,...change})))
 assert.equal(await reconcile(f.id),100n)
})
test('NOTPAY query retains reservation and no additional outbox',async()=>{
 const f=await pending();const r=await finalize(signed({...f.result,trade_state:'NOTPAY'}));assert.equal(r.status,'PENDING')
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:f.s.id}})).status,'RESERVED')
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:f.s.id}}),1)
})
test('frozen after reservation records durable compensation without SC debit',async()=>{
 const f=await pending();await prisma.sweetCardAccount.update({where:{id:f.id},data:{status:'FROZEN'}})
 const r=await finalize(signed(f.result));assert.equal(r.status,'RECONCILIATION_REQUIRED');assert.equal(await reconcile(f.id),100n)
 const c=await prisma.onlinePaymentCompensation.findUnique({where:{providerTransactionId:f.result.transaction_id}})
 assert.equal(c.amountCents,10n);assert.equal(c.status,'PENDING')
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:f.s.id}})).status,'RELEASED')
 await finalize(signed(f.result,{notify:true}));assert.equal(await prisma.onlinePaymentCompensation.count({where:{settlementId:f.s.id}}),1)
})
test('callback recovery ignores new-checkout flag OFF',async()=>{
 const f=await pending();f.env.SWEET_CARD_ONLINE_PAYMENT_ENABLED='0';assert.equal((await finalize(signed(f.result))).status,'PAID')
})
test('provider transaction cannot be reused across orders',async()=>{
 const a=await pending(),b=await pending();await finalize(signed(a.result))
 await assert.rejects(finalize(signed({...b.result,transaction_id:a.result.transaction_id})))
 assert.equal(await reconcile(b.id),100n);assert.equal((await prisma.onlineSettlement.findUnique({where:{id:b.s.id}})).status,'PENDING')
})
test('HTTP error, wrong serial and malformed success cannot settle',async()=>{
 const f=await pending();const x=signed(f.result);x.statusCode=500;await assert.rejects(finalize(x),{status:401})
 const y=signed(f.result);y.headers['wechatpay-serial']='WRONG';await assert.rejects(finalize(y),{status:401})
 for(const change of [{success_time:'invalid'},{transaction_id:''},{trade_type:'NATIVE'},{amount:{total:'10',currency:'CNY'}}])await assert.rejects(finalize(signed({...f.result,...change})),{status:401})
 assert.equal(await reconcile(f.id),100n)
})
test('cancel request/NOTPAY retains hold; signed CLOSED releases without ledger',async()=>{
 const f=await pending();assert.equal((await cancellation.request(f.s.id,f.id)).status,'CLOSING')
 await cancellation.confirm(signed({...f.result,trade_state:'NOTPAY'}))
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:f.s.id}})).status,'RESERVED')
 assert.equal((await cancellation.confirm(signed({...f.result,trade_state:'CLOSED'}))).status,'CANCELLED')
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:f.s.id}})).status,'RELEASED')
 assert.equal(await reconcile(f.id),100n)
})
test('payment wins then cancellation cannot overwrite paid state',async()=>{
 const f=await pending();await finalize(signed(f.result));assert.equal((await cancellation.request(f.s.id,f.id)).status,'PAID')
 assert.equal((await cancellation.confirm(signed({...f.result,trade_state:'CLOSED'}))).status,'PAID');assert.equal(await reconcile(f.id),0n)
})
test('late paid after release records compensation and never captures',async()=>{
 const f=await pending();await cancellation.request(f.s.id,f.id);await cancellation.confirm(signed({...f.result,trade_state:'CLOSED'}))
 assert.equal((await finalize(signed(f.result))).status,'RECONCILIATION_REQUIRED');assert.equal(await reconcile(f.id),100n)
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),0)
 assert.equal(await prisma.onlinePaymentCompensation.count({where:{settlementId:f.s.id}}),1)
 await finalize(signed(f.result,{notify:true}))
 assert.equal(await prisma.onlinePaymentCompensation.count({where:{settlementId:f.s.id}}),1)
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:f.s.id}}),4)
})
test('concurrent closed-query and callback preserve payment or compensation',async()=>{
 const f=await pending();await cancellation.request(f.s.id,f.id)
 await Promise.all([cancellation.confirm(signed({...f.result,trade_state:'CLOSED'})),finalize(signed(f.result))])
 const s=await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})
 assert.ok(['PAID','RECONCILIATION_REQUIRED'].includes(s.status))
 assert.equal(await reconcile(f.id),s.status==='PAID'?0n:100n)
 assert.equal(await prisma.onlinePaymentCompensation.count({where:{settlementId:f.s.id}}),s.status==='PAID'?0:1)
})
test('nonowner cannot cancel and unexpired recovery does not close',async()=>{
 const f=await pending();await assert.rejects(cancellation.request(f.s.id,'other'),{status:404})
 assert.equal((await cancellation.expire(f.s.id)).status,'PENDING');assert.equal(await reconcile(f.id),100n)
})
test('delayed in-validity payment settles even after card expiry and expiry intent',async()=>{
 const f=await pending({expiresIn:1000})
 await new Promise(resolve=>setTimeout(resolve,1100))
 await prisma.sweetCardAccount.update({where:{id:f.id},data:{status:'EXPIRED'}})
 assert.equal((await cancellation.expire(f.s.id)).status,'CLOSING')
 assert.equal((await cancellation.confirm(signed(f.result))).status,'PAID');assert.equal(await reconcile(f.id),0n)
})
test('expiry requires verified CLOSED; late payment is compensated after EXPIRED',async()=>{
 const f=await pending({expiresIn:1000})
 await new Promise(resolve=>setTimeout(resolve,1100));await cancellation.expire(f.s.id)
 assert.equal((await cancellation.confirm(signed({...f.result,trade_state:'CLOSED'}))).status,'EXPIRED')
 assert.equal((await finalize(signed(f.result))).status,'RECONCILIATION_REQUIRED');assert.equal(await reconcile(f.id),100n)
 await finalize(signed(f.result,{notify:true}))
 assert.equal(await prisma.onlinePaymentCompensation.count({where:{settlementId:f.s.id}}),1)
 assert.equal(await prisma.onlineOutbox.count({where:{settlementId:f.s.id}}),4)
})
