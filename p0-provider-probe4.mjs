// P0 READ-ONLY: call the REAL verifyPayment from the patched module.
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlineWechatTransport } from '/app/server/online-wechat-transport.js'
import { createOnlineWechatEvidence } from '/app/server/online-wechat-evidence.js'

const NO = process.argv[2] || 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'
const cfg = loadOnlineCheckoutConfig()
const pc = cfg.paymentConfig
const request = createOnlineWechatTransport(pc)
const verify = createOnlineWechatEvidence(pc)

const reply = await request('GET', `/v3/pay/transactions/out-trade-no/${NO}?mchid=${pc.mchId}`)
console.log('httpStatus:', reply.statusCode)
try {
  const fact = verify({ ...reply, source: 'QUERY' })
  console.log('LIVE_VERIFY: PASS')
  console.log('state:', fact.state)
  console.log('amountCents:', String(fact.amountCents))
  console.log('currency:', fact.currency)
  console.log('merchantTradeNo:', fact.merchantTradeNo)
  console.log('hasTransactionId:', !!fact.transactionId)
} catch (e) {
  console.log('LIVE_VERIFY: FAIL', e.status || '', e.message)
}
