import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import {createRequire} from 'node:module'
import express from 'express'
import {PrismaClient} from '@prisma/client'
import {createCustomerSession} from '../server/customer-auth.js'
import {createOnlineCheckoutRouter,createOnlineWechatNotifyRouter} from '../server/online-checkout-api.js'
import {createOnlineCheckoutRuntime} from '../server/online-checkout-runtime.js'
import {createOnlineMirrorSigner} from '../server/online-mirror-signature.js'
import {createOnlineMirrorTransport} from '../server/online-mirror-transport.js'
import {deliverOnlineOutboxOnce} from '../server/online-outbox.js'

// Real isolated PostgreSQL + loopback HTTP + actual companion CloudBase modules.
// CloudBase database is a transactional in-memory adapter, NOT deployed SDK proof.
// Provider messages are synthetic cryptographically signed fixtures, NOT real money.
if(!process.env.SC11B_MP_REPO)throw Error('SC11B_MP_REPO_REQUIRED')
const require=createRequire(import.meta.url),mp=process.env.SC11B_MP_REPO
const {createOnlineCheckoutBridge}=require(path.join(mp,'cloudfunctions/orders/online-checkout-bridge.js'))
const {resolveOnlineMerchandise}=require(path.join(mp,'cloudfunctions/orders/online-catalog.js'))
const {productionGatewayHeaders,PRODUCTION_APP_ID,PRODUCTION_ENV_ID}=require(path.join(mp,'cloudfunctions/sweetCardApi/production-signature.js'))
const {createMirrorHttpHandler}=require(path.join(mp,'cloudfunctions/onlineFinancialMirror/http.js'))
const {createFinancialMirrorReceiver}=require(path.join(mp,'cloudfunctions/onlineFinancialMirror/receiver.js'))
const {createMirrorServerVerifier}=require(path.join(mp,'cloudfunctions/onlineFinancialMirror/auth.js'))
const config=JSON.parse(fs.readFileSync(process.env.SC11B_NATIVE_CONFIG))
if(config.host!=='127.0.0.1'||config.database!=='budu_sc11b_native')throw Error('ISOLATED_NATIVE_DB_REQUIRED')
const prisma=new PrismaClient({datasourceUrl:`postgresql://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`})
after(()=>prisma.$disconnect())
const uuid=()=>crypto.randomUUID(),copy=v=>v==null?v:JSON.parse(JSON.stringify(v))
const hash=v=>crypto.createHash('sha256').update(v).digest('hex')
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048})
const cfg={appId:PRODUCTION_APP_ID,mchId:'1111111111',platformKeyId:'SYNTHETIC',platformPublicKey:keys.publicKey.export({type:'spki',format:'pem'}),apiV3Key:'1'.repeat(32),merchantPrivateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),merchantSerial:'ABCD',notifyUrl:'https://buducandy.cn/api/online-checkout/wechat/notify'}
const merchantSecret='synthetic-merchant-separate-key-'.repeat(2)
const gateway={enabled:true,mode:'production',appId:PRODUCTION_APP_ID,cloudBaseEnvId:PRODUCTION_ENV_ID,gatewaySecret:'synthetic-gateway-secret-'.repeat(2),markerKey:'synthetic-session-marker-'.repeat(2)}
function signed(result,{notify=false,statusCode=200}={}){
 let body=result
 if(notify){
  const nonce='123456789012',aad='transaction',cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(cfg.apiV3Key),Buffer.from(nonce))
  cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(JSON.stringify(result)),cipher.final(),cipher.getAuthTag()])
  body={event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',nonce,associated_data:aad,ciphertext:encrypted.toString('base64')}}
 }
 const rawBody=Buffer.from(JSON.stringify(body)),timestamp=String(Math.floor(Date.now()/1000)),nonce=uuid()
 return {statusCode,rawBody,headers:{'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':cfg.platformKeyId,
 'wechatpay-signature':crypto.sign('RSA-SHA256',Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`),rawBody,Buffer.from('\n')]),keys.privateKey).toString('base64')}}
}
function commerceDatabase(products){
 const maps={onlineCheckoutDrafts:new Map(),orders:new Map(),onlineOrderLinks:new Map()}
 let tail=Promise.resolve()
 const collection=name=>{
  if(name==='products')return {where:({id})=>({limit:()=>({get:async()=>({data:copy(products.filter(p=>id.includes(p.id)))})})})}
  const map=maps[name];assert.ok(map)
  return {doc:id=>({get:async()=>({data:copy(map.get(id))}),set:async({data})=>map.set(id,copy(data)),update:async({data})=>map.set(id,{...map.get(id),...copy(data)})})}
 }
 return {maps,command:{in:x=>x},collection,runTransaction:fn=>{
  const next=tail.then(async()=>{const before=Object.fromEntries(Object.entries(maps).map(([k,m])=>[k,new Map([...m].map(([id,v])=>[id,copy(v)]))]));try{return await fn({collection})}catch(e){for(const [k,m]of Object.entries(maps)){m.clear();for(const [id,v]of before[k])m.set(id,v)}throw e}})
  tail=next.catch(()=>{});return next
 }}
}
async function fixture(t,{desired='100',delivery=false,balance=100n,combo=false,draftAgeMs=0}={}){
 const id=uuid(),token=uuid(),openId=uuid(),storeKey=uuid()
 const products=[{id,name:'隔离测试商品',status:'on',spec:'盒',unit:'盒',unitPriceCent:100}]
 // Combo's catalogue grammar is tested below through the actual resolver.
 const db=commerceDatabase(products),env={SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST:id}
 const context={OPENID:openId,APPID:cfg.appId}
 if(combo){products[0].combo={slots:2,repeat:true,flavorIds:['a','b']};products.push({id:'a',name:'杏仁',status:'on'},{id:'b',name:'核桃',status:'on'})}
 const input={requestKey:uuid(),lines:[{productId:id,quantity:1,...(combo?{comboFlavors:['b','a']}: {})}],fulfillment:delivery?'DELIVERY':'PICKUP',storeRef:storeKey,
  recipient:{name:'Synthetic recipient',contact:'synthetic-contact',address:'Synthetic isolated address'},walletRef:desired==='0'?null:id,desiredSweetCardCents:desired}
 const catalog=await resolveOnlineMerchandise(db,input.lines)
 await prisma.$transaction(async tx=>{
  await tx.user.create({data:{id,username:id,passwordHash:'synthetic',role:'customer'}})
  await tx.store.create({data:{key:storeKey,name:storeKey,active:true}})
  await tx.weChatAuthIdentity.create({data:{id:uuid(),provider:'WECHAT_MINIPROGRAM',appId:cfg.appId,openId,userId:id}})
  await tx.inventoryItem.create({data:{id,name:`Synthetic ${id}`,sku:id,isActive:true,salePriceCents:100n}})
  await tx.onlineProductPolicy.create({data:{id,namespace:'cloudbase-miniprogram',externalProductId:id,externalSkuId:catalog.lines[0].skuId,productId:id,enabled:true,updatedById:id}})
  await tx.sweetCardAccount.create({data:{id,publicCardNo:id,initialAmountCents:balance,balanceCents:balance,validityType:'LONG_TERM',status:'ACTIVE',carrierType:'ELECTRONIC',bindingMode:'REQUIRED',
   onlinePolicy:{create:{enabled:true,updatedById:id}},binding:{create:{id,userId:id,boundById:id}},
   ledger:{create:{id,type:'ISSUE',amountCents:balance,balanceAfterCents:balance,requestKey:id}}}})
  await tx.sweetCardClaimToken.create({data:{id:token,accountId:id,tokenHash:uuid(),proofHash:uuid(),expiresAt:new Date(Date.now()+86400000),createdById:id}})
  await tx.sweetCardClaim.create({data:{id,accountId:id,userId:id,tokenId:token,sourceCarrier:'ELECTRONIC',requestKeyHash:id}})
 })
 input.customerSession=(await createCustomerSession({userId:id,markerKey:gateway.markerKey,db:prisma})).rawToken
 const providerCalls=[],requests=[];let success=null,loss=false
 const runtime=createOnlineCheckoutRuntime({db:prisma,gatewayConfig:gateway,merchantGatewayConfig:{...gateway,gatewaySecret:merchantSecret},paymentConfig:cfg,mirrorConfig:{appId:cfg.appId,environment:PRODUCTION_ENV_ID,keyId:'synthetic-mirror',privateKey:cfg.merchantPrivateKey,endpoint:'https://mirror.test.internal/online-financial-mirror'},env,request:async(method,p,body)=>{
  providerCalls.push({method,path:p,body});return method==='GET'?(success?signed(success):signed({code:'ORDER_NOT_EXIST'},{statusCode:404})):signed({prepay_id:'synthetic-prepay'})
 }})
 const app=express();runtime.mount(app);app.use(express.json({limit:'15mb'}))
 t.after(()=>runtime.stop())
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const origin=`http://127.0.0.1:${server.address().port}`
 async function send(r){
  requests.push(copy(r));const headers={...r.headers,'content-type':'application/json',...productionGatewayHeaders({pathname:r.path,method:r.method,body:r.body,secret:gateway.gatewaySecret})}
  const res=await fetch(origin+'/api/v2'+r.path,{method:r.method,headers,body:JSON.stringify(r.body)})
  const data=await res.json();if(!res.ok||!data.ok)throw Object.assign(Error('SYNTHETIC_HTTP_DENIED'),{status:res.status})
  if(loss&&r.path.endsWith('/submit'))throw Error('SYNTHETIC_LOST_ACK')
  return data.result
 }
 const bridge=createOnlineCheckoutBridge({db,send,now:()=>Date.now()-draftAgeMs})
 const action=(name,settlementId,extra={})=>send({method:'POST',path:'/customer/online-checkout/'+name,headers:{authorization:`Bearer ${input.customerSession}`},body:{sessionHash:hash(input.customerSession),openId,settlementId,...extra}})
 const submitInput=q=>({customerSession:input.customerSession,quoteRequestKey:input.requestKey,quoteId:q.quoteId,requestKey:uuid()})
 async function fact(s){const wx=await prisma.onlineTender.findUnique({where:{settlementId_type:{settlementId:s.settlementId,type:'WECHAT'}}});return {appid:cfg.appId,mchid:cfg.mchId,trade_type:'JSAPI',out_trade_no:wx.merchantTradeNo,trade_state:'SUCCESS',transaction_id:uuid(),amount:{total:Number(s.wechatCents),currency:'CNY'},payer:{openid:openId},success_time:new Date().toISOString()}}
 async function notify(result,tamper=false){const e=signed(result,{notify:true});if(tamper)e.rawBody=Buffer.from('{}');return fetch(origin+'/api/online-checkout/wechat/notify',{method:'POST',headers:{...e.headers,'content-type':'application/json'},body:e.rawBody})}
 async function reconcile(){const a=await prisma.sweetCardAccount.findUnique({where:{id}}),l=await prisma.sweetCardLedger.aggregate({where:{accountId:id},_sum:{amountCents:true}});assert.equal(a.balanceCents,l._sum.amountCents);return a.balanceCents}
 return {id,db,input,context,bridge,action,submitInput,providerCalls,requests,products,origin,send,fact,notify,reconcile,env,storeKey,loseAck:v=>{loss=v},paid:v=>{success=v}}
}
test('HTTP E2E SC-only: catalogue price ignores tampering, native capture once, no fake WX, durable mirror',async t=>{
 const f=await fixture(t);f.input.totalCents='1';f.input.lines[0].unitPriceCents='1';
 const q=await f.bridge.quote(f.input,f.context);assert.equal(q.totalCents,'100');assert.equal(q.sweetCardCents,'100');assert.equal(q.userId,f.id)
 assert.equal(q.items[0].spec,'盒');assert.deepEqual(q.items[0].options,['盒'])
 const input=f.submitInput(q);f.loseAck(true);await assert.rejects(f.bridge.submit(input,f.context),/LOST_ACK/)
 f.loseAck(false);const s=await f.bridge.submit(input,f.context);assert.equal(s.status,'PAID');assert.equal(await f.reconcile(),0n)
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),1)
 assert.equal(await prisma.onlineTender.count({where:{settlementId:s.settlementId,type:'WECHAT'}}),0)
 assert.equal((await f.action('prepare',s.settlementId)).status,'PAID');assert.equal(f.providerCalls.length,0)
 const order=[...f.db.maps.orders.values()][0];assert.equal(order.status,'PENDING_PAYMENT');assert.equal(order.items[0].spec,'盒');assert.equal(f.db.maps.orders.size,1)
 const mirrorConfig={environment:PRODUCTION_ENV_ID,appId:cfg.appId,keyId:'synthetic-mirror'}
 const receive=createFinancialMirrorReceiver({db:f.db,authorizeServerRequest:createMirrorServerVerifier({...mirrorConfig,publicKey:cfg.platformPublicKey})})
 const sign=createOnlineMirrorSigner({...mirrorConfig,privateKey:cfg.merchantPrivateKey})
 const events=await prisma.onlineOutbox.findMany({where:{settlementId:s.settlementId},orderBy:{version:'asc'}})
 assert.equal(events.length,1);const e=events[0],message={eventKey:e.eventKey,version:e.version,payload:e.payload}
 const handle=createMirrorHttpHandler({db:f.db,authentication:{...mirrorConfig,publicKey:cfg.platformPublicKey}})
 let lose=true
 const deliver=createOnlineMirrorTransport({...mirrorConfig,privateKey:cfg.merchantPrivateKey,endpoint:'https://mirror.test.internal/online-financial-mirror'},{fetchImpl:async(url,options)=>{
  const result=await handle({httpMethod:options.method,headers:options.headers,body:options.body.toString('utf8')})
  if(lose){lose=false;throw Error('SYNTHETIC_LOST_MIRROR_ACK')}
  return new Response(result.body,{status:result.statusCode,headers:result.headers})
 }})
 // Only test scheduling metadata is moved ahead of other isolated fixtures;
 // worker still executes real SKIP LOCKED lease, durable retry and fenced ACK.
 await prisma.onlineOutbox.update({where:{id:e.id},data:{availableAt:new Date('1900-01-01T00:00:00Z')}})
 assert.equal((await deliverOnlineOutboxOnce(prisma,deliver)).status,'RETRY_PENDING')
 assert.equal(await f.reconcile(),0n)
 assert.equal((await prisma.onlineOutbox.findUnique({where:{id:e.id}})).deliveredAt,null)
 await prisma.onlineOutbox.update({where:{id:e.id},data:{availableAt:new Date('1900-01-01T00:00:00Z')}})
 assert.equal((await deliverOnlineOutboxOnce(prisma,deliver)).status,'DELIVERED')
 assert.ok((await prisma.onlineOutbox.findUnique({where:{id:e.id}})).deliveredAt)
 assert.equal((await receive(sign(message))).status,'ALREADY_APPLIED')
 assert.equal([...f.db.maps.orders.values()][0].financialMirror.status,'PAID');assert.equal(await f.reconcile(),0n)
})
test('HTTP E2E mixed: shipping WX-only, JSAPI intent, verified raw notify captures exactly once',async t=>{
 const f=await fixture(t,{delivery:true}),q=await f.bridge.quote(f.input,f.context)
 assert.equal(q.shippingCents,'1500');assert.equal(q.sweetCardCents,'100');assert.equal(q.wechatCents,'1500');assert.equal(q.totalCents,'1600')
 const s=await f.bridge.submit(f.submitInput(q),f.context);assert.equal(s.status,'PENDING');assert.equal(await f.reconcile(),100n)
 const payment=await f.action('prepare',s.settlementId);assert.ok(payment.paymentParameters)
 assert.equal(f.providerCalls.find(c=>c.method==='POST').body.amount.total,1500)
 assert.equal((await f.action('status',s.settlementId,{success:true,status:'PAID'})).status,'PENDING');assert.equal(await f.reconcile(),100n)
 const evidence=await f.fact(s);assert.equal((await f.notify(evidence,true)).status,401);assert.equal(await f.reconcile(),100n)
 assert.equal((await f.notify(evidence)).status,204);assert.equal((await f.notify(evidence)).status,204)
 assert.equal(await f.reconcile(),0n);assert.equal((await f.action('status',s.settlementId)).status,'PAID')
 assert.equal(await prisma.sweetCardLedger.count({where:{accountId:f.id,type:'REDEEM'}}),1)
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:s.settlementId}})).status,'CAPTURED')
})
test('HTTP E2E WX-only has zero reservations and query settlement still works with purchase flag OFF',async t=>{
 const f=await fixture(t,{desired:'0'}),q=await f.bridge.quote(f.input,f.context),s=await f.bridge.submit(f.submitInput(q),f.context)
 assert.equal(s.sweetCardCents,'0');assert.equal(s.wechatCents,'100');assert.equal(await prisma.sweetCardReservation.count({where:{settlementId:s.settlementId}}),0)
 await f.action('prepare',s.settlementId);f.paid(await f.fact(s));f.env.SWEET_CARD_ONLINE_PAYMENT_ENABLED='0'
 assert.equal((await f.action('status',s.settlementId)).status,'PAID');assert.equal(await f.reconcile(),100n)
})
test('HTTP E2E two concurrent orders cannot reserve more than native ledger balance; duplicate key idempotent',async t=>{
 const f=await fixture(t,{delivery:true}),q1=await f.bridge.quote(f.input,f.context)
 const second={...f.input,requestKey:uuid()},q2=await f.bridge.quote(second,f.context)
 const a=f.submitInput(q1),b={...f.submitInput(q2),quoteRequestKey:second.requestKey}
 const results=await Promise.allSettled([f.bridge.submit(a,f.context),f.bridge.submit(b,f.context)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409)
 const s=results.find(r=>r.status==='fulfilled').value,winner=results[0].status==='fulfilled'?a:b
 assert.equal((await f.bridge.submit(winner,f.context)).settlementId,s.settlementId)
 const reserves=await prisma.sweetCardReservation.aggregate({where:{accountId:f.id,status:'RESERVED'},_sum:{amountCents:true}})
 assert.equal(reserves._sum.amountCents,100n);assert.equal(await f.reconcile(),100n)
 assert.equal((await f.action('cancel',s.settlementId)).status,'CANCELLED');assert.equal(f.providerCalls.length,0)
 assert.equal((await prisma.sweetCardReservation.findUnique({where:{settlementId:s.settlementId}})).status,'RELEASED')
})
test('HTTP gateway denies missing HMAC, wrong session identity, header substitution and unavailable pickup',async t=>{
 const f=await fixture(t)
 const res=await fetch(f.origin+'/api/v2/customer/online-checkout/quote',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(res.status,401)
 await assert.rejects(f.action('status','nonexistent',{openId:'other-synthetic-id'}),{status:403})
 await assert.rejects(f.send({method:'POST',path:'/customer/online-checkout/status',headers:{authorization:'Bearer other'},body:{sessionHash:hash(f.input.customerSession),openId:f.context.OPENID,settlementId:'nonexistent'}}),{status:401})
 await prisma.store.update({where:{key:f.storeKey},data:{active:false}})
 await assert.rejects(f.bridge.quote(f.input,f.context),{status:409});assert.equal(await f.reconcile(),100n)
 assert.equal(await prisma.onlineSettlement.count({where:{userId:f.id}}),0)
})

test('HTTP E2E combo choices remain immutable through catalogue, quote and commerce order',async t=>{
 const f=await fixture(t,{combo:true}),q=await f.bridge.quote(f.input,f.context)
 assert.deepEqual(q.items[0].options,['核桃','杏仁']);assert.deepEqual(q.items[0].comboFlavors,['b','a'])
 f.products[1].name='后来改名'
 await f.bridge.submit(f.submitInput(q),f.context)
 const item=[...f.db.maps.orders.values()][0].items[0]
 assert.deepEqual(item.options,q.items[0].options);assert.deepEqual(item.comboFlavors,q.items[0].comboFlavors)
 const changed=copy(f.input);changed.lines[0].comboFlavors=['a','a']
 await assert.rejects(f.bridge.quote(changed,f.context),{code:'ONLINE_CHECKOUT_REQUEST_CONFLICT'})
 assert.equal(await f.reconcile(),0n)
})

test('HTTP expired quote rejects submit without financial writes, and oversized bodies are bounded',async t=>{
 const f=await fixture(t,{draftAgeMs:899000}),q=await f.bridge.quote(f.input,f.context)
 await new Promise(resolve=>setTimeout(resolve,1100))
 await assert.rejects(f.bridge.submit(f.submitInput(q),f.context),{status:409})
 assert.equal(await prisma.onlineSettlement.count({where:{userId:f.id}}),0);assert.equal(await f.reconcile(),100n)
 const res=await fetch(f.origin+'/api/v2/customer/online-checkout/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(256*1024)})})
 assert.equal(res.status,413);assert.equal((await res.json()).error,'ONLINE_REQUEST_INVALID')
})

test('HTTP merchant approval is separate-key scoped and SC refund settles exact cents',async t=>{
 const f=await fixture(t),q=await f.bridge.quote(f.input,f.context),s=await f.bridge.submit(f.submitInput(q),f.context)
 const body={settlementId:s.settlementId,actorOpenId:f.context.OPENID,requestKey:uuid(),items:q.items.map(i=>({productId:i.productId,skuId:i.skuId,quantity:i.quantity})),refundShipping:false,reason:'Synthetic approval'}
 const request=secret=>fetch(f.origin+'/api/v2/merchant/online-checkout/refund',{method:'POST',headers:{'content-type':'application/json',...productionGatewayHeaders({pathname:'/merchant/online-checkout/refund',method:'POST',body,secret})},body:JSON.stringify(body)})
 assert.equal((await request(gateway.gatewaySecret)).status,401)
 const r=await request(merchantSecret);assert.equal(r.status,200);const data=await r.json();assert.equal(data.result.status,'SETTLED');assert.equal(data.result.sweetCardCents,'100')
 assert.equal(await f.reconcile(),100n);const state=await f.action('status',s.settlementId);assert.equal(state.status,'REFUNDED');assert.equal(state.refunds[0].totalCents,'100')
})
test('HTTP capabilities returns owned available card and canonical active stores only',async t=>{
 const f=await fixture(t);const c=await f.action('capabilities')
 assert.equal(c.enabled,true);assert.equal(c.cards.length,1);assert.equal(c.cards[0].walletRef,f.id);assert.equal(c.cards[0].availableCents,'100');assert.ok(c.stores.some(s=>s.key===f.storeKey))
 f.env.SWEET_CARD_ONLINE_PAYMENT_ENABLED='0';assert.deepEqual(await f.action('capabilities'),{enabled:false,cards:[],stores:[]})
})
test('HTTP fulfillment receipt is durable and replay does not create duplicate authorization',async t=>{
 const f=await fixture(t),q=await f.bridge.quote(f.input,f.context),s=await f.bridge.submit(f.submitInput(q),f.context)
 const body={settlementId:s.settlementId,actorOpenId:f.context.OPENID,requestKey:uuid(),method:'PICKUP'}
 const request=()=>fetch(f.origin+'/api/v2/merchant/online-checkout/fulfill',{method:'POST',headers:{'content-type':'application/json',...productionGatewayHeaders({pathname:'/merchant/online-checkout/fulfill',method:'POST',body,secret:merchantSecret})},body:JSON.stringify(body)})
 const a=await request();assert.equal(a.status,200);const b=await request();assert.deepEqual(await a.json(),await b.json());assert.equal(await f.reconcile(),0n)
})
