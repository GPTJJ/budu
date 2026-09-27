// Read-only by default. --halt-on-p0 is explicitly authorized by Store Availability 1.0.
import crypto from 'node:crypto'
import { prisma } from '../server/pg.js'
import { availabilitySummary } from '../server/sweet-card-availability.js'
const halt = process.argv.includes('--halt-on-p0')
try {
 const db=await prisma.$queryRawUnsafe('SELECT current_database() AS name')
 if(db[0].name!=='budu_bj006') throw Error('PRODUCTION_DATABASE_IDENTITY_REQUIRED')
 const result=await prisma.$transaction(async tx=>{
  const [accounts,ledger,redemptions,refunds,audits,summary]=await Promise.all([
   tx.sweetCardAccount.findMany({select:{id:true,balanceCents:true}}),
   tx.sweetCardLedger.findMany({select:{accountId:true,type:true,amountCents:true,redemptionId:true,refundId:true,requestKey:true}}),
   tx.sweetCardRedemption.findMany({select:{id:true,requestKey:true,orderId:true,redeemedById:true,storeIdSnapshot:true,amountCents:true}}),
   tx.refund.count({where:{status:'failed',sweetCardRefundAmount:{gt:0n}}}),
   tx.sweetCardAuditLog.findMany({where:{action:'sweet_card.redeemed'},select:{actorId:true,metadata:true}}),availabilitySummary(tx)])
  const sum=rows=>rows.reduce((n,v)=>n+v.amountCents,0n)
  const balance=accounts.reduce((n,a)=>n+a.balanceCents,0n), total=sum(ledger)
  const perAccount=new Map(); for(const l of ledger) perAccount.set(l.accountId,(perAccount.get(l.accountId)||0n)+l.amountCents)
  const accountDeltas=accounts.filter(a=>(perAccount.get(a.id)||0n)!==a.balanceCents).length
  const dup=(rows,key)=>rows.length-new Set(rows.map(key)).size
  const duplicateEconomicEffect=dup(ledger,l=>l.requestKey)+dup(redemptions,r=>r.requestKey)+dup(redemptions,r=>r.orderId)
  const snapshots=audits.filter(a=>a.metadata?.authorization?.authority==='STORE_AVAILABILITY_1_0')
  const unauthorizedSuccess=snapshots.filter(a=>{
   const x=a.metadata.authorization, r=redemptions.find(r=>r.orderId===a.metadata.orderId)
   return !r||r.redeemedById!==a.actorId||r.storeIdSnapshot!==a.metadata.storeId||!x.enabled||!x.globalEnabled||!x.businessAllowed||!x.storeEnabled||!x.operatorAllowed
  }).length
  const negativeBalance=accounts.filter(a=>a.balanceCents<0n).length
  const p0=negativeBalance>0||duplicateEconomicEffect>0||unauthorizedSuccess>0||total!==balance||accountDeltas>0
  if(p0&&halt) {
   const old=await tx.sweetCardControl.findUnique({where:{id:'GLOBAL'}})
   await tx.sweetCardControl.upsert({where:{id:'GLOBAL'},create:{id:'GLOBAL',enabled:false,updatedById:'store-availability-monitor'},update:{enabled:false,updatedById:'store-availability-monitor'}})
   await tx.sweetCardAuditLog.create({data:{id:`sca-${crypto.randomUUID()}`,action:'SWEET_CARD_GLOBAL_DISABLED',actorId:'store-availability-monitor',metadata:{previousValue:old?.enabled===true,newValue:false,reason:'P0_REDLINE',negativeBalance,duplicateEconomicEffect,unauthorizedSuccess,deltaCents:String(total-balance),accountDeltas}}})
  }
  return {p0,halted:p0&&halt,enabledStores:summary.stores.filter(s=>s.enabled).map(s=>s.id),negativeBalance,duplicateEconomicEffect,unauthorizedSuccess,authorizationSnapshots:snapshots.length,legacyRedemptions:redemptions.length-snapshots.length,accountDeltas,ledgerCents:String(total),balanceCents:String(balance),deltaCents:String(total-balance),failedSweetCardRefunds:refunds}
 },{isolationLevel:'RepeatableRead',timeout:15000})
 console.log(JSON.stringify(result)); if(result.p0) process.exitCode=2
} finally {await prisma.$disconnect()}
