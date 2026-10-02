import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { materialData, materialIdentifiers, materialExtras } from '../server/material-master.js'
import { materialIntegrationPlan, APPROVED_PRODUCT_SKUS } from '../server/material-integration-plan.js'
import { listPartnerCatalogue, quotePartnerCatalogueItem, isCatalogueEligible } from '../server/partner-replenishment-catalogue.js'
import { ALL_MODULE_KEYS, MODULE_KEYS, hasModuleAccess, hasPageAccess } from '../shared/accountPermissions.js'
import { appendProductCostVersion } from '../server/product-cost-authority.js'

const category={id:'test-material-category',name:'物料'}
const four=Array.from({length:4},(_,i)=>({id:`protected-${i}`,name:`测试既有商品${i}`,sku:APPROVED_PRODUCT_SKUS[i]||'TEST-FOURTH',transferCode:`code-${i}`,category:'product',productCategoryId:category.id,image:`image-${i}`,isActive:false,transferEnabled:true,partnerReplenishmentEnabled:true,salePriceCents:10n,costPriceCents:10n,version:4,_count:{transferItems:1,purchaseItems:0,orderItems:0,replenishmentItems:1,costHistories:1}}))

test('缺失价格初始化10分，旧价格/成本保留，POS及初始补货关闭',()=>{
 const fresh=materialData({name:'冰袋'})
 assert.equal(fresh.salePriceCents,10n);assert.equal(fresh.costPriceCents,10n)
 assert.equal(fresh.isActive,false);assert.equal(fresh.partnerReplenishmentEnabled,false)
 const old={id:'m',name:'冰袋',sku:'KEEP-SKU',transferCode:'KEEP-CODE',salePriceCents:75n,costPriceCents:38n,transferSortOrder:7}
 const saved=materialData({name:'冰袋新名称',sortOrder:2},old)
 assert.equal(saved.salePriceCents,75n);assert.equal(saved.costPriceCents,38n)
 assert.throws(()=>materialData({name:'冰袋',costPriceCents:'10'},old),/成本历史/)
 assert.throws(()=>materialData({name:'冰袋',sku:'CHANGED'},old),/编号/)
 assert.equal(materialExtras(old,false).costPriceCents,null)
})

test('物料补货不以10分零售/成本代填独立报价，显式开关及单位受校验',()=>{
 for(const body of [{},{partnerMaterialPriceCents:'0'},{partnerMaterialPriceCents:'200',partnerOrderUnit:'NATIVE'}])assert.throws(()=>materialData({name:'冰袋',partnerReplenishmentEnabled:true,...body}),/报价|单位/)
 const row=materialData({name:'冰袋',partnerReplenishmentEnabled:true,partnerMaterialPriceCents:'200',partnerOrderUnit:'NATIVE',unit:'包'})
 assert.equal(row.partnerMaterialPriceCents,200n);assert.equal(row.salePriceCents,10n)
 assert.equal(materialData({name:'冰袋'},row).partnerMaterialPriceCents,200n)
})

test('编号按稳定ID生成，改名排序/重试不变，全局逐列冲突重试且保留旧编号',async()=>{
 const rows=[]
 const tx={inventoryItem:{findFirst:async({where})=>rows.find(r=>r.id!==where.id.not&&where.OR.some(s=>Object.entries(s).some(([k,v])=>r[k]===v)))||null}}
 const one=await materialIdentifiers(tx,{id:'old-material',name:'冰袋',sortOrder:1})
 assert.equal(one.sku,one.transferCode);assert.ok(one.sku.length<=40)
 assert.deepEqual(await materialIdentifiers(tx,{id:'old-material',name:'改名',sortOrder:99}),one)
 rows.push({id:'protected-existing',sku:one.sku,transferCode:'UNRELATED'})
 const retried=await materialIdentifiers(tx,{id:'old-material'})
 assert.notEqual(retried.sku,one.sku)
 assert.deepEqual(await materialIdentifiers(tx,{id:'old-material'}),retried)
 assert.deepEqual(await materialIdentifiers(tx,{id:'old-material',sku:'KEEP-SKU',transferCode:'KEEP-CODE'}),{sku:'KEEP-SKU',transferCode:'KEEP-CODE'})
 assert.deepEqual(await materialIdentifiers(tx,{id:'missing-code',sku:'KEEP-OTHER'}),{sku:'KEEP-OTHER',transferCode:'KEEP-OTHER'})
 assert.deepEqual(await materialIdentifiers(tx,{id:'missing-sku',transferCode:'KEEP-OTHER'}),{sku:'KEEP-OTHER',transferCode:'KEEP-OTHER'})
 const generated=await Promise.all(Array.from({length:100},(_,i)=>materialIdentifiers(tx,{id:`concurrent-${i}`})))
 assert.equal(new Set(generated.map(r=>r.sku)).size,100)
})

test('只读计划保留4项商品/所有原物料ID及引用；同名仅报冲突、不合并',()=>{
 const original=structuredClone(four)
 const material={id:'m-original',name:'旧物料',category:'material',version:1,_count:{transferItems:8,purchaseItems:3,costHistories:1}}
 const plan=materialIntegrationPlan(category,[...four,material])
 assert.equal(plan.mode,'READ_ONLY');assert.deepEqual(plan.conflicts,[])
 assert.deepEqual(plan.protectedProducts.map(r=>r.id),four.map(r=>r.id));assert.deepEqual(four,original)
 assert.equal(plan.materials[0].id,'m-original');assert.equal(plan.materials[0].references.transferItems,8)
 assert.equal(materialIntegrationPlan(category,[...four,{...material,name:four[0].name}]).conflicts[0].type,'DISTINCT_ID_NAME_REVIEW')
 assert.throws(()=>materialIntegrationPlan(null,four),/NOT_CONFIRMED/)
 assert.ok(materialIntegrationPlan(category,four.slice(0,3)).conflicts.length)
})

test('4种权限组合进入合并页面，但不扩大商品/物料API能力',()=>{
 for(const [product,material] of [[false,false],[true,false],[false,true],[true,true]]){
  const modules=Object.fromEntries(ALL_MODULE_KEYS.map(k=>[k,false]));modules[MODULE_KEYS.PRODUCT_CENTER]=product;modules[MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT]=material
  const user={role:'manager',status:'active',permissions:{modules}}
  assert.equal(hasPageAccess(user,MODULE_KEYS.PRODUCT_CENTER),product||material)
  assert.equal(hasModuleAccess(user,MODULE_KEYS.PRODUCT_CENTER),product)
  assert.equal(hasModuleAccess(user,MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT),material)
 }
})

test('物料目录与报价读取独立标准报价和折扣；错误单位/暂停客户/无报价拒绝',async()=>{
 let row={id:'old-material',name:'冰袋',category:'material',sku:'MAT-ICE',isActive:false,salePriceCents:10n,costPriceCents:10n,partnerReplenishmentEnabled:true,partnerOrderUnit:'NATIVE',unit:'包',partnerMaterialPriceCents:200n,updatedAt:new Date()}
 let partner={id:'p',status:'ACTIVE',defaultDiscountBps:6500}
 const db={partner:{findUnique:async()=>partner},inventoryItem:{findUnique:async()=>row,findMany:async()=>[row]}}
 const args={db,principal:{partnerId:'p'}}
 assert.equal((await listPartnerCatalogue(args))[0].referencePriceCents,'130')
 const result=await quotePartnerCatalogueItem({...args,body:{productId:row.id,orderUnit:'NATIVE',quantityUnits:2}})
 assert.equal(result.finalAmountCents,'260')
 await assert.rejects(()=>quotePartnerCatalogueItem({...args,body:{productId:row.id,orderUnit:'PCS',quantityPieces:2}}),/单位/)
 row={...row,partnerMaterialPriceCents:null};assert.equal(isCatalogueEligible(row),false)
 assert.deepEqual(await listPartnerCatalogue(args),[])
 row={...row,partnerMaterialPriceCents:200n};partner={...partner,status:'PAUSED'}
 await assert.rejects(()=>listPartnerCatalogue(args))
})

test('物料追加成本沿用原成本权威，历史金额保持，商品成本路由拒绝物料',async()=>{
 const previous={id:'old-cost',inventoryItemId:'m',costPriceCents:10n,effectiveFrom:new Date('2026-10-01'),effectiveTo:null}
 let item={id:'m',category:'material',costPriceCents:10n,version:1}
 const histories=[previous]
 const tx={$queryRaw:async()=>[],$executeRaw:async()=>0,inventoryItem:{findUnique:async()=>item,update:async({data})=>{item={...item,...data};return item}},inventoryItemCostHistory:{findFirst:async()=>histories.at(-1),update:async({data})=>Object.assign(previous,data),create:async({data})=>{histories.push(data);return data}}}
 const db={$transaction:async cb=>cb(tx)}
 await assert.rejects(()=>appendProductCostVersion(db,{inventoryItemId:'m',costPriceCents:'20',effectiveFrom:'2026-10-02',reason:'test'}),/不存在/)
 const created=await appendProductCostVersion(db,{category:'material',inventoryItemId:'m',costPriceCents:'20',effectiveFrom:'2026-10-02',reason:'物料新成本',createdBy:'test'})
 assert.equal(previous.costPriceCents,10n);assert.equal(created.costPriceCents,20n);assert.equal(previous.effectiveTo.toISOString().slice(0,10),'2026-10-02')
 await assert.rejects(()=>appendProductCostVersion(db,{category:'material',inventoryItemId:'m',costPriceCents:'30',effectiveFrom:'2026-10-01',reason:'backdate'}),/向后追加/)
})

test('PGlite新增报价列不修改4项商品、物料身份或历史；负报价/重复编号受约束',async()=>{
 const db=new PGlite()
 try{
  await db.exec('CREATE TABLE "InventoryItem" ("id" TEXT PRIMARY KEY,"category" TEXT NOT NULL,"sku" TEXT UNIQUE,"transferCode" TEXT UNIQUE,"image" TEXT,"salePriceCents" BIGINT,"costPriceCents" BIGINT,"isActive" BOOLEAN,"transferEnabled" BOOLEAN,"partnerReplenishmentEnabled" BOOLEAN); CREATE TABLE "TransferItem" ("id" TEXT PRIMARY KEY,"itemId" TEXT REFERENCES "InventoryItem"("id"),"itemNameSnapshot" TEXT);')
  for(const r of four)await db.query('INSERT INTO "InventoryItem" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[r.id,r.category,r.sku,r.transferCode,r.image,'10','10',false,true,true])
  await db.exec(`INSERT INTO "InventoryItem" VALUES ('m','material',NULL,NULL,'',NULL,NULL,FALSE,TRUE,FALSE); INSERT INTO "TransferItem" VALUES ('historic','m','原物料');`)
  const before=(await db.query('SELECT * FROM "InventoryItem" ORDER BY "id"')).rows
  const history=(await db.query('SELECT * FROM "TransferItem"')).rows
  await db.exec(await readFile(new URL('../prisma/migrations/20261002160000_material_replenishment_quote/migration.sql',import.meta.url),'utf8'))
  const after=(await db.query('SELECT * FROM "InventoryItem" ORDER BY "id"')).rows
  assert.deepEqual(after.map(({partnerMaterialPriceCents,...r})=>r),before)
  assert.ok(after.every(r=>r.partnerMaterialPriceCents===null))
  assert.deepEqual((await db.query('SELECT * FROM "TransferItem"')).rows,history)
  await assert.rejects(()=>db.query('UPDATE "InventoryItem" SET "partnerMaterialPriceCents"=-1 WHERE "id"=$1',['m']))
  await db.query('UPDATE "InventoryItem" SET "sku"=$1,"transferCode"=$1 WHERE "id"=$2',['MAT-STABLE','m'])
  await assert.rejects(()=>db.query('UPDATE "InventoryItem" SET "sku"=$1 WHERE "id"=$2',['MAT-STABLE','protected-0']))
 }finally{await db.close()}
})
