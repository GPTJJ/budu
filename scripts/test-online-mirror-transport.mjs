import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createOnlineMirrorTransport } from '../server/online-mirror-transport.js'
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048})
const config={environment:'synthetic',appId:'wx0123456789abcdef',keyId:'key1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),endpoint:'https://mirror.budu.test/online-financial-mirror'}
const event={eventKey:'online:os-1:1',version:1,payload:{}}
const ack={eventKey:event.eventKey,version:1,status:'APPLIED'}
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}})
test('posts signed original bytes and returns exact acknowledgement only',async()=>{
 const deliver=createOnlineMirrorTransport(config,{fetchImpl:async(url,options)=>{
  assert.equal(url,config.endpoint);assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),event)
  const h=options.headers,p=['scope','principal','capability','environment','appid','keyid','timestamp','nonce'].map(k=>h['x-budu-mirror-'+k]);p.push(crypto.createHash('sha256').update(options.body).digest('hex'))
  assert.equal(crypto.verify('RSA-SHA256',Buffer.from(p.join('\n')),keys.publicKey,Buffer.from(h['x-budu-mirror-signature'],'base64')),true)
  return json({...ack,unsolicited:'ignored'})
 }})
 assert.deepEqual(await deliver(event),ack)
})
test('HTTP success without correct identity/status is never acknowledged',async()=>{
 for(const bad of [{ok:true},{...ack,version:2},{...ack,eventKey:'other'},{...ack,status:'OK'}])await assert.rejects(createOnlineMirrorTransport(config,{fetchImpl:async()=>json(bad)})(event))
})
test('redirect, non-JSON and server error are not followed or leaked',async()=>{
 for(const reply of [new Response('',{status:302,headers:{location:'https://untrusted.test'}}),new Response('secret',{status:503}),new Response('html')]){
  let calls=0;await assert.rejects(createOnlineMirrorTransport(config,{fetchImpl:async()=>{calls++;return reply}})(event),{message:'ONLINE_MIRROR_DELIVERY_FAILED'});assert.equal(calls,1)
 }
})
test('response bounds include streamed bytes and declared content length',async()=>{
 for(const reply of [new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'16385'}})])await assert.rejects(createOnlineMirrorTransport(config,{fetchImpl:async()=>reply})(event))
})
test('deadline and caller cancellation abort the underlying request',async()=>{
 const pending=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('sensitive')),{once:true}))
 await assert.rejects(createOnlineMirrorTransport(config,{fetchImpl:pending,deadlineMs:10})(event),{message:'ONLINE_MIRROR_DELIVERY_FAILED'})
 const controller=new AbortController(),result=createOnlineMirrorTransport(config,{fetchImpl:pending})(event,{signal:controller.signal});controller.abort();await assert.rejects(result)
})
test('invalid endpoint and already aborted request cannot dispatch',async()=>{
 for(const endpoint of ['http://mirror.budu.test/online-financial-mirror','https://user:secret@mirror.budu.test/online-financial-mirror','https://mirror.budu.test/other','https://mirror.budu.test/online-financial-mirror?token=x'])assert.throws(()=>createOnlineMirrorTransport({...config,endpoint}))
 await assert.rejects(createOnlineMirrorTransport(config,{fetchImpl:()=>assert.fail()})(event,{signal:AbortSignal.abort()}))
})
