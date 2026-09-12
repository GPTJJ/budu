import express from 'express'
import {createOnlineCheckoutRouter,createOnlineWechatNotifyRouter} from './online-checkout-api.js'
import {createOnlinePaymentService} from './online-payment-service.js'
import {createOnlinePaymentRecovery,startOnlinePaymentRecovery} from './online-payment-recovery.js'
import {createOnlineMirrorTransport} from './online-mirror-transport.js'
import {deliverOnlineOutboxOnce} from './online-outbox.js'

// Composition has no side effects until explicitly mounted/started. Purchase
// rollout and recovery are separate: disabling purchases cannot abandon holds.
export function createOnlineCheckoutRuntime({db,gatewayConfig,paymentConfig,mirrorConfig,env=process.env,request,fetchImpl}) {
  if(!gatewayConfig?.enabled || gatewayConfig.mode!=='production'
    || gatewayConfig.appId!==paymentConfig?.appId || gatewayConfig.appId!==mirrorConfig?.appId
    || gatewayConfig.cloudBaseEnvId!==mirrorConfig.environment)throw Error('ONLINE_RUNTIME_SCOPE_INVALID')
  const payment=createOnlinePaymentService(db,paymentConfig,{env,...(request?{request}:{})})
  const notify=createOnlineWechatNotifyRouter({db,configuration:paymentConfig})
  const customer=createOnlineCheckoutRouter({db,gatewayConfig,paymentService:payment,wechat:paymentConfig,env})
  const deliver=createOnlineMirrorTransport(mirrorConfig,fetchImpl?{fetchImpl}:{})
  const recovery=createOnlinePaymentRecovery(db,payment)
  let workers=null,mounted=false
  return {
    mount(app) {
      if(mounted)throw Error('ONLINE_RUNTIME_ALREADY_MOUNTED')
      mounted=true
      // Must precede the host's general JSON parser and employee auth routes.
      app.use('/api/online-checkout/wechat',notify)
      app.use('/api/v2/customer/online-checkout',express.json({limit:'256kb'}),customer)
      app.use(['/api/online-checkout/wechat','/api/v2/customer/online-checkout'],(error,req,res,next)=>{
        res.status(error?.type==='entity.too.large'?413:400).json({ok:false,error:'ONLINE_REQUEST_INVALID'})
      })
    },
    async tick() {
      // Exposed for controlled one-shot operational recovery and isolated tests.
      // No caller money/state and no switch required to finish existing facts.
      return {payment:await recovery.tick(),mirror:await deliverOnlineOutboxOnce(db,deliver)}
    },
    start() {
      if(workers)return
      workers=[startOnlinePaymentRecovery(recovery),startOnlinePaymentRecovery({tick:()=>deliverOnlineOutboxOnce(db,deliver)},{intervalMs:1000})]
    },
    async stop() {const active=workers;workers=null;if(active)await Promise.all(active.map(worker=>worker.stop()))},
  }
}
