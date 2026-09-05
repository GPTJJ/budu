// One-time release configuration, not a runtime store allowlist.
// Evidence: user explicitly confirmed all four named Store keys are DIRECT.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import { changeAvailability } from '../server/sweet-card-availability.js'
const mode=process.argv[2]
if(!['initialize','expand'].includes(mode)) throw Error('EXPLICIT_RELEASE_CONFIGURATION_MODE_REQUIRED')
try {
 const db=await prisma.$queryRawUnsafe('SELECT current_database() AS name')
 assert.ok(['budu_bj006','budu_sc_availability_isolated'].includes(db[0].name))
 await prisma.$transaction(async tx=>{
  const actor=await tx.user.findFirst({where:{role:'developer',status:'active'},orderBy:{createdAt:'asc'}})
  assert.ok(actor)
  if(mode==='initialize') {
   const evidenceKeys=['tongying','chaowai','guanshe','xidan']
   const stores=await tx.store.findMany({where:{key:{in:evidenceKeys}},include:{sweetCardPolicy:true}})
   assert.equal(stores.length,4)
   for(const store of stores) {
    assert.equal(store.active,true); assert.equal(store.sweetCardPolicy?.eligible,true)
    assert.ok(['UNKNOWN','DIRECT'].includes(store.operationType))
    await tx.store.update({where:{key:store.key},data:{operationType:'DIRECT'}})
    await tx.sweetCardAuditLog.create({data:{id:`sca-${crypto.randomUUID()}`,action:'SWEET_CARD_STORE_BUSINESS_CLASSIFIED',actorId:actor.id,actorName:actor.username,metadata:{storeId:store.key,previousValue:store.operationType,newValue:'DIRECT',evidence:'USER_CONFIRMATION_2026_09_05_ALL_FOUR_DIRECT',release:process.env.RELEASE_SHA}}})
   }
   const old=await tx.sweetCardControl.findUnique({where:{id:'GLOBAL'}})
   assert.equal(old,null,'INITIALIZATION_MUST_NOT_OVERWRITE_EXISTING_GLOBAL_CONTROL')
   await tx.sweetCardControl.create({data:{id:'GLOBAL',enabled:true,updatedById:actor.id}})
   await tx.sweetCardAuditLog.create({data:{id:`sca-${crypto.randomUUID()}`,action:'SWEET_CARD_GLOBAL_ENABLED',actorId:actor.id,actorName:actor.username,metadata:{previousValue:null,newValue:true,reason:'PRESERVE_EXISTING_PRODUCTION_ENABLED_FLAGS',release:process.env.RELEASE_SHA}}})
  } else {
   const changes=await changeAvailability(tx,actor,{allDirect:true,enabled:true})
   console.log(JSON.stringify({expansion:'ACTIVE_DIRECT_ONLY',changes}))
  }
 },{isolationLevel:'Serializable',timeout:15000})
 console.log(`STORE_AUTHORITY_${mode.toUpperCase()}_PASS`)
} finally {await prisma.$disconnect()}
