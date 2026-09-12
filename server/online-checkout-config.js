import fs from 'node:fs'
import path from 'node:path'
import {validateProductionGatewayConfig} from './production-cloudbase-gateway.js'

// Separate runtime switch remains ON while obligations exist, even if the
// purchase rollout is OFF. This loader never mutates configuration or secrets.
export function loadOnlineCheckoutConfig(env=process.env,io=fs) {
  if(env.SWEET_CARD_ONLINE_RUNTIME_ENABLED!=='1') {
    if(env.SWEET_CARD_ONLINE_PAYMENT_ENABLED==='1')throw Error('ONLINE_RUNTIME_REQUIRED')
    return null
  }
  const gatewayConfig=validateProductionGatewayConfig(env,io)
  if(!gatewayConfig.enabled)throw Error('ONLINE_SIGNED_GATEWAY_REQUIRED')
  function secret(name,{raw=false}={}){
    const file=env[name]
    if(typeof file!=='string'||!path.isAbsolute(file))throw Error('ONLINE_SECRET_FILE_REQUIRED')
    try{
      const st=io.statSync(file)
      if(!st.isFile() || st.uid!==0 || st.gid!==0 || ![0o400,0o440].includes(st.mode&0o777) || st.size>16384)throw Error()
      const value=String(io.readFileSync(file,'utf8')).trim()
      if(!value || (!raw && /\s/.test(value)))throw Error()
      return value
    }catch{throw Error('ONLINE_SECRET_FILE_INVALID')}
  }
  const paymentConfig={appId:gatewayConfig.appId,mchId:env.SWEET_CARD_ONLINE_WECHAT_MCH_ID,
    platformKeyId:env.SWEET_CARD_ONLINE_WECHAT_PLATFORM_KEY_ID,
    platformPublicKey:secret('SWEET_CARD_ONLINE_WECHAT_PLATFORM_PUBLIC_KEY_FILE',{raw:true}),
    apiV3Key:secret('SWEET_CARD_ONLINE_WECHAT_API_V3_KEY_FILE'),
    merchantPrivateKey:secret('SWEET_CARD_ONLINE_WECHAT_PRIVATE_KEY_FILE',{raw:true}),
    merchantSerial:env.SWEET_CARD_ONLINE_WECHAT_MERCHANT_SERIAL,
    notifyUrl:env.SWEET_CARD_ONLINE_WECHAT_NOTIFY_URL}
  const mirrorConfig={appId:gatewayConfig.appId,environment:gatewayConfig.cloudBaseEnvId,
    keyId:env.SWEET_CARD_ONLINE_MIRROR_KEY_ID,endpoint:env.SWEET_CARD_ONLINE_MIRROR_URL,
    privateKey:secret('SWEET_CARD_ONLINE_MIRROR_PRIVATE_KEY_FILE',{raw:true})}
  // Detailed cryptographic/URL validation happens when runtime is constructed,
  // before listen. Do not log the returned configuration on success or failure.
  return {gatewayConfig,paymentConfig,mirrorConfig}
}
