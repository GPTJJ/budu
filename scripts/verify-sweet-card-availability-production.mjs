import assert from 'node:assert/strict'
import { prisma } from '../server/pg.js'
import { loadDb } from '../server/store.js'
import { signToken } from '../server/auth.js'
import { availabilitySummary, hasNormalPosForStore, rejectSpoof } from '../server/sweet-card-availability.js'
import { hasModuleAccess, MODULE_KEYS } from '../shared/accountPermissions.js'
const sha = process.env.EXPECTED_RELEASE_SHA
const normalize = x => JSON.stringify(x, (_,v) => typeof v === 'bigint' ? String(v) : v)
try {
 const db = await prisma.$queryRawUnsafe('SELECT current_database() AS name')
 assert.equal(db[0].name,'budu_bj006')
 const migrations=await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
 const failed=await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')
 assert.equal(migrations[0].n,67); assert.equal(failed[0].n,0)
 const health=await (await fetch('http://127.0.0.1:3000/api/health')).json()
 assert.equal(health.ok,true); assert.equal(health.dbOk,true); assert.ok(sha?.startsWith(health.gitSha))
 const users=await prisma.user.findMany({where:{status:{not:'disabled'},role:{not:'public'}}})
 const admin=users.find(u=>u.role==='developer'), noPos=users.find(u=>!hasModuleAccess(u,MODULE_KEYS.STORE_POS))
 const summary=await availabilitySummary(prisma)
 assert.equal(summary.globalEnabled,true)
 assert.equal(summary.stores.filter(s=>s.enabled&&!s.configurable).length,0)
 const secret=process.env.JWT_SECRET||(await loadDb()).meta.secret
 const call=async(user,path,method='GET',body)=>{
  const r=await fetch('http://127.0.0.1:3000/api/v2'+path,{method,headers:{Cookie:`budu_token=${signToken(user,secret)}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  return {status:r.status,body:await r.json()}
 }
 const matrix=[]
 for(const store of summary.stores.filter(s=>s.configurable)) {
  assert.equal(store.enabled,true)
  const operator=users.find(u=>u.role==='cashier'&&hasNormalPosForStore(u,store.id))||users.find(u=>hasNormalPosForStore(u,store.id))
  assert.ok(operator)
  const config=await call(operator,`/pos/config?storeId=${encodeURIComponent(store.id)}`)
  assert.equal(config.status,200); assert.equal(config.body.sweetCard.enabled,true)
  assert.ok(config.body.channels.includes('cash'))
  assert.equal(typeof config.body.wechatPay.enabled,'boolean'); assert.equal(typeof config.body.alipay.enabled,'boolean')
  if(noPos) assert.equal((await call(noPos,`/pos/config?storeId=${store.id}`)).status,403)
  const outside=users.find(u=>hasModuleAccess(u,MODULE_KEYS.STORE_POS)&&!hasNormalPosForStore(u,store.id))
  if(outside) { const c=await call(outside,`/pos/config?storeId=${store.id}`); assert.equal(c.status,200); assert.equal(c.body.sweetCard.enabled,false) }
  const existingOrder=await prisma.order.findFirst({where:{storeId:store.id},select:{id:true}})
  assert.ok(existingOrder,'A real order is required for denial-only API probes')
  const path=`/pos/orders/${existingOrder.id}/sweet-card/redeem`
  const probe={token:'INVALID_DENIAL_PROBE',amountCents:'1',requestKey:'availability-denial-only'}
  assert.equal((await call(operator,path,'POST',{...probe,operatorId:'spoof'})).status,403)
  assert.equal((await call(operator,path,'POST',{...probe,storeId:'spoof'})).status,403)
  if(outside) assert.equal((await call(outside,path,'POST',probe)).status,403)
  if(noPos) assert.equal((await call(noPos,path,'POST',probe)).status,403)
  assert.throws(()=>rejectSpoof({operatorId:'spoof'},operator,store.id),e=>e.status===403)
  assert.throws(()=>rejectSpoof({storeId:'spoof'},operator,store.id),e=>e.status===403)
  matrix.push({...store,allow:'PASS',noPos:noPos?'403':'UNVERIFIED',otherStore:outside?'403':'UNVERIFIED',spoof:'403',cash:config.body.channels.includes('cash'),wechat:config.body.wechatPay.enabled,alipay:config.body.alipay.enabled})
 }
 const ordinary=users.find(u=>u.role==='cashier')
 assert.equal((await call(ordinary,'/sweet-cards/availability')).status,403)
 assert.equal((await call(ordinary,'/sweet-cards/availability/global','PUT',{enabled:false})).status,403)
 const reconciliation=await call(admin,'/sweet-cards/reconciliation')
 assert.equal(reconciliation.status,200); assert.equal(reconciliation.body.scope,'ALL_REAL_FACTS'); assert.equal(reconciliation.body.all.deltaCents,'0')
 for(const path of ['/sweet-cards/overview','/sweet-cards/batches','/sweet-cards/cards','/sweet-cards/rules','/sweet-cards/audit']) assert.equal((await call(admin,path)).status,200)
 const negatives=await prisma.sweetCardAccount.count({where:{balanceCents:{lt:0n}}}); assert.equal(negatives,0)
 console.log(normalize({result:'STORE_AVAILABILITY_PRODUCTION_PASS',sha,migrations:67,failed:0,matrix,global:'ENABLED',management:'SEPARATE_PASS',all:reconciliation.body.all,byPurpose:reconciliation.body.byPurpose,negativeBalances:negatives}))
} finally {await prisma.$disconnect()}
