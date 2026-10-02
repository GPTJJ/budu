import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDisposablePgDatabase, dropDisposablePgDatabase } from './helpers/test-pg-schema.mjs'
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'budu-material-native-'))
process.env.DATA_DIR=dataDir
process.env.DATABASE_URL=await createDisposablePgDatabase('material_center_native')
const {prisma}=await import('../server/pg.js')
const {v2Router}=await import('../server/v2.js')
const {createReplenishmentOrder}=await import('../server/replenishment-order-service.js')
const {quotePartnerCatalogueItem}=await import('../server/partner-replenishment-catalogue.js')
const {appendProductCostVersion}=await import('../server/product-cost-authority.js')

test('原生PG：原ID及历史引用、价格触发器、唯一编号、并发版本和补货提交',async()=>{
 const category=await prisma.productCategory.create({data:{id:'native-material-category',name:'物料'}})
 for(let i=0;i<4;i++)await prisma.inventoryItem.create({data:{id:`native-protected-${i}`,name:`Native商品${i}`,sku:`NATIVE-SKU-${i}`,transferCode:`NATIVE-CODE-${i}`,category:'product',productCategoryId:category.id,image:`protected-image-${i}`,isActive:false,transferEnabled:true,partnerReplenishmentEnabled:true,partnerOrderUnit:'NATIVE',partnerMinOrderBaseQty:1,partnerOrderStepBaseQty:1,unit:'个',salePriceCents:10n,costPriceCents:10n}})
 const before=await prisma.inventoryItem.findMany({where:{category:'product'},orderBy:{id:'asc'}})
 await prisma.inventoryItem.create({data:{id:'native-original-material',name:'Native旧冰袋',category:'material',transferEnabled:true}})
 await prisma.transferRequest.create({data:{id:'native-historical-transfer',fromLocationName:'Native历史仓',toLocationName:'Native历史门店',items:{create:{id:'native-historical-item',itemId:'native-original-material',quantity:3,categorySnapshot:'material'}}}})
 const app=express();app.use(express.json(),(req,res,next)=>{req.user={id:'native-test-actor',role:'developer',status:'active'};next()},v2Router)
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
 const root=`http://127.0.0.1:${server.address().port}/transfer-master-items`
 const request=async(path,method,body)=>{const r=await fetch(root+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()}}
 try{
  const first=await request('/native-original-material','PUT',{version:1,name:'Native冰袋新名',sortOrder:3})
  assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.item.id,'native-original-material');assert.equal(first.body.item.category,'material');assert.equal(first.body.item.salePriceCents,'10');assert.equal(first.body.item.costPriceCents,'10')
  const sku=first.body.item.sku,code=first.body.item.code;assert.ok(sku);assert.equal(sku,code)
  assert.equal(first.body.item.productCategoryId,category.id)
  assert.equal(await prisma.inventoryItemCostHistory.count({where:{inventoryItemId:'native-original-material'}}),1)
  const history=await prisma.transferItem.findUnique({where:{id:'native-historical-item'}})
  assert.equal(history.itemId,'native-original-material');assert.equal(history.itemNameSnapshot,'Native旧冰袋');assert.equal(history.quantity,3)
  const concurrent=await Promise.all([request('/native-original-material','PUT',{version:2,name:'Native冰袋A',sortOrder:4}),request('/native-original-material','PUT',{version:2,name:'Native冰袋B',sortOrder:5})])
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409])
  const latest=await prisma.inventoryItem.findUnique({where:{id:'native-original-material'}})
  assert.equal(latest.sku,sku);assert.equal(latest.transferCode,code);assert.equal(latest.version,3)
  assert.equal(await prisma.inventoryItemCostHistory.count({where:{inventoryItemId:latest.id}}),1)
  await assert.rejects(()=>prisma.inventoryItem.create({data:{id:'native-collision',name:'Native编号冲突',category:'material',sku}}),e=>e.code==='P2002')
  const fresh=await request('','POST',{category:'material',name:'Native新物料',enabled:true})
  assert.equal(fresh.status,201,JSON.stringify(fresh.body));assert.equal(fresh.body.item.isActive,false);assert.equal(fresh.body.item.partnerReplenishmentEnabled,false)
  assert.equal(await prisma.inventoryItemCostHistory.count({where:{inventoryItemId:fresh.body.item.id}}),1)
  assert.equal((await request('/native-original-material','PUT',{version:3,name:latest.name,partnerReplenishmentEnabled:true,partnerOrderUnit:'NATIVE',unit:'包'})).status,400)
  const enabled=await request('/native-original-material','PUT',{version:3,name:latest.name,partnerReplenishmentEnabled:true,partnerOrderUnit:'NATIVE',unit:'包',partnerMaterialPriceCents:'200'})
  assert.equal(enabled.status,200,JSON.stringify(enabled.body))
  await prisma.store.create({data:{key:'native-store',name:'Native测试门店'}})
  await prisma.partner.create({data:{id:'native-partner',name:'Native合作商',defaultStoreKey:'native-store',defaultDiscountBps:6500}})
  await prisma.partnerStore.create({data:{id:'native-partner-store',partnerId:'native-partner',name:'Native合作门店'}})
  const submit={db:prisma,createdByType:'PARTNER',actor:{id:'native-test-actor',name:'Native Actor'},principalPartnerId:'native-partner',body:{partnerStoreId:'native-partner-store',items:[{inventoryItemId:latest.id,orderUnit:'NATIVE',quantity:2}]},idempotencyKey:'native-material-submit-001'}
  const order=(await createReplenishmentOrder(submit)).order
  assert.equal(order.requestedTotalAmountCents,260n);assert.equal(order.items[0].inventoryItemId,latest.id);assert.equal(order.items[0].basePriceSnapshotCents,200n)
  assert.equal((await createReplenishmentOrder(submit)).reused,true)
  for(const orderUnit of ['KG','PCS','NATIVE']){
   const current=await prisma.inventoryItem.findUnique({where:{id:latest.id}})
   const unitSave=await request('/native-original-material','PUT',{version:current.version,name:current.name,partnerReplenishmentEnabled:true,partnerOrderUnit:orderUnit,unit:'包',partnerMaterialPriceCents:'300'})
   assert.equal(unitSave.status,200,JSON.stringify(unitSave.body))
   const quantity=orderUnit==='KG'?{quantityGrams:1000}:orderUnit==='PCS'?{quantityPieces:1}:{quantityUnits:1}
   const quote=await quotePartnerCatalogueItem({db:prisma,principal:{partnerId:'native-partner'},body:{productId:latest.id,orderUnit,...quantity}})
   assert.equal(quote.finalAmountCents,'195');assert.equal(quote.basePriceCents,'300')
  }
  assert.equal((await prisma.replenishmentOrderItem.findFirst({where:{inventoryItemId:latest.id}})).basePriceSnapshotCents,200n)
  const futureDate=new Date(Date.now()+3*86400000).toISOString().slice(0,10)
  const cost=await request('/native-original-material/cost-history','POST',{costPriceCents:'20',effectiveFrom:futureDate,reason:'Native追加成本'})
  assert.equal(cost.status,201,JSON.stringify(cost.body));assert.equal(await prisma.inventoryItemCostHistory.count({where:{inventoryItemId:latest.id}}),2)
  const oldest=await prisma.inventoryItemCostHistory.findFirst({where:{inventoryItemId:latest.id},orderBy:{effectiveFrom:'asc'}})
  assert.equal(oldest.costPriceCents,10n)
  const controlProduct=await prisma.inventoryItem.create({data:{id:'native-cost-control',name:'Native普通商品成本对照',category:'product',costPriceCents:10n}})
  const productCost=await appendProductCostVersion(prisma,{inventoryItemId:controlProduct.id,costPriceCents:'20',effectiveFrom:futureDate,reason:'Native普通商品成本路径对照'})
  assert.equal(productCost.costPriceCents,20n)
  assert.deepEqual(await prisma.inventoryItem.findMany({where:{id:{in:before.map(r=>r.id)}},orderBy:{id:'asc'}}),before)
 }finally{await new Promise(r=>server.close(r))}
})

test.after(async()=>{await prisma.$disconnect();await dropDisposablePgDatabase(process.env.DATABASE_URL);fs.rmSync(dataDir,{recursive:true,force:true})})
