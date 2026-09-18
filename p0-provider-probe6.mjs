// P0 READ-ONLY: dump the exact provider payload that fails verification.
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlineWechatTransport } from '/app/server/online-wechat-transport.js'
import { createOnlineWechatEvidence } from '/app/server/online-wechat-evidence.js'

const NO = process.argv[2] || 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'
const cfg = loadOnlineCheckoutConfig()
const pc = cfg.paymentConfig
const request = createOnlineWechatTransport(pc)
const verify = createOnlineWechatEvidence(pc)

const reply = await request('GET', `/v3/pay/transactions/out-trade-no/${NO}?mchid=${pc.mchId}`)
const raw = reply.rawBody.toString('utf8')
console.log('http_status:', reply.statusCode)
console.log('raw_body:', raw)
console.log()
const r = JSON.parse(raw)
console.log('keys:', Object.keys(r).sort().join(','))
console.log()
const states = ['SUCCESS', 'NOTPAY', 'USERPAYING', 'CLOSED', 'REVOKED', 'PAYERROR']
const bounded = (x, m) => typeof x === 'string' && x.length > 0 && x.length <= m
const src = 'QUERY'
const tradeTypeOk = src === 'NOTIFY' ? r.trade_type === 'JSAPI' : (r.trade_type == null || r.trade_type === 'JSAPI')
const checks = {
  'result truthy': !!r,
  'appid match': r.appid === pc.appId,
  'mchid match': r.mchid === pc.mchId,
  'tradeTypeOk (patched)': tradeTypeOk,
  'out_trade_no bounded': bounded(r.out_trade_no, 32),
  'trade_state allowlisted': states.includes(r.trade_state),
  'amount.total safe int': Number.isSafeInteger(r.amount?.total),
  'amount.total range': r.amount?.total > 0 && r.amount?.total <= 2000000000,
  'currency CNY': r.amount?.currency === 'CNY',
}
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`)
console.log()
console.log('FAILED:', Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(' | ') || '(none)')
console.log()
try { const f = verify({ ...reply, source: 'QUERY' }); console.log('REAL verifyPayment: PASS', f.state) }
catch (e) { console.log('REAL verifyPayment: FAIL', e.status, e.message) }
