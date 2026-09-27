import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createOnlineMirrorSigner } from '../server/online-mirror-signature.js'
import { createOnlineMirrorTransport } from '../server/online-mirror-transport.js'
// Explicit companion checkout required, never imports another repo at runtime.
if (!process.env.SC11B_MP_REPO) throw Error('SC11B_MP_REPO_REQUIRED')
const require = createRequire(import.meta.url)
const { createMirrorServerVerifier } = require(path.join(process.env.SC11B_MP_REPO,'cloudfunctions/onlineFinancialMirror/auth.js'))
const { createFinancialMirrorReceiver, linkId } = require(path.join(process.env.SC11B_MP_REPO,'cloudfunctions/onlineFinancialMirror/receiver.js'))
const { createMirrorHttpHandler } = require(path.join(process.env.SC11B_MP_REPO,'cloudfunctions/onlineFinancialMirror/http.js'))
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048})
const config={environment:'synthetic-env',appId:'wx0123456789abcdef',keyId:'synthetic-mirror'}
const sign=createOnlineMirrorSigner({...config,privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})})
const verify=createMirrorServerVerifier({...config,publicKey:keys.publicKey.export({type:'spki',format:'pem'})})
test('OS signed event reaches actual CloudBase auth and durable mirror receiver',async()=>{
 const p={schemaVersion:1,settlementId:'os-test',externalOrderId:'os-test',namespace:'cloudbase-miniprogram',version:1,status:'PAID',currency:'CNY',merchandiseCents:'100',shippingCents:'0',totalCents:'100',sweetCardCents:'100',wechatCents:'0',paidAt:new Date().toISOString(),cancelledAt:null,tenders:[{type:'SWEET_CARD',amountCents:'100',status:'SUCCEEDED'}],refunds:[],compensations:[]}
 const binding={authority:'POSTGRESQL',settlementId:p.settlementId,externalOrderId:p.externalOrderId,namespace:p.namespace,totalCents:'100',currency:'CNY'}
 const docs={['onlineOrderLinks/'+linkId(p.namespace,p.externalOrderId)]:{...binding,orderId:'order-1'},'orders/order-1':{onlineFinancialBinding:binding,status:'PENDING_PAYMENT'}}
 let writes=0
 const db={runTransaction:async fn=>fn({collection:name=>({doc:id=>({get:async()=>({data:docs[name+'/'+id]}),update:async({data})=>{writes++;Object.assign(docs[name+'/'+id],data)}})})})}
 const receive=createFinancialMirrorReceiver({db,authorizeServerRequest:verify}),event={eventKey:'online:os-test:1',version:1,payload:p}
 assert.equal((await receive(sign(event))).status,'APPLIED')
 assert.equal((await receive(sign(event))).status,'ALREADY_APPLIED');assert.equal(writes,1)
 const tampered=sign(event);tampered.rawBody=Buffer.from('{}');await assert.rejects(receive(tampered),{code:'MIRROR_SIGNATURE_DENIED'});assert.equal(writes,1)
 assert.equal(docs['orders/order-1'].financialMirror.status,'PAID')
})
test('signer bounds messages, rejects wrong config and rotates request nonce',()=>{
 assert.throws(()=>sign({data:'x'.repeat(256*1024)}),/TOO_LARGE/)
 assert.throws(()=>createOnlineMirrorSigner({...config,privateKey:'invalid'}),/KEY_INVALID/)
 const a=sign({version:1}),b=sign({version:1});assert.notEqual(a.authorization.nonce,b.authorization.nonce)
})

test('HTTP adapter contract survives lost ACK and delayed older events without overwriting commerce',async()=>{
 const payload={schemaVersion:1,settlementId:'os-http',externalOrderId:'os-http',namespace:'cloudbase-miniprogram',version:1,status:'PAID',currency:'CNY',merchandiseCents:'100',shippingCents:'0',totalCents:'100',sweetCardCents:'100',wechatCents:'0',paidAt:new Date().toISOString(),cancelledAt:null,tenders:[{type:'SWEET_CARD',amountCents:'100',status:'SUCCEEDED'}],refunds:[],compensations:[]}
 const binding={authority:'POSTGRESQL',settlementId:payload.settlementId,externalOrderId:payload.externalOrderId,namespace:payload.namespace,totalCents:'100',currency:'CNY'}
 const order={onlineFinancialBinding:binding,status:'PENDING_PAYMENT',trackingNo:'synthetic-tracking'}
 const docs={['onlineOrderLinks/'+linkId(payload.namespace,payload.externalOrderId)]:{...binding,orderId:'http-order'},'orders/http-order':order}
 let writes=0,loseAck=true,base64=false,tamper=false
 const db={runTransaction:async fn=>fn({collection:name=>({doc:id=>({get:async()=>({data:docs[name+'/'+id]}),update:async({data})=>{writes++;Object.assign(docs[name+'/'+id],data)}})})})}
 const handle=createMirrorHttpHandler({db,authentication:{...config,publicKey:keys.publicKey.export({type:'spki',format:'pem'})}})
 const deliver=createOnlineMirrorTransport({...config,privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),endpoint:'https://mirror.test.internal/online-financial-mirror'},{fetchImpl:async(url,options)=>{
   assert.equal(options.redirect,'manual')
   const bytes=tamper?Buffer.from('{}'):options.body
   const response=await handle({httpMethod:options.method,headers:options.headers,body:bytes.toString(base64?'base64':'utf8'),isBase64Encoded:base64})
   if(loseAck){loseAck=false;throw Error('synthetic lost acknowledgement')}
   return new Response(response.body,{status:response.statusCode,headers:response.headers})
 }})
 const event=version=>({eventKey:`online:os-http:${version}`,version,payload:{...payload,version}})
 await assert.rejects(deliver(event(1)),/ONLINE_MIRROR_DELIVERY_FAILED/)
 assert.equal(writes,1);assert.equal(order.financialMirror.version,1)
 base64=true
 assert.equal((await deliver(event(1))).status,'ALREADY_APPLIED');assert.equal(writes,1)
 assert.equal((await deliver(event(2))).status,'APPLIED');assert.equal(writes,2)
 assert.equal((await deliver(event(1))).status,'SUPERSEDED');assert.equal(writes,2)
 tamper=true
 await assert.rejects(deliver(event(3)),/ONLINE_MIRROR_DELIVERY_FAILED/)
 assert.equal(writes,2);assert.equal(order.financialMirror.version,2)
 assert.equal(order.status,'PENDING_PAYMENT');assert.equal(order.trackingNo,'synthetic-tracking')
})
