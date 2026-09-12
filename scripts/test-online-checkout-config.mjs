import test from 'node:test'
import assert from 'node:assert/strict'
import {loadOnlineCheckoutConfig} from '../server/online-checkout-config.js'
test('runtime is absent by default and cannot enable purchases without recovery runtime',()=>{
 let reads=0;const io={readFileSync:()=>{reads++;throw Error('MUST_NOT_READ')}}
 assert.equal(loadOnlineCheckoutConfig({},io),null);assert.equal(reads,0)
 assert.throws(()=>loadOnlineCheckoutConfig({SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1'},io),/ONLINE_RUNTIME_REQUIRED/)
})
test('online runtime requires approved signed gateway; it does not silently fall back',()=>{
 assert.throws(()=>loadOnlineCheckoutConfig({SWEET_CARD_ONLINE_RUNTIME_ENABLED:'1'}),/ONLINE_SIGNED_GATEWAY_REQUIRED/)
})
test('runtime only loads tightly permissioned files and preserves purchase-off recovery configuration',()=>{
 const env={SWEET_CARD_ONLINE_RUNTIME_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ENABLED:'0',SWEET_CARD_PRODUCTION_GATEWAY_ENABLED:'1',APP_ENV:'prod',DATABASE_URL:'postgresql://synthetic@localhost/budu_bj006',
 SWEET_CARD_WECHAT_APP_ID:'wxfce0a3c4bb430023',SWEET_CARD_CLOUDBASE_ENV_ID:'budu-d6gz358ixe39faf43',JWT_SECRET:'synthetic-marker-123456789',
 SWEET_CARD_WECHAT_APP_SECRET_FILE:'/run/secrets/sweet-card/production-wechat.appsecret',SWEET_CARD_PRODUCTION_GATEWAY_SECRET_FILE:'/run/secrets/sweet-card/production-gateway-hmac.key'}
 for(const field of ['PLATFORM_PUBLIC_KEY','API_V3_KEY','PRIVATE_KEY'])env['SWEET_CARD_ONLINE_WECHAT_'+field+'_FILE']='/run/secrets/synthetic/'+field
 env.SWEET_CARD_ONLINE_MIRROR_PRIVATE_KEY_FILE='/run/secrets/synthetic/mirror'
 let mode=0o400;const io={statSync:()=>({uid:0,gid:0,mode,size:40,isFile:()=>true}),readFileSync:()=> 'synthetic-secret-'.repeat(3)}
 const cfg=loadOnlineCheckoutConfig(env,io);assert.equal(cfg.gatewayConfig.enabled,true);assert.equal(cfg.paymentConfig.appId,cfg.mirrorConfig.appId)
 mode=0o644;assert.throws(()=>loadOnlineCheckoutConfig(env,io),/unsafe|INVALID/)
})
test('merchant authority requires a distinct root-owned signing key',()=>{
 const env={SWEET_CARD_ONLINE_RUNTIME_ENABLED:'1',SWEET_CARD_ONLINE_MERCHANT_ENABLED:'1',SWEET_CARD_PRODUCTION_GATEWAY_ENABLED:'1',APP_ENV:'prod',DATABASE_URL:'postgresql://synthetic@localhost/budu_bj006',SWEET_CARD_WECHAT_APP_ID:'wxfce0a3c4bb430023',SWEET_CARD_CLOUDBASE_ENV_ID:'budu-d6gz358ixe39faf43',JWT_SECRET:'synthetic-marker-123456789',SWEET_CARD_WECHAT_APP_SECRET_FILE:'/run/secrets/sweet-card/production-wechat.appsecret',SWEET_CARD_PRODUCTION_GATEWAY_SECRET_FILE:'/run/secrets/sweet-card/production-gateway-hmac.key',SWEET_CARD_ONLINE_MERCHANT_GATEWAY_SECRET_FILE:'/run/secrets/synthetic/merchant'}
 for(const field of ['PLATFORM_PUBLIC_KEY','API_V3_KEY','PRIVATE_KEY'])env['SWEET_CARD_ONLINE_WECHAT_'+field+'_FILE']='/run/secrets/synthetic/'+field
 env.SWEET_CARD_ONLINE_MIRROR_PRIVATE_KEY_FILE='/run/secrets/synthetic/mirror'
 let separate=false;const io={statSync:()=>({uid:0,gid:0,mode:0o400,size:40,isFile:()=>true}),readFileSync:path=>separate&&path.endsWith('/merchant')?'different-merchant-key-'.repeat(3):'synthetic-secret-'.repeat(3)}
 assert.throws(()=>loadOnlineCheckoutConfig(env,io),/KEY_SEPARATION_REQUIRED/);separate=true;assert.ok(loadOnlineCheckoutConfig(env,io).merchantGatewayConfig)
})
