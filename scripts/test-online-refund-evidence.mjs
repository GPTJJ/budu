import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createOnlineRefundEvidence, createOnlineRefundReferenceReader } from '../server/online-refund-evidence.js'
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048})
const config={appId:'wx0123456789abcdef',mchId:'1234567890',apiV3Key:'s'.repeat(32),platformPublicKey:publicKey.export({type:'spki',format:'pem'}),platformKeyId:'PUB_KEY_ID_TEST'}
const verify=createOnlineRefundEvidence(config)
const expected={appId:config.appId,mchId:config.mchId,currency:'CNY',merchantTradeNo:'B'+'a'.repeat(31),transactionId:'transaction-original',merchantRefundNo:'refund-original',totalCents:100n,refundCents:30n}
const result=()=>({out_trade_no:expected.merchantTradeNo,transaction_id:expected.transactionId,out_refund_no:expected.merchantRefundNo,refund_id:'provider-refund',status:'SUCCESS',success_time:new Date(Date.now()-1000).toISOString(),amount:{total:100,refund:30,currency:'CNY'}})
function sign(body,source='QUERY',timestamp=Math.floor(Date.now()/1000)){
 const rawBody=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),nonce='synthetic-nonce'
 return {source,statusCode:200,rawBody,headers:{'wechatpay-timestamp':String(timestamp),'wechatpay-nonce':nonce,'wechatpay-serial':config.platformKeyId,'wechatpay-signature':crypto.sign('RSA-SHA256',Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`),rawBody,Buffer.from('\n')]),privateKey).toString('base64')}}
}
function notify(data,eventType='REFUND.SUCCESS',change=()=>{}){
 const r={...data,mchid:config.mchId,refund_status:data.status};delete r.status;delete r.amount.currency
 const nonce='123456789012',aad='refund',cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(config.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad))
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(r)),cipher.final(),cipher.getAuthTag()]).toString('base64')
 const envelope={event_type:eventType,resource_type:'encrypt-resource',resource:{original_type:'refund',algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext}};change(envelope)
 return sign(envelope,'NOTIFY')
}
test('query verifies original transaction, exact immutable allocation and omits sensitive provider payload',()=>{
 const r=result();r.user_received_account='sensitive account';const v=verify(sign(r),expected)
 assert.equal(v.state,'SUCCESS');assert.equal(v.amountCents,30n);assert.equal(v.totalCents,100n);assert.ok(v.successAt instanceof Date)
 assert.equal(v.user_received_account,undefined);assert.ok(Object.isFrozen(v));assert.equal(v.appId,config.appId)
})
test('notification verifies signature+AEAD+merchant, allows protocol missing appid/currency bound to original payment',()=>{
 const v=verify(notify(result()),expected);assert.equal(v.state,'SUCCESS');assert.equal(v.currency,'CNY');assert.equal(v.mchId,config.mchId)
 for(const change of [x=>x.resource.original_type='transaction',x=>x.resource.algorithm='wrong',x=>x.resource.nonce='wrong',x=>x.resource.associated_data='tampered',x=>x.resource.ciphertext='AAAA',x=>x.event_type='TRANSACTION.SUCCESS'])assert.throws(()=>verify(notify(result(),'REFUND.SUCCESS',change),expected),{status:401})
})
test('signed processing/abnormal/closed results never present success time or completion',()=>{
 for(const state of ['PROCESSING','ABNORMAL','CLOSED']){
  const r=result();r.status=state;delete r.success_time
  for(const source of ['QUERY','SUBMIT']){const v=verify(sign(r,source),expected);assert.equal(v.state,state);assert.equal(v.successAt,null)}
  if(state!=='PROCESSING'){const v=verify(notify(r,`REFUND.${state}`),expected);assert.equal(v.successAt,null)}
 }
 assert.throws(()=>verify(notify({...result(),status:'PROCESSING'},'REFUND.SUCCESS'),expected),{status:401})
})
test('rejects every original identity/currency/amount mismatch even with genuine signature',()=>{
 const mutations=[x=>x.out_trade_no='other',x=>x.transaction_id='other',x=>x.out_refund_no='other',x=>x.refund_id='',x=>x.mchid='9999999999',x=>x.appid='wxffffffffffffffff',x=>x.amount.total=101,x=>x.amount.refund=31,x=>x.amount.refund='30',x=>x.amount.refund=0.1,x=>x.amount.currency='USD',x=>delete x.amount.currency,x=>x.status='UNKNOWN',x=>delete x.success_time,x=>x.success_time='tomorrow',x=>x.success_time=new Date(Date.now()+600000).toISOString()]
 for(const mutate of mutations){const r=result();mutate(r);assert.throws(()=>verify(sign(r),expected),{status:401})}
 assert.throws(()=>verify(sign(result()),{...expected,providerRefundId:'different'}),{status:401})
})
test('requires canonical merchant/app/CNY expected tuple and positive bounded integer cents',()=>{
 for(const e of [null,{...expected,appId:'wxffffffffffffffff'},{...expected,mchId:'9999999999'},{...expected,currency:'USD'},{...expected,totalCents:100},{...expected,refundCents:101n},{...expected,refundCents:0n},{...expected,transactionId:''}])assert.throws(()=>verify(sign(result()),e),{status:401})
 assert.equal(verify(sign(result()),{...expected,totalCents:'100',refundCents:'30'}).amountCents,30n)
})
test('raw signature expiry, byte tamper, duplicate header, wrong key and HTTP status fail before parsed claims',()=>{
 const bad=[sign(result(),'QUERY',Math.floor(Date.now()/1000)-301),sign(result())]
 bad[1].rawBody=Buffer.concat([bad[1].rawBody,Buffer.from(' ')])
 const duplicate=sign(result());duplicate.headers['Wechatpay-Nonce']='different';bad.push(duplicate)
 const key=sign(result());key.headers['wechatpay-serial']='OTHER';bad.push(key)
 const status=sign(result());status.statusCode=500;bad.push(status)
 const forged=sign(result());forged.headers['wechatpay-signature']='WECHATPAY/SIGNTEST/test';bad.push(forged)
 bad.push(sign(Buffer.from('{invalid')))
 for(const input of bad)assert.throws(()=>verify(input,expected),{status:401})
})
test('notification resource status must agree with envelope and actual decrypted merchant',()=>{
 assert.throws(()=>verify(notify(result(),'REFUND.CLOSED'),expected),{status:401})
 // Craft another merchant under the correct AEAD key; signature alone is insufficient.
 const original=result(),nonce='123456789012',cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(config.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from('refund'))
 const data={...original,mchid:'9999999999',refund_status:'SUCCESS'}
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64')
 const envelope={event_type:'REFUND.SUCCESS',resource_type:'encrypt-resource',resource:{original_type:'refund',algorithm:'AEAD_AES_256_GCM',nonce,associated_data:'refund',ciphertext}}
 assert.throws(()=>verify(sign(envelope,'NOTIFY'),expected),{status:401})
})

test('reference reader returns only authenticated lookup identity and denies tamper/invalid reference',()=>{
 const read=createOnlineRefundReferenceReader(config)
 assert.equal(read(sign(result())),expected.merchantRefundNo)
 assert.equal(read(notify(result())),expected.merchantRefundNo)
 const tampered=notify(result());tampered.rawBody=Buffer.concat([tampered.rawBody,Buffer.from(' ')])
 assert.throws(()=>read(tampered),{status:401})
 assert.throws(()=>read(notify(result(),'REFUND.SUCCESS',x=>x.resource.associated_data='tampered')),{status:401})
 for(const ref of ['', 'x'.repeat(65), 'bad reference', '../../other'])assert.throws(()=>read(sign({...result(),out_refund_no:ref})),{status:401})
 // Reader is intentionally not amount authority: full verification remains mandatory.
 const wrong=result();wrong.amount.refund=99
 assert.equal(read(sign(wrong)),expected.merchantRefundNo)
 assert.throws(()=>verify(sign(wrong),expected),{status:401})
})
