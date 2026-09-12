import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {createOnlinePaymentFinalizer} from '../server/online-payment-finalizer.js'
import {createOnlineRefundFinalizer} from '../server/online-refund-finalizer.js'
import {createOnlineRefundService} from '../server/online-refund-service.js'
import {createOnlineRefund} from '../server/online-refund.js'
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
 const t=await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:s.id,type:'WECHAT'}}})
 const result={appid:cfg.appId,mchid:cfg.mchId,trade_type:'JSAPI',out_trade_no:t.merchantTradeNo,trade_state:'SUCCESS',transaction_id:uuid(),
  amount:{total:Number(s.wechatCents),currency:'CNY'},payer:{openid:f.id},success_time:new Date().toISOString()}
 return {...f,s,result}
}

const approve=createOnlineRefund(prisma,{authorize:async(tx,s,actor)=>{if(actor!==s.userId)throw Object.assign(Error('DENIED'),{status:403});return actor}})
async function paid({wxOnly=false,cardOnly=false,quantity=1,desired='100'}={}){
 const f=await fixture({shipping:cardOnly?0:10,price:100/quantity})
 const q=await f.quote({lines:[{productId:f.id,skuId:f.id,quantity}],...(wxOnly?{walletRef:null,desiredSweetCardCents:'0'}:{desiredSweetCardCents:desired})})
 const s=await f.service.submit(f.id,{quoteId:q.id,requestKey:uuid()})
 if(!cardOnly){const t=await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:s.id,type:'WECHAT'}}})
 await finalize(signed({appid:cfg.appId,mchid:cfg.mchId,trade_type:'JSAPI',out_trade_no:t.merchantTradeNo,trade_state:'SUCCESS',transaction_id:uuid(),amount:{total:Number(s.wechatCents),currency:'CNY'},payer:{openid:f.id},success_time:new Date().toISOString()}))}
 const request=(n=quantity,shipping='0',requestKey=uuid())=>({settlementId:s.id,actor:f.id,requestKey,items:[{productId:f.id,skuId:f.id,quantity:n}],shippingCents:shipping})
 return {...f,s,request}
}
test('SC-only full refund credits original ledger once and emits settled snapshot',async()=>{
 const f=await paid({cardOnly:true}),req=f.request();const a=await approve(req),b=await approve(req)
 assert.equal(a.id,b.id);assert.equal(a.status,'SETTLED');assert.equal(await reconcile(f.id),100n)
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REFUND'}}),1)
 assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'REFUNDED')
})
test('WX-only full allocation remains pending; provider acceptance is not settlement',async()=>{
 const f=await paid({wxOnly:true}),r=await approve(f.request(1,'10'))
 assert.equal(r.wechatCents,110n);assert.equal(r.sweetCardCents,0n);assert.equal(r.status,'PENDING')
 assert.equal(await reconcile(f.id),100n);assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'PAID')
})
test('mixed full refund holds SC credit until verified WX completion',async()=>{
 const f=await paid(),r=await approve(f.request(1,'10'))
 assert.equal(r.wechatCents,10n);assert.equal(r.sweetCardCents,100n);assert.equal(r.status,'PENDING');assert.equal(await reconcile(f.id),0n)
})
test('pending allocation occupies quantities and prevents refund overflow',async()=>{
 const f=await paid();await approve(f.request(1,'10'));await assert.rejects(approve(f.request(1,'10')))
 assert.equal(await prisma.onlineRefund.count({where:{settlementId:f.s.id}}),1);assert.equal(await reconcile(f.id),0n)
})
test('same request key with changed intent is denied',async()=>{
 const f=await paid(),r=f.request();await approve(r);await assert.rejects(approve({...r,shippingCents:'10'}),{status:409})
})
test('parallel partial SC-only refunds consume original quantities exactly',async()=>{
 const f=await paid({cardOnly:true,quantity:4})
 const rows=await Promise.all(Array.from({length:4},()=>approve(f.request(1))))
 assert.equal(rows.reduce((a,r)=>a+r.totalCents,0n),100n);assert.equal(await reconcile(f.id),100n)
 assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'REFUNDED')
})
test('full vs partial refund race admits only available allocation',async()=>{
 const f=await paid({cardOnly:true,quantity:4});const r=await Promise.allSettled([approve(f.request(4)),approve(f.request(1))])
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1)
 assert.ok([400,409].includes(r.find(x=>x.status==='rejected').reason.status));await reconcile(f.id)
})
test('duplicate concurrent refund approval credits exactly once',async()=>{
 const f=await paid({cardOnly:true}),req=f.request();const r=await Promise.all([approve(req),approve(req),approve(req)])
 assert.equal(new Set(r.map(x=>x.id)).size,1);assert.equal(await reconcile(f.id),100n)
})
test('unauthorized approval does not create financial intent',async()=>{
 const f=await paid();await assert.rejects(approve({...f.request(),actor:uuid()}),{status:403})
 assert.equal(await prisma.onlineRefund.count({where:{settlementId:f.s.id}}),0)
})

const refundFinalize=createOnlineRefundFinalizer(prisma,cfg)
async function refundResult(r,state='SUCCESS'){
 const wx=await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:r.settlementId,type:'WECHAT'}}})
 return {mchid:cfg.mchId,out_trade_no:wx.merchantTradeNo,transaction_id:wx.providerTransactionId,out_refund_no:r.merchantRefundNo,refund_id:r.providerRefundId||uuid(),status:state,success_time:new Date().toISOString(),amount:{total:Number(wx.amountCents),refund:Number(r.wechatCents??r.amountCents),currency:'CNY'}}
}
function refundSigned(result,{notify=false}={}){
 if(!notify)return signed(result)
 const nonce='123456789012',aad='refund',cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(cfg.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad))
 const plaintext={...result,refund_status:result.status};delete plaintext.status
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(plaintext)),cipher.final(),cipher.getAuthTag()])
 const input=signed({event_type:`REFUND.${result.status}`,resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'refund',nonce,associated_data:aad,ciphertext:encrypted.toString('base64')}})
 return {...input,source:'NOTIFY'}
}
test('mixed PROCESSING stays pending, verified SUCCESS credits once under duplicate callback',async()=>{
 const f=await paid({desired:'50'}),r=await approve(f.request(1,'10')),fact=await refundResult(r)
 await refundFinalize(refundSigned({...fact,status:'PROCESSING'}));assert.equal(await reconcile(f.id),50n)
 const rows=await Promise.all([refundFinalize(refundSigned(fact)),refundFinalize(refundSigned(fact,{notify:true}))])
 assert.ok(rows.every(x=>x.status==='SETTLED'));assert.equal(await reconcile(f.id),100n)
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REFUND'}}),1)
})
test('multiple mixed partial allocations settle out of order and reconcile final full split',async()=>{
 const f=await paid({quantity:4,desired:'51'})
 const refunds=[];for(let i=0;i<4;i++)refunds.push(await approve(f.request(1,i===3?'10':'0')))
 assert.equal(refunds.reduce((n,r)=>n+r.sweetCardCents,0n),51n);assert.equal(refunds.reduce((n,r)=>n+r.wechatCents,0n),59n)
 for(const r of refunds.reverse())await refundFinalize(refundSigned(await refundResult(r)))
 assert.equal(await reconcile(f.id),100n);assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'REFUNDED')
})
test('forged/wrong refund evidence cannot credit or settle',async()=>{
 const f=await paid({desired:'50'}),r=await approve(f.request(1,'10')),fact=await refundResult(r)
 for(const change of [{transaction_id:uuid()},{amount:{total:60,refund:59,currency:'CNY'}},{mchid:'2222222222'}])await assert.rejects(refundFinalize(refundSigned({...fact,...change})))
 const input=refundSigned(fact);input.rawBody=Buffer.from('{}');await assert.rejects(refundFinalize(input))
 assert.equal(await reconcile(f.id),50n);assert.equal((await prisma.onlineRefund.findUnique({where:{id:r.id}})).status,'PENDING')
})
test('provider timeout recovery queries same refund identity and never repeats SC credit',async()=>{
 const f=await paid({desired:'50'}),r=await approve(f.request(1,'10'));let accepted=false,posts=0;const fact=await refundResult(r)
 const service=createOnlineRefundService(prisma,{...cfg,notifyUrl:'https://buducandy.cn/api/online-checkout/wechat/notify'},{request:async(method,path,body)=>{
  if(method==='GET')return accepted?signed(fact):{...signed({code:'RESOURCE_NOT_EXISTS'}),statusCode:404}
  assert.equal(body.out_refund_no,r.merchantRefundNo);assert.equal(body.amount.refund,60);posts++;accepted=true;throw Error('synthetic lost ack')
 }})
 await assert.rejects(service.recover(r.merchantRefundNo));assert.equal(await reconcile(f.id),50n)
 assert.equal((await service.recover(r.merchantRefundNo)).status,'SETTLED');assert.equal(posts,1);assert.equal(await reconcile(f.id),100n)
})
test('late payment compensation verified refund does not debit or credit SC',async()=>{
 const f=await pending();await cancellation.request(f.s.id,f.id);await cancellation.confirm(signed({...f.result,trade_state:'CLOSED'}));await finalize(signed(f.result))
 const r=await prisma.onlinePaymentCompensation.findUnique({where:{providerTransactionId:f.result.transaction_id}})
 await refundFinalize(refundSigned(await refundResult(r)));assert.equal(await reconcile(f.id),100n)
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id}}),1)
 assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'CANCELLED')
})
test('WX-only verified full refund settles without touching any card ledger',async()=>{
 const f=await paid({wxOnly:true}),r=await approve(f.request(1,'10'));await refundFinalize(refundSigned(await refundResult(r)))
 assert.equal(await reconcile(f.id),100n);assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id}}),1)
 assert.equal((await prisma.onlineSettlement.findUnique({where:{id:f.s.id}})).status,'REFUNDED')
})
test('crash after SC refund ledger creation rolls back atomically; original retry succeeds',async()=>{
 const f=await paid({cardOnly:true}),req=f.request();let failOnce=true
 const wrapped={...prisma,$transaction:(fn,options)=>prisma.$transaction(tx=>fn(new Proxy(tx,{get(target,prop){
  if(prop==='onlineRefund')return new Proxy(target.onlineRefund,{get(model,method){if(method==='update')return async args=>{if(failOnce){failOnce=false;throw Error('synthetic precommit crash')}return model.update(args)};return model[method]}})
  return target[prop]
 }})),options)}
 const crashing=createOnlineRefund(wrapped,{authorize:async(tx,s,actor)=>actor})
 await assert.rejects(crashing(req));assert.equal(await reconcile(f.id),0n);assert.equal(await prisma.onlineRefund.count({where:{settlementId:f.s.id}}),0)
 await approve(req);assert.equal(await reconcile(f.id),100n);assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REFUND'}}),1)
})
test('shipping-only refund stays exclusively WX and does not consume merchandise allocation',async()=>{
 const f=await paid({desired:'50'});const req={...f.request(),items:[],shippingCents:'10'}
 const r=await approve(req);assert.equal(r.sweetCardCents,0n);assert.equal(r.wechatCents,10n)
 await refundFinalize(refundSigned(await refundResult(r)));assert.equal(await reconcile(f.id),50n)
 const rest=await approve(f.request());await refundFinalize(refundSigned(await refundResult(rest)));assert.equal(await reconcile(f.id),100n)
})
