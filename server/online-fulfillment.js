import crypto from 'node:crypto'
import {httpError} from './pos-core.js'
import {onlineFinancialTransaction} from './online-financial-transaction.js'
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const deny=()=>{throw httpError('订单当前不可履约',409)}
// Authorize is a mandatory DB-only canonical merchant permission check; it is
// re-run on replay and inside the settlement lock. Customer ownership is NOT it.
export function createOnlineFulfillment(prisma,{authorize}={}) {
 if(typeof authorize!=='function')throw Error('ONLINE_FULFILLMENT_AUTHORITY_REQUIRED')
 return {
  async authorize(input) {
   if(!input || typeof input.requestKey!=='string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(input.requestKey)
     || !['DELIVERY','PICKUP'].includes(input.method))throw httpError('履约参数无效',400)
   const intent={method:input.method,carrierCode:input.carrierCode??null,trackingNo:input.trackingNo??null}
   if(intent.method==='PICKUP' ? intent.carrierCode!==null || intent.trackingNo!==null
    : !/^[A-Za-z0-9_-]{1,40}$/.test(intent.carrierCode||'') || !/^[A-Za-z0-9_-]{1,80}$/.test(intent.trackingNo||''))throw httpError('物流参数无效',400)
   const fingerprint=hash(intent)
   return onlineFinancialTransaction(prisma,input.settlementId,async(tx,settlement)=>{
    if(!settlement)throw httpError('订单不存在',404)
    // Advisory-lock waits can establish a Serializable snapshot before a rival
    // commits. A row lock detects that stale snapshot even though this service
    // writes only the separate authorization table; retry then reads fresh facts.
    await tx.$queryRaw`SELECT id FROM online_settlements WHERE id = ${settlement.id} FOR UPDATE`
    const authority=await authorize(tx,{settlement,actor:input.actor,input:{...input}})
    if(typeof authority?.actorId!=='string'||!authority.actorId.trim()||authority.actorId.length>160)throw httpError('无履约权限',403)
    const prior=await tx.onlineFulfillmentAuthorization.findUnique({where:{settlementId:settlement.id}})
    if(prior){
     if(prior.requestKey!==input.requestKey || prior.requestFingerprint!==fingerprint)deny()
     // Historical authorization survives later refunds; replay never creates a
     // second shipment or pretends that the current financial state is PAID.
     return {...prior,authorizedAt:prior.createdAt}
    }
    if(settlement.status!=='PAID'||!settlement.paidAt||settlement.cancelledAt
      ||settlement.refunds.length||settlement.compensations.length
      ||!settlement.tenders.length||settlement.tenders.some(t=>t.status!=='SUCCEEDED'))deny()
    const quote=await tx.onlineCheckoutQuote.findUnique({where:{id:settlement.quoteId}})
    if(quote?.snapshot.fulfillment!==intent.method)deny()
    const authorization=await tx.onlineFulfillmentAuthorization.create({data:{id:'ofa-'+hash(settlement.id),settlementId:settlement.id,
     requestKey:input.requestKey,requestFingerprint:fingerprint,...intent,actorId:authority.actorId,settlementVersion:settlement.version}})
    return {...authorization,authorizedAt:authorization.createdAt}
   })
  }
 }
}
