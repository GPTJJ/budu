import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createP1Harness,deferred,until,syntheticPdf} from './helpers/p1-fix-harness.mjs'
const source=process.env.P1_TEST_SOURCE||path.resolve(import.meta.dirname,'..')
let orderBarrier, approvalBarrier, creationBarrier, unresolvedBarrier, forceCancelMiss=false
const h=await createP1Harness({source,queryHook:async({model,operation,args,query})=>{
  const result=await query(args)
  if(forceCancelMiss && model==='Order' && operation==='updateMany' && args.data.status==='cancelled'){forceCancelMiss=false;return {count:0}}
  if(model==='ApprovalRequest'&&operation==='create'&&creationBarrier?.prefix&&args.data.requestNo.startsWith(creationBarrier.prefix)){const gate=creationBarrier;creationBarrier=undefined;gate.entered.resolve();await gate.release.promise}
  if(model==='Payment'&&operation==='findFirst'&&args.where.OR&&unresolvedBarrier?.id===args.where.orderId){const gate=unresolvedBarrier;unresolvedBarrier=undefined;gate.entered.resolve();await gate.release.promise}
  if(model==='Order'&&operation==='findUnique'&&orderBarrier?.id===args.where.id){const gate=orderBarrier;orderBarrier=undefined;gate.entered.resolve();await gate.release.promise}
  if(model==='ApprovalRequest'&&operation==='findUnique'&&approvalBarrier?.id===args.where.id){const gate=approvalBarrier;approvalBarrier=undefined;gate.entered.resolve();await gate.release.promise}
  return result
}})
const {PaymentService}=await import(pathToFileURL(path.join(source,'server/payments/payment-service.js')))
const {CashPaymentProvider}=await import(pathToFileURL(path.join(source,'server/payments/providers/cash.js')))
const {settlementCoordinator}=await import(pathToFileURL(path.join(source,'server/settlements/settlement-coordinator.js')))
const {buildRecognizedRevenueWhere}=await import(pathToFileURL(path.join(source,'server/pos-core.js')))
const cash=new CashPaymentProvider();const providers=new Map([['cash',cash]])
const service=new PaymentService(h.second,providers)
const nativeOnly=process.env.P1_TEST_BASELINE!=='1'
const cancel=id=>h.api(`/v2/pos/orders/${id}/cancel`,{method:'POST',body:{reason:'Synthetic cancellation'}})
const pay=(instance,id,key='p1-payment-'+id)=>instance.createPayment({orderId:id,channel:'cash',requestKey:key})
const approve=(id,version,action='approve')=>h.api(`/v2/approvals/requests/${id}/decide`,{actor:'approver',method:'POST',body:{action,comment:action==='reject'?'Synthetic reject':'',contentVersion:version}})
const detail=id=>h.api('/v2/approvals/requests/'+id,{actor:'approver'})
async function facts(id){const order=await h.db.order.findUnique({where:{id},include:{payments:true,items:true}});const recognized=await h.db.order.aggregate({where:{AND:[{id},buildRecognizedRevenueWhere({storeId:'tongying'})]},_sum:{payableAmount:true}});return{order,revenue:recognized._sum.payableAmount||0n}}
function gate(id){const entered=deferred(),release=deferred();orderBarrier={id,entered,release};return{entered:entered.promise,release:release.resolve}}
async function partialCard(order,amount=5000n){
 const id=order.id+'-card'
 await h.second.$transaction(async tx=>{
  await settlementCoordinator.lockOrder(tx,order.id)
  await tx.sweetCardAccount.create({data:{id,publicCardNo:id,initialAmountCents:10000n,balanceCents:10000n-amount,validityType:'LONG_TERM',carrierType:'PHYSICAL',bindingMode:'NONE',status:'ACTIVE'}})
  await tx.sweetCardCredential.create({data:{id:id+'-cred',accountId:id,publicTokenId:id,tokenHash:id,tokenCiphertext:'synthetic-only',tokenIv:'synthetic-only',tokenTag:'synthetic-only',status:'ACTIVE',carrierType:'PHYSICAL'}})
  await tx.sweetCardLedger.create({data:{id:id+'-issue',accountId:id,type:'ISSUE',amountCents:10000n,balanceAfterCents:10000n,requestKey:id+'-issue'}})
  await tx.sweetCardRedemption.create({data:{id:id+'-redemption',redemptionNo:id,orderId:order.id,accountId:id,credentialId:id+'-cred',amountCents:amount,eligibleSubtotalCents:10000n,ineligibleSubtotalCents:0n,requestKey:id+'-redeem',storeIdSnapshot:'tongying',redeemedById:h.users.viewer.id,items:{create:{id:id+'-allocation',orderItemId:order.id+'-item',productId:'p1-product',eligibleSnapshot:true,eligibleAmountCents:10000n,redeemedAmountCents:amount}}}})
  await tx.sweetCardLedger.create({data:{id:id+'-redeem-ledger',accountId:id,type:'REDEEM',amountCents:-amount,balanceAfterCents:10000n-amount,orderId:order.id,redemptionId:id+'-redemption',requestKey:id+'-redeem-ledger'}})
  await tx.orderItem.update({where:{id:order.id+'-item'},data:{sweetCardEligibleSnapshot:true,sweetCardRedeemedAmount:amount}})
  await tx.order.update({where:{id:order.id},data:{sweetCardAmount:amount}})
 })
 return id
}
async function staleRound({changeAmount=true,attachment=false}={}){
 const created=await h.createApproval();assert.equal(created.status,200);const id=created.body.request.id
 const old=await detail(id);assert.equal(old.status,200)
 const rejection=await approve(id,old.body.request.contentVersion,'reject');assert.equal(rejection.status,200)
 let attachmentIds=[]
 if(attachment){const uploaded=await h.api('/v2/approvals/attachments',{actor:'uploader',method:'POST',body:{name:'synthetic.pdf',fileType:'application/pdf',dataUrl:'data:application/pdf;base64,'+syntheticPdf().toString('base64')}});assert.equal(uploaded.status,200);attachmentIds=[uploaded.body.attachment.id]}
 const edited=await h.api('/v2/approvals/requests/'+id,{actor:'uploader',method:'PUT',body:{title:'New synthetic approval',formData:{amount:changeAmount?'9000':'100'},attachmentIds}});assert.equal(edited.status,200)
 const resubmitted=await h.api('/v2/approvals/requests/'+id+'/submit',{actor:'uploader',method:'POST',body:{}});assert.equal(resubmitted.status,200)
 return{id,old:old.body.request}
}
try{
 await test('WFL-02 regression: 0001/0002/0003, legal delete0002, continuous creation succeeds',async()=>{
  try{
  const date=new Date(),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('')
  const ids=[];for(let n=1;n<=3;n++){const id='p1-existing-'+n;ids.push(id);await h.db.approvalRequest.create({data:{id,requestNo:`AP-${day}-${String(n).padStart(4,'0')}`,templateKey:'p1-expense',title:'Synthetic pre-migration request',status:'draft',formData:{amount:10000},amountCents:10000n,submitterUsername:h.users.uploader.username}})}
  const original=await h.db.approvalRequest.findMany({where:{id:{in:[ids[0],ids[2]]}},orderBy:{id:'asc'}})
  const removed=await h.api('/v2/approvals/requests/'+ids[1],{actor:'uploader',method:'DELETE'});assert.equal(removed.status,200)
  for(const n of [4,5]){const created=await h.createApproval({submit:false});assert.equal(created.status,200);assert.equal(created.body.request.requestNo,`AP-${day}-${String(n).padStart(4,'0')}`)}
  assert.deepEqual(await h.db.approvalRequest.findMany({where:{id:{in:[ids[0],ids[2]]}},orderBy:{id:'asc'}}),original)
  }finally{await h.db.approvalRequest.deleteMany()}
 })
 await test('WFL-01 regression: all reject/edit9000/resubmit actions finish before stale approve/reject',async()=>{
  const {id,old}=await staleRound();const before=await h.db.approvalRequest.findUnique({where:{id}})
  const counts=await Promise.all([h.db.approvalLog.count({where:{requestId:id}}),h.db.approvalNode.count({where:{requestId:id,status:{not:'pending'}}}),h.db.approvalNotification.count({where:{requestId:id,type:'result'}})])
  const a=await approve(id,old.contentVersion);assert.equal(a.status,409)
  const b=await approve(id,old.contentVersion,'reject');assert.equal(b.status,409)
  assert.deepEqual(await h.db.approvalRequest.findUnique({where:{id}}),before)
  assert.deepEqual(await Promise.all([h.db.approvalLog.count({where:{requestId:id}}),h.db.approvalNode.count({where:{requestId:id,status:{not:'pending'}}}),h.db.approvalNotification.count({where:{requestId:id,type:'result'}})]),counts)
  assert.equal(before.amountCents,900000n);assert.equal(before.status,'pending')
 })
 await test('PAY-01 regression: cancel pauses after unresolved check; payment contends at the real atomic boundary',async()=>{
  const order=await h.order(),entered=deferred(),release=deferred();unresolvedBarrier={id:order.id,entered,release}
  const cancelling=cancel(order.id);await entered.promise
  let paid=false,payError;const paying=pay(service,order.id).then(x=>{paid=true;return x},e=>{payError=e;return null})
  let blocked=false
  try{
   await until(async()=>{if(paid||payError)return true;const [row]=await h.observer.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");blocked=row.n>0;return blocked},'payment completes or is blocked by the cancelling transaction')
  }finally{release.resolve()}
  const cancelled=await cancelling;await paying;const f=await facts(order.id)
  console.log('PAY_BOUNDARY_FACTS='+JSON.stringify({status:f.order.status,paymentStatus:f.order.paymentStatus,payments:f.order.payments.map(p=>({status:p.status,amountCents:String(p.amount)})),recognizedRevenueCents:String(f.revenue),paymentBlocked:blocked,cancelHttp:cancelled.status,payConflict:payError?.status||null}))
  assert.equal(f.order.status==='cancelled'&&f.order.paymentStatus==='paid',false,'must not commit cancelled/paid')
  assert.equal(blocked,true,'payment must wait behind cancel order lock');assert.equal(cancelled.status,200);assert.equal(payError?.status,409);assert.equal(f.order.payments.length,0);assert.equal(f.revenue,0n)
 })
 await test('AUTH-02 regression: actual authenticated upload rejects declared PDF with HTML bytes',async()=>{
  const html='<script>parent.__p1Executed=true;fetch("/api/admin/users")</script>'
  const response=await h.api('/v2/asset-center/files',{actor:'uploader',method:'POST',body:{name:'Synthetic counterfeit',category:'p1-category',fileName:'synthetic.pdf',fileType:'application/pdf',dataUrl:'data:text/html;base64,'+Buffer.from(html).toString('base64')}})
  assert.equal(response.status,400)
  assert.equal(await h.db.assetFile.count({where:{name:'Synthetic counterfeit'}}),0)
 })
 if(nativeOnly){
 await test('PAY native: cancellation initial read becomes stale while payment completes; protected reread refuses cancel',async()=>{
  const o=await h.order(),barrier=gate(o.id),cancelling=cancel(o.id);await barrier.entered
  try{await pay(service,o.id)}finally{barrier.release()}
  assert.equal((await cancelling).status,409);const f=await facts(o.id);assert.equal(f.order.status,'completed');assert.equal(f.revenue,10000n)
 })
 await test('PAY native: cancellation wins, attempted payment creates no Payment or revenue',async()=>{
  const o=await h.order();assert.equal((await cancel(o.id)).status,200)
  await assert.rejects(pay(service,o.id),e=>e.status===409)
  const f=await facts(o.id);assert.equal(f.order.status,'cancelled');assert.equal(f.order.payments.length,0);assert.equal(f.revenue,0n)
  await assert.rejects(service.createRefund({orderId:o.id,requestKey:'refund-'+o.id}),e=>e.status===409)
 })
 await test('PAY native: attempted payment commits first; blocked cancel refuses unresolved, provider runs outside lock',async()=>{
  const o=await h.order(),inserted=deferred(),releaseInsert=deferred(),providerEntered=deferred(),releaseProvider=deferred()
  const dbB=h.second.$extends({query:{payment:{create:async({args,query})=>{const p=await query(args);inserted.resolve();await releaseInsert.promise;return p}}}})
  const controlled={capability:(...args)=>cash.capability(...args),createPayment:async(...args)=>{providerEntered.resolve();await releaseProvider.promise;return cash.createPayment(...args)}}
  const b=new PaymentService(dbB,new Map([['cash',controlled]]));const paying=pay(b,o.id)
  await inserted.promise;const cancelling=cancel(o.id)
  try{
   await until(async()=>{const [row]=await h.observer.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");return row.n>0},'cancel waiting on real order advisory lock')
  }finally{releaseInsert.resolve()}
  await providerEntered.promise
  try{assert.equal((await cancelling).status,409)}finally{releaseProvider.resolve()}
  const paid=await paying;assert.equal(paid.order.status,'completed');assert.equal((await facts(o.id)).revenue,10000n)
 })
 await test('PAY native: paid first stays paid; ordinary refund eligibility and amount proof remain',async()=>{
  const o=await h.order();await pay(service,o.id);assert.equal((await cancel(o.id)).status,409)
  const before=await facts(o.id);assert.equal(before.order.payments[0].amount,10000n);assert.equal(before.order.payableAmount,10000n)
  const refunded=await service.createRefund({orderId:o.id,requestKey:'refund-'+o.id,reason:'Synthetic test',items:[{orderItemId:o.id+'-item',quantity:1}],operator:'Synthetic'})
  assert.equal(refunded.refund.status,'completed');const after=await facts(o.id);assert.equal(after.order.paymentStatus,'refunded');assert.equal(after.revenue,0n)
 })
 await test('PAY native: repeated concurrent cancel remains one transition',async()=>{
  const o=await h.order(),results=await Promise.all([cancel(o.id),cancel(o.id)]);assert.deepEqual(results.map(x=>x.status),[200,200]);const f=await facts(o.id);assert.equal(f.order.version,o.version+1);assert.equal(f.revenue,0n)
 })
 await test('PAY native: two independent connections replay one request, one provider call and one success',async()=>{
  const o=await h.order();let calls=0
  const provider={capability:(...args)=>cash.capability(...args),createPayment:async(...args)=>{calls++;return cash.createPayment(...args)}}
  const a=new PaymentService(h.db,new Map([['cash',provider]])),b=new PaymentService(h.second,new Map([['cash',provider]]))
  const results=await Promise.all([pay(a,o.id),pay(b,o.id)]);assert.equal(results[0].payment.id,results[1].payment.id);assert.equal(calls,1);const f=await facts(o.id);assert.equal(f.order.payments.length,1);assert.equal(f.revenue,10000n)
 })
 await test('PAY native: repeated final confirmation does not duplicate settlement or accounting proof',async()=>{
  const o=await h.order(),provider={capability:()=>false,createPayment:async()=>({callbacks:[]})}
  const a=new PaymentService(h.db,new Map([['cash',provider]])),b=new PaymentService(h.second,new Map([['cash',provider]]))
  const created=await pay(a,o.id);const event={paymentNo:created.payment.paymentNo,merchantTradeNo:created.payment.merchantTradeNo,status:'success',amount:10000n,currency:'CNY',eventId:'synthetic-same-event'}
  await Promise.all([a.applyPaymentEvent('cash',event),b.applyPaymentEvent('cash',event)])
  const before=await facts(o.id);await b.applyPaymentEvent('cash',{...event,eventId:'synthetic-repeated-result'})
  const after=await facts(o.id);assert.equal(after.order.version,before.order.version);assert.equal(after.order.payments.length,1);assert.equal(after.revenue,10000n);assert.equal(await h.db.sweetCardLedger.count({where:{orderId:o.id}}),0)
 })
 await test('PAY native: card reversal and cancel CAS failure rollback together; repeated cancel reverses once',async()=>{
  const o=await h.order(),account=await partialCard(o);const before=await facts(o.id)
  forceCancelMiss=true
  assert.equal((await cancel(o.id)).status,409)
  const after=await facts(o.id);assert.deepEqual(after.order,before.order);assert.equal((await h.db.sweetCardAccount.findUnique({where:{id:account}})).balanceCents,5000n);assert.equal(await h.db.sweetCardLedger.count({where:{orderId:o.id,type:'REVERSAL'}}),0)
  assert.equal((await cancel(o.id)).status,200);assert.equal((await cancel(o.id)).status,200)
  assert.equal((await h.db.sweetCardAccount.findUnique({where:{id:account}})).balanceCents,10000n);assert.equal(await h.db.sweetCardLedger.count({where:{orderId:o.id,type:'REVERSAL'}}),1);assert.equal((await facts(o.id)).order.sweetCardAmount,0n)
 })
 await test('PAY native: card reservation completes between outer read and create; locked reread prices remaining payment',async()=>{
  const o=await h.order(),entered=deferred(),release=deferred();let once=true
  const client=h.second.$extends({query:{order:{findUnique:async({args,query})=>{const row=await query(args);if(once&&args.where.id===o.id){once=false;entered.resolve();await release.promise}return row}}}})
  const a=new PaymentService(client,providers),paying=pay(a,o.id);await entered.promise
  const account=await partialCard(o,5000n);release.resolve();const paid=await paying
  assert.equal(paid.payment.amount,5000n);assert.equal(paid.order.sweetCardAmount,5000n);assert.equal(paid.order.status,'completed');assert.equal((await cancel(o.id)).status,409)
  assert.equal((await h.db.sweetCardAccount.findUnique({where:{id:account}})).balanceCents,5000n);assert.equal(await h.db.sweetCardLedger.count({where:{orderId:o.id,type:'REVERSAL'}}),0);assert.equal((await facts(o.id)).revenue,10000n)
 })
 await test('PAY native: safely closed then cancelled, late success returns conflict without cancelled/paid',async()=>{
  const o=await h.order(),provider={capability:()=>false,createPayment:async()=>({callbacks:[]})},a=new PaymentService(h.second,new Map([['cash',provider]]))
  const created=await pay(a,o.id),event={paymentNo:created.payment.paymentNo,merchantTradeNo:created.payment.merchantTradeNo,eventId:'synthetic-close',status:'closed'}
  await a.applyPaymentEvent('cash',event);assert.equal((await cancel(o.id)).status,200)
  await assert.rejects(a.applyPaymentEvent('cash',{...event,eventId:'synthetic-late-success',status:'success',amount:10000n}),e=>e.status===409)
  const f=await facts(o.id);assert.equal(f.order.status,'cancelled');assert.notEqual(f.order.paymentStatus,'paid');assert.equal(f.order.payments[0].status,'closed');assert.equal(f.revenue,0n)
 })
 await test('WFL native: latest version works once; missing/wrong credentials conflict without writes',async()=>{
  const created=await h.createApproval(),id=created.body.request.id;const current=(await detail(id)).body.request;const before=await h.db.approvalLog.count({where:{requestId:id}})
  for(const contentVersion of [undefined,'1',0,-1,current.contentVersion+100])assert.equal((await approve(id,contentVersion)).status,409)
  assert.equal(await h.db.approvalLog.count({where:{requestId:id}}),before)
  const accepted=await approve(id,current.contentVersion);assert.equal(accepted.status,200)
  assert.equal((await approve(id,current.contentVersion)).status,403)
  assert.equal(await h.db.approvalLog.count({where:{requestId:id,action:'approve'}}),1)
 })
 await test('WFL native: attachment change and same-amount new round invalidate viewed version',async()=>{
  for(const options of [{changeAmount:false,attachment:true},{changeAmount:false}]){const {id,old}=await staleRound(options);assert.equal((await approve(id,old.contentVersion)).status,409);const current=(await detail(id)).body.request;assert.equal((await approve(id,current.contentVersion)).status,200)}
 })
 await test('WFL native: effective attachment insert/delete and reassociation advance both viewed generations',async()=>{
  const a=(await h.createApproval({submit:false})).body.request,b=(await h.createApproval({submit:false})).body.request
  const file=await h.db.approvalAttachment.create({data:{id:'p1-attached-version',requestId:a.id,name:'Synthetic file',fileType:'application/pdf',fileSize:syntheticPdf().length,dataUrl:'data:application/pdf;base64,'+syntheticPdf().toString('base64'),uploaderUsername:h.users.uploader.username}})
  const beforeA=await h.db.approvalRequest.findUnique({where:{id:a.id}}),beforeB=await h.db.approvalRequest.findUnique({where:{id:b.id}})
  await h.db.approvalAttachment.update({where:{id:file.id},data:{requestId:b.id}})
  assert.equal((await h.db.approvalRequest.findUnique({where:{id:a.id}})).contentVersion,beforeA.contentVersion+1);assert.equal((await h.db.approvalRequest.findUnique({where:{id:b.id}})).contentVersion,beforeB.contentVersion+1)
  await h.db.approvalAttachment.delete({where:{id:file.id}});assert.equal((await h.db.approvalRequest.findUnique({where:{id:b.id}})).contentVersion,beforeB.contentVersion+2)
 })
 await test('WFL native: current actor revocation and template interpretation change cannot use viewed authority',async()=>{
  const request=(await h.createApproval()).body.request,current=(await detail(request.id)).body.request
  const before=await h.db.approvalRequest.findUnique({where:{id:request.id}}),logs=await h.db.approvalLog.count({where:{requestId:request.id}}),notices=await h.db.approvalNotification.count({where:{requestId:request.id}})
  const entered=deferred(),release=deferred();approvalBarrier={id:request.id,entered,release}
  const deciding=approve(request.id,current.contentVersion);await entered.promise
  try{await h.second.user.update({where:{id:h.users.approver.id},data:{status:'inactive'}})}finally{release.resolve()}
  assert.equal((await deciding).status,403)
  await h.second.user.update({where:{id:h.users.approver.id},data:{status:'active'}})
  assert.deepEqual(await h.db.approvalRequest.findUnique({where:{id:request.id}}),before);assert.equal(await h.db.approvalLog.count({where:{requestId:request.id}}),logs);assert.equal(await h.db.approvalNotification.count({where:{requestId:request.id}}),notices)
  await h.second.approvalTemplate.update({where:{key:'p1-expense'},data:{name:'Synthetic changed interpretation'}})
  const advanced=await h.db.approvalRequest.findUnique({where:{id:request.id}});assert.equal(advanced.contentVersion,before.contentVersion+1)
  assert.equal((await approve(request.id,current.contentVersion)).status,409);assert.equal((await approve(request.id,advanced.contentVersion)).status,200)
 })
 await test('WFL native: multi-connection, cross-template creation allocates unique daily numbers',async()=>{
  const before=await h.db.approvalRequest.count();const results=await Promise.all(Array.from({length:12},(_,i)=>h.createApproval({submit:false,templateKey:i%2?'p1-other':'p1-expense'})))
  assert.ok(results.every(x=>x.status===200));assert.equal(new Set(results.map(x=>x.body.request.requestNo)).size,12);assert.equal(await h.db.approvalRequest.count(),before+12)
  const last=results.at(-1).body.request;assert.equal((await h.api('/v2/approvals/requests/'+last.id,{actor:'uploader',method:'DELETE'})).status,200)
  assert.equal((await h.createApproval({submit:false})).status,200)
 })
 await test('WFL native: first initialization races across templates, historical maximum, multiple gaps and cross-day',async()=>{
  const OriginalDate=globalThis.Date
  const runDay=async(instant)=>{
   globalThis.Date=class extends OriginalDate { constructor(...args){super(...(args.length?args:[instant]))} }
   try{
    const day=[new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0'),String(new Date().getDate()).padStart(2,'0')].join('')
    if(day==='20351102'){
     for(const n of [1,4,9])await h.db.approvalRequest.create({data:{id:'p1-init-'+day+'-'+n,requestNo:`AP-${day}-${String(n).padStart(4,'0')}`,templateKey:'p1-expense',title:'Synthetic existing',status:'draft',formData:{amount:10000},amountCents:10000n,submitterUsername:h.users.uploader.username}})
    }
    let results
    if(day==='20351102'){
      const entered=deferred(),release=deferred();creationBarrier={prefix:'AP-'+day,entered,release}
      const first=h.createApproval({submit:false});await entered.promise
      const rest=Promise.all(Array.from({length:5},(_,i)=>h.createApproval({submit:false,templateKey:i%2?'p1-other':'p1-expense'})))
      try{await until(async()=>{const [row]=await h.observer.$queryRawUnsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%approval_request_daily_sequences%'");return row.n>0},'second connection blocked during first daily counter initialization')}finally{release.resolve()}
      results=[await first,...await rest]
    }else results=await Promise.all(Array.from({length:6},(_,i)=>h.createApproval({submit:false,templateKey:i%2?'p1-other':'p1-expense'})))
    assert.ok(results.every(x=>x.status===200));const numbers=results.map(x=>x.body.request.requestNo).sort();assert.equal(new Set(numbers).size,6)
    assert.equal(numbers[0],`AP-${day}-${day==='20351102'?'0010':'0001'}`)
    const last=results.find(x=>x.body.request.requestNo===numbers.at(-1)).body.request
    assert.equal((await h.api('/v2/approvals/requests/'+last.id,{actor:'uploader',method:'DELETE'})).status,200)
    const next=await h.createApproval({submit:false});assert.equal(next.status,200);assert.ok(next.body.request.requestNo>numbers.at(-1))
   }finally{globalThis.Date=OriginalDate}
  }
  await runDay('2035-11-01T16:00:00Z');await runDay('2035-11-02T16:00:00Z')
 })
 await test('WFL native: allocator and create failure rollback; no half request or consumed value',async()=>{
  const before=await h.db.approvalRequestDailySequence.findMany(),count=await h.db.approvalRequest.count()
  const failed=await h.createApproval({attachmentIds:['synthetic-nonexistent']});assert.equal(failed.status,400);assert.equal(await h.db.approvalRequest.count(),count);assert.deepEqual(await h.db.approvalRequestDailySequence.findMany(),before)
  assert.equal((await h.createApproval({submit:false})).status,200)
 })
 await test('AUTH native: historical counterfeit read is download-only without rewriting bytes; real PDF MIME preserved',async()=>{
  const bad='data:text/html;base64,'+Buffer.from('<script>parent.__p1Executed=true</script>').toString('base64')
  const file=await h.db.assetFile.create({data:{id:'p1-historical-html',name:'Synthetic historical',category:'p1-category',fileType:'application/pdf',versions:{create:{id:'p1-historical-v1',version:1,name:'old.pdf',fileType:'application/pdf',dataUrl:bad,uploaderName:'Synthetic'}}}})
  const response=await h.api('/v2/asset-center/files/'+file.id+'/download');assert.equal(response.status,200);assert.equal(response.body.fileType,'application/octet-stream');assert.equal(response.body.previewKind,'download');assert.equal((await h.db.assetFileVersion.findUnique({where:{id:'p1-historical-v1'}})).dataUrl,bad)
  const binary=await h.api('/v2/asset-center/files/'+file.id+'/download?asFile=1',{raw:true});assert.match(binary.headers.get('content-disposition'),/^attachment;/);assert.equal(binary.headers.get('x-content-type-options'),'nosniff');assert.match(binary.headers.get('content-security-policy'),/sandbox/)
  assert.equal((await h.api('/v2/asset-center/files/'+file.id+'/download',{actor:'outsider'})).status,403)
  const pdf=await h.api('/v2/asset-center/files',{actor:'uploader',method:'POST',body:{name:'Synthetic PDF',category:'p1-category',fileType:'application/pdf',dataUrl:'data:application/pdf;base64,'+syntheticPdf().toString('base64')}});assert.equal(pdf.status,201)
  const get=await h.api('/v2/asset-center/files/'+pdf.body.file.id+'/download');assert.equal(get.body.fileType,'application/pdf');assert.equal(get.body.previewKind,'pdf')
  const versions=await h.api('/v2/asset-center/files/'+file.id+'/versions');assert.equal(versions.body.rows[0].previewKind,'download');assert.equal(versions.body.rows[0].fileType,'application/octet-stream')
  assert.equal((await h.api('/v2/asset-center/files/'+file.id+'/restore',{method:'POST',body:{version:1}})).status,200)
  assert.equal((await h.api('/v2/asset-center/files/'+file.id+'/download')).body.previewKind,'download');assert.equal((await h.db.assetFileVersion.findUnique({where:{id:'p1-historical-v1'}})).dataUrl,bad)
  assert.equal((await h.api('/v2/asset-center/files/'+pdf.body.file.id,{actor:'uploader',method:'PUT',body:{dataUrl:bad,fileType:'application/pdf'}})).status,400)
  assert.equal(await h.db.assetFileVersion.count({where:{fileId:pdf.body.file.id}}),1)
 })
 await test('AUTH native: employee upload/content preserves own-object and sensitive access boundaries',async()=>{
  const employeeId=h.users.uploader.employeeId,route='/v2/employees/'+employeeId+'/documents',html=Buffer.from('<script>parent.__p1Executed=true</script>').toString('base64')
  assert.equal((await h.api(route,{method:'POST',body:{fileName:'fake.pdf',mimeType:'application/pdf',data:html}})).status,400)
  const bytes=syntheticPdf(),normal=await h.api(route,{method:'POST',body:{fileName:'employee.pdf',mimeType:'application/pdf',data:bytes.toString('base64')}});assert.equal(normal.status,200)
  const contentRoute=route+'/'+normal.body.id+'/content',self=await h.api(contentRoute,{actor:'uploader',raw:true});assert.equal(self.status,200);assert.equal(self.headers.get('content-type'),'application/pdf');assert.match(self.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await self.arrayBuffer()),bytes)
  assert.equal((await h.api(contentRoute,{actor:'outsider'})).status,403)
  assert.equal((await h.api('/v2/employees/'+h.users.viewer.employeeId+'/documents/'+normal.body.id+'/content')).status,404)
  await h.db.employeeDocument.create({data:{id:'p1-employee-historical',employeeId,documentType:'other',fileName:'historical.pdf',mimeType:'application/pdf',fileSize:Buffer.from(html,'base64').length,data:html,isSensitive:true,uploadedBy:'Synthetic'}})
  const historicalRoute=route+'/p1-employee-historical/content';assert.equal((await h.api(historicalRoute,{actor:'uploader'})).status,403)
  const historical=await h.api(historicalRoute,{raw:true});assert.equal(historical.status,200);assert.equal(historical.headers.get('content-type'),'application/octet-stream');assert.match(historical.headers.get('content-security-policy'),/sandbox/);assert.equal((await h.db.employeeDocument.findUnique({where:{id:'p1-employee-historical'}})).data,html)
 })
 }
}finally{orderBarrier?.release.resolve();approvalBarrier?.release.resolve();creationBarrier?.release.resolve();unresolvedBarrier?.release.resolve();await h.close()}
