// P0 READ-ONLY: replicate verifyPayment()'s payload predicates field by field.
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlineWechatTransport } from '/app/server/online-wechat-transport.js'

const NO = process.argv[2] || 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'
const cfg = loadOnlineCheckoutConfig()
const pc = cfg.paymentConfig
const request = createOnlineWechatTransport(pc)
const reply = await request('GET', `/v3/pay/transactions/out-trade-no/${NO}?mchid=${pc.mchId}`)
const raw = reply.rawBody.toString('utf8')
const result = JSON.parse(raw)

console.log('=== raw provider payload keys ===')
console.log(Object.keys(result).sort().join(', '))
console.log()
console.log('=== values relevant to verifyPayment() ===')
console.log('trade_state          :', JSON.stringify(result.trade_state))
console.log('trade_type           :', JSON.stringify(result.trade_type))
console.log('appid                :', JSON.stringify(result.appid))
console.log('mchid                :', JSON.stringify(result.mchid))
console.log('out_trade_no         :', JSON.stringify(result.out_trade_no))
console.log('amount.total         :', JSON.stringify(result.amount?.total))
console.log('amount.currency      :', JSON.stringify(result.amount?.currency))
console.log()
console.log('=== predicate evaluation (from online-wechat-evidence.js) ===')
const bounded = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max
const states = ['SUCCESS', 'NOTPAY', 'USERPAYING', 'CLOSED', 'REVOKED', 'PAYERROR']
const checks = {
  'appid === configured appId': result.appid === pc.appId,
  'mchid === configured mchId': result.mchid === pc.mchId,
  "trade_type === 'JSAPI'": result.trade_type === 'JSAPI',
  'out_trade_no bounded<=32': bounded(result.out_trade_no, 32),
  'trade_state in allowlist': states.includes(result.trade_state),
  'amount.total isSafeInteger': Number.isSafeInteger(result.amount?.total),
  'amount.total in (0,2e9]': result.amount?.total > 0 && result.amount?.total <= 2000000000,
  "amount.currency === 'CNY'": result.amount?.currency === 'CNY',
}
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`)
console.log()
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
console.log('FAILED_PREDICATES:', failed.length ? failed.join(' | ') : '(none)')
