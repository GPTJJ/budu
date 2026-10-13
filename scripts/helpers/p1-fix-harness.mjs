// Strictly opt-in native harness. Never consumes DATABASE_URL or an existing application database.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'

export function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return {promise, resolve} }
export async function until(predicate, label) {
  const deadline = performance.now() + 10000
  do { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)) } while (performance.now() < deadline)
  throw new Error(`Deterministic barrier not reached: ${label}`)
}
export async function createP1Harness({ source = path.resolve(import.meta.dirname, '../..'), queryHook } = {}) {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.APP_ENV, 'test')
  const root = process.env.P1_TEST_ROOT
  const clientPath = process.env.P1_TEST_CLIENT_PATH
  const database = process.env.P1_TEST_DATABASE
  assert.ok(root && clientPath && ['p1_fixed','p1_final','p1_baseline'].includes(database), 'explicit dedicated native test target required')
  assert.equal(process.env.P1_TEST_PORT, '55439')
  const {PrismaClient} = await import(pathToFileURL(path.join(clientPath,'index.js')))
  const url = `postgresql://audit_p1@127.0.0.1:55439/${database}?connection_limit=2`
  const db = new PrismaClient({datasources:{db:{url}}})
  const second = new PrismaClient({datasources:{db:{url}}})
  const observer = new PrismaClient({datasources:{db:{url}}})
  const [identity] = await db.$queryRawUnsafe("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version, pg_backend_pid() AS pid")
  assert.equal(identity.directory, path.join(root,'work/pgdata')); assert.match(identity.version,/^16\./)
  const [other] = await second.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); assert.notEqual(other.pid, identity.pid)
  console.log(`NATIVE_POSTGRES=${identity.version} independent_backend_pids=${identity.pid},${other.pid} database=${database}`)
  await db.$executeRawUnsafe('TRUNCATE TABLE approval_requests, approval_templates, asset_files, asset_categories, orders, "InventoryItem", "User", employees RESTART IDENTITY CASCADE')
  if(database !== 'p1_baseline')await db.$executeRawUnsafe('TRUNCATE TABLE approval_request_daily_sequences')
  process.env.DATABASE_URL = url
  process.env.DATA_DIR = path.join(root,'work',database+'-compat-data')
  process.env.DATA_STORE = 'file'
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex')
  process.env.PAYMENT_MODE = 'live'
  // Real auth/module middleware uses dedicated PG users; no fake req.user middleware.
  const names = {uploader:'p1-upload',viewer:'p1-viewer',approver:'p1-approver',outsider:'p1-outsider'}
  const roles = {uploader:'staff',viewer:'developer',approver:'admin',outsider:'staff'}
  const {hashPassword,signToken} = await import(pathToFileURL(path.join(source,'server/auth.js')))
  const users = {}, cookies = {}
  for (const [key,username] of Object.entries(names)) {
    const id = 'synthetic-'+username
    const employeeId = id+'-employee'
    await db.employee.upsert({where:{id:employeeId},create:{id:employeeId,employeeNo:employeeId,name:'Synthetic '+key,currentStoreKey:'tongying'},update:{}})
    const row = await db.user.upsert({where:{id},create:{id,username,passwordHash:hashPassword('synthetic-test-only'),role:roles[key],status:'active',employeeId,storeKeys:['tongying'],permissions:{modules:{'asset-center':key!=='outsider','approval':key!=='outsider','employee-profile':key!=='outsider'}}},update:{}})
    users[key]=row;cookies[key]='budu_token='+signToken(row,process.env.JWT_SECRET)
  }
  await db.store.upsert({where:{key:'tongying'},create:{key:'tongying',name:'Synthetic Test Store',salesDataSource:'pos'},update:{}})
  await db.inventoryItem.upsert({where:{id:'p1-product'},create:{id:'p1-product',name:'Synthetic Product',sku:'P1-SYNTHETIC',unit:'份',salePriceCents:10000n,costPriceCents:100n,isActive:true},update:{}})
  for(const key of ['p1-expense','p1-other']) await db.approvalTemplate.upsert({where:{key},create:{key,name:key,schema:[{key:'amount',label:'金额',type:'money',required:true,amount:true}],approverRule:{type:'role',role:'admin'},ccRule:[]},update:{}})
  await db.assetCategory.upsert({where:{key:'p1-category'},create:{key:'p1-category',name:'Synthetic Category'},update:{}})
  const injected=queryHook?db.$extends({query:{$allModels:{$allOperations:async context=>queryHook(context)}}}):db
  globalThis.__buduPrisma=injected
  const {createApp}=await import(pathToFileURL(path.join(source,'server/app.js')))
  const app=createApp({disableStartupTasks:true})
  const runtime=app.locals.buduRuntime
  assert.equal(app.locals.c11StartupTasks,'DISABLED');assert.equal(runtime.appTasksStarted,0)
  const server=app.listen(58319,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j)})
  const origin='http://127.0.0.1:58319'
  async function api(route,{actor='viewer',method='GET',body,raw=false}={}) {
    const response=await fetch(origin+'/api'+route,{method,headers:{Cookie:cookies[actor],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)})
    if(raw)return response
    return {status:response.status,body:await response.json()}
  }
  let sequence=0
  async function order() {
    const id='p1-order-'+database+'-'+(++sequence)+'-'+crypto.randomUUID().slice(0,8)
    return db.order.create({data:{id,orderNo:id,storeId:'tongying',cashierId:users.viewer.id,cashierNameSnapshot:'Synthetic',subtotal:10000n,payableAmount:10000n,businessDate:new Date('2026-10-13T00:00:00Z'),status:'pending_payment',paymentStatus:'unpaid',checkoutKey:id,cartHash:id,items:{create:{id:id+'-item',productId:'p1-product',productNameSnapshot:'Synthetic Product',skuSnapshot:'P1-SYNTHETIC',unitSnapshot:'份',unitPrice:10000n,costPriceSnapshot:100n,quantity:1,lineAmount:10000n,actualAmount:10000n}}}})
  }
  async function createApproval({submit=true,amount='100',templateKey='p1-expense',attachmentIds=[]}={}) {
    return api('/v2/approvals/requests',{actor:'uploader',method:'POST',body:{templateKey,title:'Synthetic approval',submit,formData:{amount},attachmentIds}})
  }
  return {root,source,db,second,observer,users,cookies,origin,api,order,createApproval,require:createRequire(path.join(source,'package.json')),
    close:async()=>{await new Promise(r=>server.close(r));await Promise.all([db.$disconnect(),second.$disconnect(),observer.$disconnect()]);delete globalThis.__buduPrisma}}
}
export function syntheticPdf({pages=1,script=''}={}) {
  assert.ok(Number.isInteger(pages)&&pages>=1&&pages<=2)
  const actionId=4+pages*2
  const objects=[`<< /Type /Catalog /Pages 2 0 R ${script?'/OpenAction '+actionId+' 0 R':''} >>`,`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>(4+i*2)+' 0 R').join(' ')}] /Count ${pages} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(let i=0;i<pages;i++){
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`)
    const stream=`BT /F1 18 Tf 20 60 Td (SYNTHETIC PDF ${i+1}) Tj ET`;objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  if(script)objects.push('<< /Type /Action /S /JavaScript /JS ('+script.replace(/[\\()]/g,'\\$&')+') >>')
  let pdf='%PDF-1.4\n',offsets=[0]
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}
