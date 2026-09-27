// P0 READ-ONLY: pinpoint which verification step throws 401 inside the real
// service construction path.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { loadOnlineCheckoutConfig } from '/app/server/online-checkout-config.js'
import { createOnlineWechatTransport } from '/app/server/online-wechat-transport.js'
import { createOnlineWechatMessageVerifier, createOnlineWechatEvidence } from '/app/server/online-wechat-evidence.js'

const file = '/app/server/online-wechat-evidence.js'
console.log('evidence_file_sha256:', crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
console.log('has_tradeTypeOk_patch:', fs.readFileSync(file, 'utf8').includes('tradeTypeOk'))

const NO = process.argv[2] || 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'
const cfg = loadOnlineCheckoutConfig()
const pc = cfg.paymentConfig
const request = createOnlineWechatTransport(pc)
const verifyMessage = createOnlineWechatMessageVerifier(pc)
const verifyPayment = createOnlineWechatEvidence(pc)

const reply = await request('GET', `/v3/pay/transactions/out-trade-no/${NO}?mchid=${pc.mchId}`)
console.log('http_status:', reply.statusCode)
console.log('raw_bytes:', reply.rawBody.length)

try { verifyMessage(reply); console.log('STEP verifyMessage : PASS') }
catch (e) { console.log('STEP verifyMessage : FAIL', e.status, e.message) }

try { const f = verifyPayment({ ...reply, source: 'QUERY' }); console.log('STEP verifyPayment : PASS ->', f.state) }
catch (e) { console.log('STEP verifyPayment : FAIL', e.status, e.message) }
