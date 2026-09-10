import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {createOnlinePaymentService} from '../server/online-payment-service.js'
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
const cfg={appId:'wx0123456789abcdef',mchId:'1111111111',platformKeyId:'SYNTHETIC',platformPublicKey:keys.publicKey.export({type:'spki',format:'pem'}),apiV3Key:'1'.repeat(32),merchantPrivateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),merchantSerial:'ABCD',notifyUrl:'https://buducandy.cn/api/online-checkout/wechat/notify'}
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
const absent=()=>({...signed({code:'ORDER_NOT_EXIST'}),statusCode:404})
function emptyClose(){
 const rawBody=Buffer.alloc(0),timestamp=String(Math.floor(Date.now()/1000)),nonce=uuid()
 return {rawBody,statusCode:204,headers:{'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':cfg.platformKeyId,
 'wechatpay-signature':crypto.sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n\n`),keys.privateKey).toString('base64')}}
}
test('prepay uses immutable WX remainder and signs client payment parameters',async()=>{
 const f=await pending(),calls=[]
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method,path,body)=>{
  calls.push({method,path,body});return method==='GET'?absent():signed({prepay_id:'synthetic-prepay'})
 }})
 const r=await svc.prepare(f.s.id,f.id);assert.equal(r.status,'PENDING');assert.equal(calls.length,2)
 assert.equal(calls[1].body.amount.total,10);assert.equal(calls[1].body.payer.openid,f.id)
 assert.equal(calls[1].body.out_trade_no,f.result.out_trade_no);assert.equal(await reconcile(f.id),100n)
 const p=r.paymentParameters
 assert.equal(crypto.verify('RSA-SHA256',Buffer.from(`${cfg.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`),keys.publicKey,Buffer.from(p.paySign,'base64')),true)
 assert.ok((await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:f.s.id,type:'WECHAT'}}})).prepayRequestedAt)
})
test('retry queries original identity and reuses stored prepay, no second POST',async()=>{
 const f=await pending();let posts=0
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method)=>{
  if(method==='GET')return posts?signed({...f.result,trade_state:'NOTPAY'}):absent()
  posts++;return signed({prepay_id:'synthetic-prepay'})
 }})
 await svc.prepare(f.s.id,f.id);assert.ok((await svc.prepare(f.s.id,f.id)).paymentParameters);assert.equal(posts,1)
})
test('ambiguous prepay failure retains attempted marker and cancellation hold',async()=>{
 const f=await pending()
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method)=>{if(method==='GET')return absent();throw Error('SYNTHETIC_TIMEOUT')}})
 await assert.rejects(svc.prepare(f.s.id,f.id))
 assert.equal((await svc.cancel(f.s.id,f.id)).status,'CLOSING')
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:f.s.id}})).status,'RESERVED');assert.equal(await reconcile(f.id),100n)
})
test('cancel before any dispatch releases locally and blocks future prepay',async()=>{
 const f=await pending();let calls=0
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async()=>{calls++;throw Error('MUST_NOT_CALL')}})
 assert.equal((await svc.cancel(f.s.id,f.id)).status,'CANCELLED')
 assert.equal((await svc.prepare(f.s.id,f.id)).status,'CANCELLED');assert.equal(calls,0);assert.equal(await reconcile(f.id),100n)
})
test('cancel during pending prepay response never returns usable client parameters',async()=>{
 const f=await pending();let providerExists=false,closed=false,release,started
 const barrier=new Promise(resolve=>{started=resolve}),waiting=new Promise(resolve=>{release=resolve})
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method,path)=>{
  if(method==='GET')return providerExists?signed({...f.result,trade_state:closed?'CLOSED':'NOTPAY'}):absent()
  if(path.endsWith('/close')){closed=true;return emptyClose()}
  providerExists=true;started();await waiting;return signed({prepay_id:'synthetic-prepay'})
 }})
 const preparing=svc.prepare(f.s.id,f.id);await barrier
 assert.equal((await svc.cancel(f.s.id,f.id)).status,'CANCELLED');release()
 const result=await preparing;assert.equal(result.status,'CANCELLED');assert.equal(result.paymentParameters,undefined);assert.equal(await reconcile(f.id),100n)
})
test('query-paid during retry finalizes instead of issuing another payment',async()=>{
 const f=await pending();const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method)=>{assert.equal(method,'GET');return signed(f.result)}})
 const result=await svc.prepare(f.s.id,f.id);assert.equal(result.status,'PAID');assert.equal(result.paymentParameters,undefined);assert.equal(await reconcile(f.id),0n)
})
test('unsigned prepay/query response cannot authorize client payment',async()=>{
 const f=await pending();const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async()=>({statusCode:404,headers:{},rawBody:Buffer.from('{"code":"ORDER_NOT_EXIST"}')})})
 await assert.rejects(svc.prepare(f.s.id,f.id),{status:401});assert.equal(await reconcile(f.id),100n)
})
test('unrelated customer and feature OFF cannot dispatch new payment',async()=>{
 const f=await pending();let calls=0;const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async()=>{calls++;throw Error('MUST_NOT_CALL')}})
 await assert.rejects(svc.prepare(f.s.id,'other'))
 f.env.SWEET_CARD_ONLINE_PAYMENT_ENABLED='0';await assert.rejects(svc.prepare(f.s.id,f.id),{status:403});assert.equal(calls,0)
 assert.equal((await svc.cancel(f.s.id,f.id)).status,'CANCELLED')
})
test('concurrent prepares converge on one immutable provider prepay identity',async()=>{
 const f=await pending();let posts=0
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method)=>{
  if(method==='GET')return absent();posts++;await new Promise(resolve=>setTimeout(resolve,20));return signed({prepay_id:'same-provider-prepay'})
 }})
 const results=await Promise.all([svc.prepare(f.s.id,f.id),svc.prepare(f.s.id,f.id)])
 assert.ok(results.every(r=>r.paymentParameters.package==='prepay_id=same-provider-prepay'))
 assert.ok(posts>=1&&posts<=2)
 assert.equal(await prisma.onlineTender.count({where:{settlementId:f.s.id,type:'WECHAT'}}),1)
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),0);assert.equal(await reconcile(f.id),100n)
})
test('close before delayed POST dispatch retains hold until provider closure is verified',async()=>{
 const f=await pending();let exists=false,closed=false,release,started
 const barrier=new Promise(resolve=>{started=resolve}),waiting=new Promise(resolve=>{release=resolve})
 const svc=createOnlinePaymentService(prisma,cfg,{env:f.env,request:async(method,path)=>{
  if(method==='GET')return exists?signed({...f.result,trade_state:closed?'CLOSED':'NOTPAY'}):absent()
  if(path.endsWith('/close')){closed=true;return emptyClose()}
  started();await waiting;exists=true;return signed({prepay_id:'late-prepay'})
 }})
 const preparing=svc.prepare(f.s.id,f.id);await barrier
 assert.equal((await svc.cancel(f.s.id,f.id)).status,'CLOSING')
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:f.s.id}})).status,'RESERVED')
 release();const response=await preparing;assert.equal(response.paymentParameters,undefined)
 assert.equal((await svc.recover(f.s.id)).status,'CANCELLED');assert.equal(await reconcile(f.id),100n)
})
