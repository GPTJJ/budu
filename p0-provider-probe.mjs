// P0 READ-ONLY provider probe.
// Queries WeChat Pay for the ORIGINAL merchant trade number using the
// container's own runtime configuration. No database write, no state change at
// the provider, and no secret value is printed.
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlineWechatTransport } from '/app/server/online-wechat-transport.js'
import { createOnlineWechatEvidence } from '/app/server/online-wechat-evidence.js'

const NO = process.argv[2] || 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'

let cfg
try { cfg = loadOnlineCheckoutConfig() } catch (e) { console.log('CONFIG_LOAD_FAILED:', e.message); process.exit(2) }
if (!cfg) { console.log('CONFIG_NULL (runtime disabled)'); process.exit(2) }
const pc = cfg.paymentConfig
console.log('appId_present:', /^wx[A-Za-z0-9]{16}$/.test(pc.appId || ''))
console.log('mchId_present:', /^\d{8,16}$/.test(pc.mchId || ''))
console.log('merchantSerial_present:', !!pc.merchantSerial)
console.log('apiV3Key_len_ok:', Buffer.from(pc.apiV3Key || '', 'utf8').length === 32)
console.log('privateKey_pem:', /BEGIN (RSA )?PRIVATE KEY/.test(pc.merchantPrivateKey || ''))
console.log('platformKey_pem:', /BEGIN PUBLIC KEY/.test(pc.platformPublicKey || ''))
console.log('platformKeyId_present:', !!pc.platformKeyId)
console.log('notifyUrl:', pc.notifyUrl)
console.log('---')

let request, verify
try { request = createOnlineWechatTransport(pc) } catch (e) { console.log('TRANSPORT_INIT_FAILED:', e.code || e.message); process.exit(3) }
try { verify = createOnlineWechatEvidence(pc) } catch (e) { console.log('EVIDENCE_INIT_FAILED:', e.message); process.exit(3) }
console.log('transport_init: OK')

const path = `/v3/pay/transactions/out-trade-no/${NO}?mchid=${pc.mchId}`
let reply
try { reply = await request('GET', path) } catch (e) {
  console.log('PROVIDER_REQUEST_FAILED:', e.code || e.message)
  process.exit(4)
}
console.log('httpStatus:', reply.statusCode)
const body = reply.rawBody ? reply.rawBody.toString('utf8') : ''
console.log('bodyBytes:', body.length)

if (reply.statusCode === 404) {
  try { const j = JSON.parse(body); console.log('provider_code:', j.code, '| message:', j.message) } catch { console.log('body_unparsed:', body.slice(0, 200)) }
  process.exit(0)
}

try {
  const fact = verify({ ...reply, source: 'QUERY' })
  console.log('SIGNATURE: VERIFIED')
  console.log('TRADE_STATE:', fact.state)
  console.log('amountCents:', String(fact.amountCents), '| currency:', fact.currency)
  console.log('hasTransactionId:', !!fact.transactionId)
} catch (e) {
  console.log('SIGNATURE_OR_PAYLOAD_REJECTED:', e.status || '', e.message)
  console.log('body_head:', body.slice(0, 300))
}
