import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineCheckout } from '../server/online-checkout.js'
for (const [label, policy, blocked, denied] of [
 ['missing',null,null,true],
 ['inactive',{productId:'p',enabled:true,product:{id:'p',isActive:false}},null,true],
 ['unspecified',{productId:'p',enabled:false,product:{id:'p',isActive:true}},null,true],
 ['eligible',{productId:'p',enabled:true,product:{id:'p',isActive:true}},null,false],
 ['blacklisted',{productId:'p',enabled:false,product:{id:'p',isActive:true,productCategoryId:'c'}},{blocked:true},false]
]) test(`runtime ${label}: explicit decision before any financial write`,async()=>{
 let writes=0
 const p={user:{findUnique:async()=>({status:'active'})},onlineCheckoutQuote:{findUnique:async()=>null,create:async({data})=>{writes++;return data}},onlineProductPolicy:{findUnique:async()=>policy},sweetCardCategoryPolicy:{findUnique:async()=>blocked},weChatAuthIdentity:{findMany:async()=>[{id:'synthetic'}]},$executeRaw:async()=>0}
 for(const key of ['onlineSettlement','sweetCardReservation','payment','sweetCardLedger'])p[key]=new Proxy({},{get:(_,key)=>key==='findUnique'?async()=>null:()=>{throw Error('FINANCIAL_WRITE_FORBIDDEN')}})
 p.$transaction=async f=>f(p)
 const service=createOnlineCheckout(p,{env:{SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST:'synthetic'},wechat:{appId:'wx0123456789abcdef',mchId:'1111111111'},resolveCatalog:async()=>({lines:[{productId:'p',skuId:'s',quantity:1,name:'synthetic',unitPriceCents:'6900',discountCents:'0'}],shippingCents:'1500'})})
 const action=()=>service.quote('synthetic',{requestKey:'guard-'+label,lines:[{productId:'p',skuId:'s',quantity:1}],fulfillment:'PICKUP'})
 if(denied){await assert.rejects(action,e=>e.code==='CATALOG_MAPPING_REQUIRED'&&e.status===409);assert.equal(writes,0)}else{const q=await action();assert.equal(q.snapshot.wechatCents,'8400');assert.equal(q.snapshot.lines[0].onlineEligible,!blocked);assert.equal(writes,1)}
})

test('HTTP quote exposes CATALOG_MAPPING_REQUIRED after verified gateway and session',async()=>{
 const {default:express}=await import('express'),{default:crypto}=await import('node:crypto')
 const {createOnlineCheckoutRouter}=await import('../server/online-checkout-api.js')
 const {createCustomerSession}=await import('../server/customer-auth.js')
 const {signProductionGatewayRequest,gatewayBodyHash}=await import('../server/production-cloudbase-gateway.js')
 const cfg={enabled:true,mode:'production',appId:'wx0123456789abcdef',cloudBaseEnvId:'synthetic',markerKey:'synthetic-session-key',gatewaySecret:'synthetic-gateway-key'}
 let session
 const db={customerSession:{create:async({data})=>{session={...data,user:{role:'customer',status:'active'}}},findUnique:async()=>session},user:{findUnique:async()=>({status:'active'})},weChatAuthIdentity:{findUnique:async()=>({userId:'synthetic'})},onlineCheckoutQuote:{findUnique:async()=>null},onlineSettlement:{findUnique:async()=>null},onlineProductPolicy:{findUnique:async()=>null},$executeRaw:async()=>0};db.$transaction=async f=>f(db)
 const s=await createCustomerSession({userId:'synthetic',markerKey:cfg.markerKey,db})
 const token=s.rawToken,body={sessionHash:crypto.createHash('sha256').update(token).digest('hex'),openId:'synthetic',catalog:{commerceRef:'ocd-'+'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),lines:[{productId:'p',skuId:'s',quantity:1,unitPriceCents:'6900'}],shippingCents:'1500'},intent:{requestKey:'http-guard',lines:[{productId:'p',skuId:'s',quantity:1}],fulfillment:'DELIVERY',addressRef:'ocd-'+'a'.repeat(64)}}
 const app=express();app.use(express.json());app.use('/checkout',createOnlineCheckoutRouter({db,gatewayConfig:cfg,env:{SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST:'synthetic'}}))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
 try{const timestamp=String(Date.now()),nonce=crypto.randomBytes(24).toString('base64url'),signature=signProductionGatewayRequest({timestamp,nonce,method:'POST',requestPath:'/checkout/quote',bodyHash:gatewayBodyHash(body),environment:cfg.cloudBaseEnvId,appId:cfg.appId},cfg.gatewaySecret)
 const r=await fetch(`http://127.0.0.1:${server.address().port}/checkout/quote`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,'x-budu-gateway-timestamp':timestamp,'x-budu-gateway-nonce':nonce,'x-budu-gateway-environment':cfg.cloudBaseEnvId,'x-budu-gateway-appid':cfg.appId,'x-budu-gateway-signature':signature},body:JSON.stringify(body)});assert.equal(r.status,409);assert.deepEqual(await r.json(),{ok:false,error:'CATALOG_MAPPING_REQUIRED'})
 }finally{await new Promise(r=>server.close(r))}
})
