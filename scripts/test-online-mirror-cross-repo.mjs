import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createOnlineMirrorSigner } from '../server/online-mirror-signature.js'
// Explicit companion checkout required, never imports another repo at runtime.
if (!process.env.SC11B_MP_REPO) throw Error('SC11B_MP_REPO_REQUIRED')
const require = createRequire(import.meta.url)
const { createMirrorServerVerifier } = require(path.join(process.env.SC11B_MP_REPO,'cloudfunctions/onlineFinancialMirror/auth.js'))
const { createFinancialMirrorReceiver, linkId } = require(path.join(process.env.SC11B_MP_REPO,'cloudfunctions/onlineFinancialMirror/receiver.js'))
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
