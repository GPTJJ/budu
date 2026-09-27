import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'
const url = await createDisposablePgDatabase('order_purpose', { applyMigrations: false })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'budu-purpose-'))
process.env.DATABASE_URL = url
process.env.DATA_DIR = path.join(temp, 'data')
process.env.JWT_SECRET = 'isolated-purpose-test-secret'
process.env.APP_ENV = 'test'
const nativeFetch = globalThis.fetch
globalThis.fetch = (url, ...args) => {
  if (!String(url).startsWith('http://127.0.0.1:')) throw new Error('TEST_EXTERNAL_NETWORK_BLOCKED')
  return nativeFetch(url, ...args)
}
const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient({ datasourceUrl: url })
const { createApp } = await import('../server/app.js')
const { hashPassword, signToken } = await import('../server/auth.js')
const { prisma: appDb } = await import('../server/pg.js')
const { changeOrderPurpose, deleteTestOrder } = await import('../server/order-purpose-service.js')
const migration = '20260921010000_unified_order_purpose'
let server
const cases = []
const pass = name => { cases.push(name); console.log('PASS:', name) }
try {
  fs.cpSync('prisma', path.join(temp, 'prisma'), { recursive: true })
  fs.rmSync(path.join(temp, 'prisma/migrations', migration), { recursive: true })
  const migrate = schema => execFileSync('node_modules/.bin/prisma', ['migrate','deploy','--schema',schema], { env: process.env, stdio: 'pipe' })
  migrate(path.join(temp, 'prisma/schema.prisma'))
  assert.equal(Number((await db.$queryRawUnsafe('SELECT count(*) FROM _prisma_migrations'))[0].count), 83)
  await db.store.createMany({ data: [{ key:'guanshe',name:'官舍隔离店' },{ key:'xidan',name:'西单隔离店' }] })
  const users = {}
  for (const role of ['developer','admin','finance','hr','manager','staff','partner','customer']) users[role] = await db.user.create({ data: { id:role,username:role,role,status:'active',passwordHash:hashPassword('test-password') } })
  await db.partner.create({ data: { id:'p',name:'隔离合作商',defaultStoreKey:'guanshe' } })
  await db.partnerStore.create({ data: { id:'ps',partnerId:'p',name:'隔离收货店' } })
  await db.partnerUser.create({ data: { id:'pu',partnerId:'p',userId:'partner' } })
  await db.productCategory.create({ data:{ id:'pc-mtd9xjer-sfcmx2',name:'糖果' } })
  await db.inventoryItem.create({ data: { id:'i',name:'隔离糖果',category:'product',sku:'purpose-fixture',unit:'颗',salePriceCents:500n,productCategoryId:'pc-mtd9xjer-sfcmx2',isActive:true,partnerReplenishmentEnabled:true,partnerOrderUnit:'PCS',partnerMinOrderBaseQty:1,partnerOrderStepBaseQty:1,transferEnabled:true } })
  for (const id of ['legacy-p','legacy-paid']) {
    await db.$executeRawUnsafe(`INSERT INTO "ReplenishmentOrder" (id,"orderNo","partnerId","partnerStoreId","partnerNameSnapshot","partnerStoreNameSnapshot","createdByType","createdByActorId","requestedTotalAmountCents","idempotencyScope","idempotencyKey","idempotencyPayloadDigest") VALUES ($1,$1,'p','ps','隔离合作商','隔离收货店','INTERNAL','developer',3250,$1,$1,repeat('a',64))`,id)
    await db.$executeRawUnsafe(`INSERT INTO "ReplenishmentOrderItem" (id,"replenishmentOrderId","inventoryItemId","productNameSnapshot","orderUnitSnapshot","requestedQuantityBase","basePriceSnapshotCents","discountBpsSnapshot","requestedLineAmountCents","minimumOrderBaseQtySnapshot","orderStepBaseQtySnapshot") VALUES ($1,$2,'i','隔离糖果','PCS',10,500,6500,3250,1,1)`,id+'-i',id)
  }
  await db.$executeRawUnsafe(`INSERT INTO "TransferRequest" (id,"fromStoreKey","toStoreKey","createdBy") VALUES ('legacy-t','guanshe','xidan','developer')`)
  await db.transferItem.create({ data: { id:'legacy-ti',requestId:'legacy-t',itemId:'i',quantity:10,itemNameSnapshot:'隔离糖果',categorySnapshot:'product' } })
  const history = await db.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "ReplenishmentOrder" t ORDER BY id`)
  migrate('prisma/schema.prisma')
  assert.equal(Number((await db.$queryRawUnsafe('SELECT count(*) FROM _prisma_migrations'))[0].count),84)
  assert.deepEqual(await db.$queryRawUnsafe(`SELECT to_jsonb(t)-'purpose' AS row FROM "ReplenishmentOrder" t ORDER BY id`),history)
  assert.equal(await db.replenishmentOrder.count({where:{purpose:'LEGACY_UNCLASSIFIED'}}),2)
  assert.equal(await db.transferRequest.count({where:{purpose:'LEGACY_UNCLASSIFIED'}}),1)
  pass('A: 83→84 native PostgreSQL migration preserves history and classifies only LEGACY_UNCLASSIFIED')
  server = createApp({ partnerDomainMirrorUsers: async()=>{} }).listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const origin=`http://127.0.0.1:${server.address().port}`
  const call = async (route,{role='developer',method='GET',body,key}={}) => {
    const result=await fetch(origin+'/api/v2'+route,{method,headers:{Cookie:'budu_token='+signToken(users[role],process.env.JWT_SECRET),'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})})
    return {status:result.status,body:await result.json()}
  }
  const submission={partnerId:'p',partnerStoreId:'ps',items:[{inventoryItemId:'i',quantity:10,orderUnit:'PCS'}]}
  let result=await call('/partner-management/replenishment-orders',{method:'POST',body:submission,key:'ordinary-real-create'})
  assert.equal(result.status,201,JSON.stringify(result));assert.equal(result.body.order.purpose,'REAL')
  const realId=result.body.order.id
  result=await call('/partner-management/replenishment-orders',{method:'POST',body:{...submission,purpose:'TEST'},key:'spoofed-purpose-create'})
  assert.equal(result.status,400)
  result=await call('/transfer-requests',{method:'POST',body:{fromStoreKey:'guanshe',toStoreKey:'xidan',items:[{itemId:'i',name:'隔离糖果',category:'product',quantity:3}]}})
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.request.purpose,'REAL')
  result=await call('/transfer-requests',{method:'POST',body:{purpose:'TEST'}})
  assert.equal(result.status,400)
  pass('B: normal Partner/transfer creates REAL; ordinary inputs cannot assign purpose')
  const reason='隔离测试：验证订单用途与受控删除'
  const mutate=(type,id,action,purpose,expectedPurpose='LEGACY_UNCLASSIFIED',role='developer')=>call(`/order-purpose/${type}/${id}/${action}`,{method:'POST',role,body:{purpose,expectedPurpose,reason}})
  for(const [type,id,purpose] of [['partner',realId,'REAL'],['partner','legacy-p','LEGACY_UNCLASSIFIED'],['transfer','legacy-t','LEGACY_UNCLASSIFIED']]) {
    result=await mutate(type,id,'delete-test',undefined,purpose);assert.equal(result.status,409)
  }
  pass('D/E: REAL and LEGACY_UNCLASSIFIED hard delete denied')
  for(const role of ['finance','hr','manager','staff','partner','customer']) {
    result=await mutate('partner','legacy-p','classify','TEST','LEGACY_UNCLASSIFIED',role)
    assert.ok([401,403].includes(result.status),JSON.stringify({role,result}))
    result=await call('/order-purpose/orders',{role});assert.ok([401,403].includes(result.status))
    result=await call('/order-purpose/test-partner',{role,method:'POST',body:{sourceId:'legacy-p',purpose:'TEST',reason},key:'deny-'+role+'-create'});assert.ok([401,403].includes(result.status))
  }
  pass('J: server RBAC denies finance/hr/manager/staff/external; admin explicitly mapped to super_admin')
  // A true economic reference makes legacy classification fail closed.
  await db.$transaction(async tx => {
    await tx.order.create({data:{id:'legacy-paid',orderNo:'pos-paid',storeId:'guanshe',cashierId:'developer',checkoutKey:'paid',cartHash:'paid',status:'draft',subtotal:100n,payableAmount:100n}})
    await tx.payment.create({data:{id:'payment',paymentNo:'payment',orderId:'legacy-paid',channel:'cash',amount:100n,status:'success',merchantTradeNo:'payment',provider:'cash',requestKey:'payment'}})
    await tx.order.update({where:{id:'legacy-paid'},data:{status:'paid'}})
  })
  result=await mutate('partner','legacy-paid','classify','TEST');assert.equal(result.body.error,'LEGACY_ORDER_HAS_REAL_SIDE_EFFECTS')
  result=await mutate('partner','legacy-paid','classify','REAL');assert.equal(result.status,200)
  const protectedTables=['orders','payments','refunds','sweet_card_ledger','daily_store_staff','StockLedger','InventoryItem','Partner','partner_users','Store']
  const facts=async()=>Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await db.$queryRawUnsafe(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash,count(*)::int AS count FROM "${t}" t`)])))
  const protectedBefore=await facts()
  pass('G: real payment/financial side effects block test classification; REAL classification allowed')
  result=await mutate('partner','legacy-p','classify','TEST');assert.equal(result.status,200,JSON.stringify(result))
  result=await mutate('transfer','legacy-t','classify','ACCEPTANCE_TEST','LEGACY_UNCLASSIFIED','admin');assert.equal(result.status,200)
  pass('F: developer and canonical admin classify individually with permanent audit')
  result=await mutate('partner','legacy-p','classify','REAL');assert.equal(result.status,409)
  await db.$executeRawUnsafe(`CREATE FUNCTION isolated_fail_purpose_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_PURPOSE_FAILURE'; END $$`)
  await db.$executeRawUnsafe(`CREATE TRIGGER zzz_fail_purpose_update BEFORE UPDATE ON "ReplenishmentOrder" FOR EACH ROW WHEN (NEW.purpose IS DISTINCT FROM OLD.purpose) EXECUTE FUNCTION isolated_fail_purpose_update()`)
  const classifyAudits=await db.orderPurposeAudit.count()
  await assert.rejects(()=>changeOrderPurpose({db,actorId:'developer',type:'partner',id:realId,correction:true,body:{purpose:'TEST',expectedPurpose:'REAL',reason}}))
  assert.equal((await db.replenishmentOrder.findUnique({where:{id:realId}})).purpose,'REAL')
  assert.equal(await db.orderPurposeAudit.count(),classifyAudits)
  await db.$executeRawUnsafe('DROP TRIGGER zzz_fail_purpose_update ON "ReplenishmentOrder"')
  pass('Classification/correction rollback and stale classification denied')
  for(const type of ['partner','transfer']) {
    const sourceId=type==='partner'?'legacy-p':'legacy-t'
    for(const purpose of ['TEST','ACCEPTANCE_TEST']) {
      const key=`create-${type}-${purpose}`
      result=await call(`/order-purpose/test-${type}`,{role:'admin',method:'POST',body:{sourceId,purpose,reason},key})
      assert.equal(result.status,201,JSON.stringify(result));const row=result.body.order||result.body.request
      assert.equal(row.purpose,purpose)
      const again=await call(`/order-purpose/test-${type}`,{role:'admin',method:'POST',body:{sourceId,purpose,reason},key});assert.equal(again.status,200)
      assert.equal((again.body.order||again.body.request).id,row.id)
      const changed=await call(`/order-purpose/test-${type}`,{role:'admin',method:'POST',body:{sourceId,purpose:purpose==='TEST'?'ACCEPTANCE_TEST':'TEST',reason},key});assert.equal(changed.status,409)
      assert.equal(await db.notification.count({where:{refId:row.id}}),0)
      result=await mutate(type,row.id,'delete-test',undefined,purpose,'admin');assert.equal(result.status,200,JSON.stringify(result))
      const duplicate=await mutate(type,row.id,'delete-test',undefined,purpose,'admin');assert.equal(duplicate.status,404)
      const recreation=await call(`/order-purpose/test-${type}`,{role:'admin',method:'POST',body:{sourceId,purpose,reason},key});assert.equal(recreation.status,410)
      assert.equal(await db.orderPurposeAudit.count({where:{orderId:row.id,action:'DELETE_TEST'}}),1)
      assert.equal(await db[type==='partner'?'replenishmentOrderItem':'transferItem'].count({where:type==='partner'?{replenishmentOrderId:row.id}:{requestId:row.id}}),0)
    }
  }
  pass('C/H/I/L/M: explicit test creation, retry, atomic owned-child delete, stable repeated delete, replay tombstones, retained audit')
  const races=await Promise.all([1,2].map(()=>call('/order-purpose/test-transfer',{method:'POST',body:{sourceId:'legacy-t',purpose:'TEST',reason},key:'same-concurrent-create'})))
  assert.ok(races.every(r=>[200,201,409].includes(r.status)),JSON.stringify(races))
  const retryRace=await call('/order-purpose/test-transfer',{method:'POST',body:{sourceId:'legacy-t',purpose:'TEST',reason},key:'same-concurrent-create'})
  assert.equal(retryRace.status,200)
  assert.equal(await db.orderPurposeAudit.count({where:{operationKey:'test-transfer:developer:same-concurrent-create'}}),1)
  const raceId=retryRace.body.request.id
  const deletions=await Promise.all([1,2].map(()=>mutate('transfer',raceId,'delete-test',undefined,'TEST')))
  assert.equal(deletions.filter(r=>r.status===200).length,1)
  assert.ok(deletions.every(r=>[200,404,409].includes(r.status)),JSON.stringify(deletions))
  assert.equal(await db.orderPurposeAudit.count({where:{orderId:raceId,action:'DELETE_TEST'}}),1)
  pass('Concurrent create/delete produce one effect and one deletion audit')
  result=await call('/order-purpose/test-partner',{method:'POST',body:{sourceId:'legacy-p',purpose:'TEST',reason},key:'test-marker-real-effects'})
  assert.equal(result.status,201)
  const effectId=result.body.order.id
  await db.order.create({data:{id:effectId,orderNo:'test-effect-pos',storeId:'guanshe',cashierId:'developer',checkoutKey:'test-effect',cartHash:'test-effect',subtotal:100n,payableAmount:100n}})
  await db.payment.create({data:{id:'test-payment',paymentNo:'test-payment',orderId:effectId,channel:'cash',amount:100n,status:'success',merchantTradeNo:'test-payment',provider:'cash',requestKey:'test-payment'}})
  result=await mutate('partner',effectId,'delete-test',undefined,'TEST');assert.equal(result.body.error,'TEST_ORDER_HAS_REAL_SIDE_EFFECTS')
  await assert.rejects(()=>db.notification.create({data:{id:'test-external',username:'developer',title:'test',content:'test',refType:'partner_replenishment',refId:effectId}}))
  // These economic sentinels were intentionally added by this test, not the deletion service.
  const protectedAfterSentinels=await facts()
  pass('TEST with payment denied; TEST external notification prevented at database boundary')
  // Force failure after audit + item deletion. Native transaction must undo all.
  await db.$executeRawUnsafe(`CREATE FUNCTION isolated_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_TEST_FAILURE'; END $$`)
  await db.$executeRawUnsafe(`CREATE TRIGGER zzz_fail_delete BEFORE DELETE ON "ReplenishmentOrder" FOR EACH ROW EXECUTE FUNCTION isolated_fail_delete()`)
  const auditBefore=await db.orderPurposeAudit.count()
  await assert.rejects(()=>deleteTestOrder({db,actorId:'developer',type:'partner',id:'legacy-p',body:{reason,expectedPurpose:'TEST'}}))
  assert.equal(await db.replenishmentOrderItem.count({where:{replenishmentOrderId:'legacy-p'}}),1)
  assert.equal(await db.orderPurposeAudit.count(),auditBefore)
  await db.$executeRawUnsafe('DROP TRIGGER zzz_fail_delete ON "ReplenishmentOrder"')
  pass('K: mid-transaction failure rolls back items/order/audit together')
  await assert.rejects(()=>db.replenishmentOrder.update({where:{id:'legacy-p'},data:{purpose:'REAL'}}))
  await assert.rejects(()=>db.orderPurposeAudit.deleteMany({where:{orderId:'legacy-p'}}))
  await assert.rejects(()=>db.transferRequest.delete({where:{id:'legacy-t'}}))
  pass('DB guards: unaudited purpose rewrite, audit mutation and direct deletion denied')
  // A test marker alone never authorizes removing fulfillment facts.
  await db.transferRequest.update({where:{id:'legacy-t'},data:{status:'shipped',shippedAt:new Date()}})
  result=await mutate('transfer','legacy-t','delete-test',undefined,'ACCEPTANCE_TEST');assert.equal(result.body.error,'TEST_ORDER_HAS_REAL_SIDE_EFFECTS')
  const ns=await db.replenishmentOrder.findUnique({where:{id:realId}})
  assert.equal(ns.purpose,'REAL')
  // Real order remains unchanged in all report/economic authorities.
  const finalFacts=await facts()
  assert.deepEqual(finalFacts,protectedAfterSentinels)
  for (const table of protectedTables.filter(t=>!['orders','payments'].includes(t))) assert.deepEqual(finalFacts[table],protectedBefore[table])
  pass('N: report inputs/payment/refund/Sweet Card/payroll/inventory/product/partner/store facts unchanged')
  const orderAudit=await db.partnerAuditLog.count({where:{entityId:'legacy-p'}})
  result=await mutate('partner','legacy-p','delete-test',undefined,'TEST');assert.equal(result.status,200)
  assert.equal(await db.partnerAuditLog.count({where:{entityId:'legacy-p'}}),orderAudit)
  await assert.rejects(()=>db.notification.create({data:{id:'late-notify',username:'developer',title:'late',content:'late',refType:'partner_replenishment',refId:'legacy-p'}}))
  pass('No late notification orphan; shared Partner audit retained')
  console.log(JSON.stringify({result:'ORDER_PURPOSE_TARGETED_PASS',cases,checks:cases.length}))
} finally {
  await new Promise(r=>server?server.close(r):r())
  await appDb.$disconnect();await db.$disconnect()
  await dropDisposablePgDatabase(url)
  fs.rmSync(temp,{recursive:true,force:true})
}
