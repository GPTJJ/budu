// Actual Express handlers with a transactional in-memory Prisma adapter.
// Not a native PostgreSQL concurrency or production-data acceptance test.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buduBusinessDate } from '../shared/businessDate.js'
import { ALL_MODULE_KEYS } from '../shared/accountPermissions.js'
const category={id:'fixture-material-category',name:'物料',isActive:true}
const originalProducts=Array.from({length:4},(_,i)=>({id:`protected-${i}`,name:`protected product ${i}`,category:'product',sku:`PROTECTED-${i}`,transferCode:`PROTECTED-${i}`,image:`image-${i}`,productCategoryId:category.id,isActive:false,partnerReplenishmentEnabled:true,transferEnabled:true,version:1,salePriceCents:10n,costPriceCents:10n}))
let state={rows:[...structuredClone(originalProducts),{id:'original-material',category:'material',name:'原冰袋',sku:null,transferCode:null,salePriceCents:null,costPriceCents:null,transferSortOrder:1,transferEnabled:true,isActive:false,partnerReplenishmentEnabled:false,version:1,productCategoryId:null}],histories:[],transfers:[{itemId:'original-material',itemNameSnapshot:''}],purchases:[{itemId:'original-material',itemNameSnapshot:''}]}
const matches=(row,where)=>Object.entries(where||{}).every(([key,value])=>key==='OR'?value.some(q=>matches(row,q)):value&&typeof value==='object'?('not' in value?row[key]!==value.not:'in' in value?value.in.includes(row[key]):true):row[key]===value)
const costTrigger=(source,row)=>{if(row.costPriceCents!=null&&!source.histories.some(h=>h.inventoryItemId===row.id))source.histories.push({id:`fixture-db-trigger-${row.id}`,inventoryItemId:row.id,costPriceCents:row.costPriceCents,effectiveFrom:new Date(buduBusinessDate()+'T00:00:00Z'),effectiveTo:null,createdAt:new Date()})}
const client=source=>({
 productCategory:{findUnique:async({where})=>matches(category,where)?category:null},
 inventoryItem:{
  findUnique:async({where})=>structuredClone(source.rows.find(r=>matches(r,where))||null),
  findFirst:async({where})=>structuredClone(source.rows.find(r=>matches(r,where))||null),
  findMany:async({where})=>structuredClone(source.rows.filter(r=>matches(r,where))),
  create:async({data})=>{if(source.rows.some(r=>r.name===data.name||r.sku===data.sku||r.transferCode===data.transferCode))throw Object.assign(new Error('unique'),{code:'P2002'});const row={version:1,...structuredClone(data)};source.rows.push(row);costTrigger(source,row);return structuredClone(row)},
  updateMany:async({where,data})=>{const row=source.rows.find(r=>matches(r,where));if(!row)return{count:0};Object.assign(row,{...structuredClone(data),version:row.version+1});costTrigger(source,row);return{count:1}},
  update:async({where,data})=>{const row=source.rows.find(r=>matches(r,where));Object.assign(row,{...structuredClone(data),version:row.version+1});return structuredClone(row)},
 },
 transferItem:{updateMany:async({where,data})=>{source.transfers.filter(r=>matches(r,where)).forEach(r=>Object.assign(r,data));return{count:1}}},
 purchaseItem:{updateMany:async({where,data})=>{source.purchases.filter(r=>matches(r,where)).forEach(r=>Object.assign(r,data));return{count:1}}},
 inventoryItemCostHistory:{findFirst:async({where})=>source.histories.filter(r=>matches(r,where)).at(-1)||null,findMany:async({where})=>structuredClone(source.histories.filter(r=>matches(r,where))),create:async({data})=>{source.histories.push({...structuredClone(data),createdAt:new Date()});return source.histories.at(-1)},update:async({where,data})=>Object.assign(source.histories.find(r=>matches(r,where)),data)},
 $queryRaw:async()=>[], $executeRaw:async()=>0,
})
const db=client(state)
let queue=Promise.resolve()
db.$transaction=cb=>{const run=queue.then(async()=>{const draft=structuredClone(state);const result=await cb(client(draft));state=draft;Object.assign(db,client(state));return result});queue=run.catch(()=>{});return run}
globalThis.__buduPrisma=db
process.env.DATABASE_URL='postgresql://isolated@127.0.0.1:1/never_connect'
const {v2Router}=await import('../server/v2.js')

test('物料实际路由：权限、稳定ID/编号、历史引用、版本冲突、成本及独立报价保护',async()=>{
 const app=express();app.use(express.json())
 app.use((req,res,next)=>{const scope=req.get('x-scope')||'material';const role=req.get('x-role')||'manager';const modules=Object.fromEntries(ALL_MODULE_KEYS.map(k=>[k,false]));modules['product-center']=scope==='product';modules['product-material-management']=scope==='material';req.user={id:'fixture-user',role,status:'active',permissions:{modules,reportCostView:req.get('x-cost')!=='off',reportCostManage:req.get('x-cost')!=='off'}};next()})
 app.use('/api/v2',v2Router)
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve))
 const root=`http://127.0.0.1:${server.address().port}/api/v2/transfer-master-items`
 const request=async(path,method,body,headers={})=>{const r=await fetch(root+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()}}
 try{
  for(const headers of [{'x-scope':'product'},{'x-role':'staff'},{'x-role':'cashier'},{'x-role':'public'}])assert.equal((await request('/original-material','PUT',{version:1,name:'禁止改名'},headers)).status,403)
  const first=await request('/original-material','PUT',{version:1,name:'新冰袋',sortOrder:3})
  assert.equal(first.status,200);assert.equal(first.body.item.id,'original-material');assert.equal(first.body.item.category,'material')
  assert.equal(first.body.item.salePriceCents,'10');assert.equal(first.body.item.costPriceCents,'10')
  const sku=first.body.item.sku,code=first.body.item.code
  assert.ok(sku);assert.equal(sku,code);assert.equal(state.histories.length,1)
  assert.equal(state.transfers[0].itemId,'original-material');assert.equal(state.transfers[0].itemNameSnapshot,'原冰袋')
  assert.equal(state.purchases[0].itemNameSnapshot,'原冰袋')
  assert.equal((await request('/original-material','PUT',{version:1,name:'过时写入'})).status,409)
  assert.equal((await request('/original-material','PUT',{version:2,name:'新冰袋',sku:'REPLACE'})).status,409)
  assert.equal((await request('/original-material','PUT',{version:2,name:'新冰袋',costPriceCents:'20'})).status,409)
  assert.equal((await request('/original-material','PUT',{version:2,name:'新冰袋',partnerReplenishmentEnabled:true,partnerOrderUnit:'PCS'})).status,400)
  const updated=await request('/original-material','PUT',{version:2,name:'新冰袋箱',sortOrder:7,partnerReplenishmentEnabled:true,partnerOrderUnit:'NATIVE',unit:'包',partnerMaterialPriceCents:'200'})
  assert.equal(updated.status,200);assert.equal(updated.body.item.sku,sku);assert.equal(updated.body.item.code,code)
  assert.equal(updated.body.item.isActive,false);assert.equal(updated.body.item.partnerMaterialPriceCents,'200')
  assert.equal(state.histories.length,1);assert.equal(state.histories[0].costPriceCents,10n)
  const conflicting=await Promise.all([request('/original-material','PUT',{version:3,name:'并发写入A'}),request('/original-material','PUT',{version:3,name:'并发写入B'})])
  assert.deepEqual(conflicting.map(r=>r.status).sort(),[200,409])
  assert.equal(state.rows.find(r=>r.id==='original-material').sku,sku)
  assert.equal((await request('','POST',{category:'material',name:'新物料'})).status,201)
  assert.equal((await request('','POST',{category:'material',name:'新物料'})).status,409)
  const masked=await request('?category=material','GET',null,{'x-cost':'off'})
  assert.equal(masked.status,200);assert.equal(masked.body.rows[0].costPriceCents,null)
  assert.equal((await request('/original-material/cost-history','GET',null,{'x-cost':'off'})).status,403)
  assert.equal((await request('/original-material/cost-history','POST',{costPriceCents:'20',effectiveFrom:'2026-10-10',reason:'test'},{'x-cost':'off'})).status,403)
  const futureDate=new Date(Date.now()+3*86400000).toISOString().slice(0,10)
  const cost=await request('/original-material/cost-history','POST',{costPriceCents:'20',effectiveFrom:futureDate,reason:'物料新成本'})
  assert.equal(cost.status,201);assert.equal(state.histories.length,3)
  const originalHistory=state.histories.find(r=>r.inventoryItemId==='original-material')
  assert.equal(originalHistory.costPriceCents,10n)
  assert.equal(originalHistory.effectiveTo.toISOString().slice(0,10),futureDate)
  assert.deepEqual(state.rows.filter(r=>r.category==='product'),originalProducts)
 }finally{await new Promise(resolve=>server.close(resolve))}
})
