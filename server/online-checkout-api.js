import crypto from 'node:crypto'
import express from 'express'
import { authenticateCustomerSession, bearerToken } from './customer-auth.js'
import { verifyProductionGatewayRequest } from './production-cloudbase-gateway.js'
import { createOnlineCheckout } from './online-checkout.js'
import { createOnlinePaymentFinalizer } from './online-payment-finalizer.js'
import { httpError } from './pos-core.js'

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
export function onlineQuotePresentation(quote) {
  const q=quote.snapshot
  return {quoteId:quote.id,userId:quote.userId,version:q.version,expiresAt:quote.expiresAt.toISOString(),
    currency:q.currency,items:q.lines,merchandiseCents:q.merchandiseCents,eligibleMerchandiseCents:q.eligibleMerchandiseCents,
    shippingCents:q.shippingCents,availableSweetCardCents:q.availableSweetCardCents,requestedSweetCardCents:q.requestedSweetCardCents,
    sweetCardCents:q.sweetCardCents,wechatCents:q.wechatCents,totalCents:q.totalCents,commerceRef:q.commerceRef}
}

// Candidate router, not mounted by production startup. Gateway signature alone
// is not customer authority: session AND runtime WeChat identity must agree.
export function createOnlineCheckoutRouter({db,gatewayConfig,paymentService,wechat,env=process.env}) {
  const router=express.Router()
  async function fulfillment(tx,intent){
    if(intent.fulfillment==='PICKUP'){
      const store=typeof intent.storeRef==='string' && await tx.store.findUnique({where:{key:intent.storeRef}})
      if(!store?.active)throw httpError('自提门店暂不可用',409)
    }
  }
  const service=catalog=>createOnlineCheckout(db,{wechat,env,validateFulfillment:fulfillment,resolveCatalog:async()=>catalog})
  const handle=fn=>async(req,res)=>{
    res.setHeader('Cache-Control','no-store')
    try{
      verifyProductionGatewayRequest(req,gatewayConfig)
      const token=bearerToken(req.get('authorization'))
      if(req.body?.sessionHash!==hash(token))throw httpError('登录身份核对失败',401)
      const customer=await authenticateCustomerSession({rawToken:token,markerKey:gatewayConfig.markerKey,db})
      if(typeof req.body.openId!=='string' || !req.body.openId || req.body.openId.length>128)throw httpError('微信身份核对失败',401)
      const identity=await db.weChatAuthIdentity.findUnique({where:{provider_appId_openId:{provider:'WECHAT_MINIPROGRAM',appId:gatewayConfig.appId,openId:req.body.openId}}})
      if(identity?.userId!==customer.userId)throw httpError('微信身份核对失败',403)
      return res.json({ok:true,result:await fn(req.body,customer)})
    }catch(error){
      const status=Number(error?.status)
      return res.status([400,401,403,404,409,429].includes(status)?status:503).json({ok:false,error:'ONLINE_CHECKOUT_REQUEST_FAILED'})
    }
  }
  router.post('/quote',handle(async(body,customer)=>{
    const c=body.catalog,i=body.intent
    if(!c || typeof c.commerceRef!=='string' || !/^ocd-[0-9a-f]{64}$/.test(c.commerceRef)
      || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt)<=Date.now()
      || Date.parse(c.expiresAt)>Date.now()+15*60000+5000
      || (i?.fulfillment==='DELIVERY' && i.addressRef!==c.commerceRef))throw httpError('商品报价无效',400)
    return onlineQuotePresentation(await service(c).quote(customer.userId,i))
  }))
  router.post('/submit',handle(async(body,customer)=>{
    const s=await service(null).submit(customer.userId,{quoteId:body.quoteId,requestKey:body.requestKey})
    return {settlementId:s.id,status:s.status,totalCents:String(s.totalCents),sweetCardCents:String(s.sweetCardCents),wechatCents:String(s.wechatCents)}
  }))
  router.post('/plan-order',handle(async(body,customer)=>{
    const plan=await service(null).plan(customer.userId,{quoteId:body.quoteId,requestKey:body.requestKey})
    return {...plan,quote:onlineQuotePresentation(plan.quote)}
  }))
  async function owned(body,customer){
    if(typeof body.settlementId!=='string' || body.settlementId.length>160)throw httpError('订单无效',400)
    const s=await db.onlineSettlement.findUnique({where:{id:body.settlementId}})
    if(!s || s.userId!==customer.userId)throw httpError('订单不存在',404)
    return s
  }
  for(const action of ['prepare','cancel','status'])router.post('/'+action,handle(async(body,customer)=>{
    const s=await owned(body,customer)
    if(!paymentService)throw httpError('支付服务暂不可用',503)
    if(action==='status')return paymentService.recover(s.id)
    return paymentService[action](s.id,customer.userId)
  }))
  return router
}

// Mount BEFORE JSON parsing. Only provider-signed raw bytes can settle payment;
// the customer API deliberately has no client-success/finalize operation.
export function createOnlineWechatNotifyRouter({db,configuration}) {
  const router=express.Router(),finalize=createOnlinePaymentFinalizer(db,configuration)
  router.post('/notify',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    res.setHeader('Cache-Control','no-store')
    try {
      if(!Buffer.isBuffer(req.body))throw httpError('回调格式无效',400)
      await finalize({source:'NOTIFY',rawBody:req.body,headers:req.headers})
      return res.status(204).end()
    } catch(error) {
      const status=Number(error?.status)
      return res.status([400,401,403,404,409].includes(status)?status:503)
        .json({code:'FAIL',message:'PAYMENT_NOTIFICATION_NOT_ACCEPTED'})
    }
  })
  return router
}
