// 微信付款码支付端到端测试（真实栈形状：PaymentService + WechatPayProvider +
// WechatV2Client；仅伪造 NETWORK TRANSPORT，返回真实签名的微信 V2 XML）
//
// 覆盖：XML 解析（含 CDATA）、响应签名验证、字段交叉校验、Provider 规范化、
//       PaymentService 状态机、订单状态转换。
// 不连接真实微信；不伪造 Provider 结果对象。
import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentService } from '../server/payments/payment-service.js'
import { WechatPayProvider } from '../server/payments/providers/wechat-pay.js'
import { WechatV2Client } from '../server/payments/wechat-v2-client.js'
import { buildV2Xml, parseV2Xml, signV2Params } from '../server/payments/wechat-v2-signature.js'
import { MemoryPrisma } from './helpers/memory-prisma.mjs'

const MCH_ID = '1900000109'
const APP_ID = 'wx8888888888888888'
const API_V2_KEY = '0123456789abcdef0123456789abcdef'

const CONFIG = {
  enabled: true,
  protocol: 'v2_micropay',
  configured: true,
  mchId: MCH_ID,
  appId: APP_ID,
  terminalIp: '203.0.113.10',
  enabledStores: ['store-1'],
  apiV2Key: API_V2_KEY,
  certPem: 'cert',
  keyPem: 'key',
  reason: '',
}

/**
 * 假网络传输：解析请求 XML → 按微信 V2 规则签名构造响应 XML（CDATA 风格）。
 * 模拟微信服务器行为，仅替换网络层。
 */
function makeTransport(responder) {
  return async function transport(path, xmlBody, useMtls, host) {
    const request = parseV2Xml(xmlBody)
    const fields = responder(path, request)
    const signed = { ...fields, mch_id: MCH_ID, appid: APP_ID, sign_type: 'HMAC-SHA256' }
    signed.sign = signV2Params(signed, API_V2_KEY, 'HMAC-SHA256')
    return buildV2Xml(signed)
  }
}

const cdata = (value) => `<![CDATA[${value}]]>`

function buildService(transport) {
  const client = new WechatV2Client({ mchId: MCH_ID, appId: APP_ID, apiV2Key: API_V2_KEY, certPem: 'cert', keyPem: 'key', transport })
  const provider = new WechatPayProvider({ config: CONFIG, clientFactory: () => client })
  const db = new MemoryPrisma()
  const service = new PaymentService(db, new Map([['wechat_pay', provider], ['cash', provider]]))
  return { service, db }
}

async function withLiveMode(fn) {
  const previous = process.env.PAYMENT_MODE
  process.env.PAYMENT_MODE = 'live'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_MODE
    else process.env.PAYMENT_MODE = previous
  }
}

const AUTH_CODE = '130123456789012345'

test('E2E：MICROPAY 即时 SUCCESS → 支付 success、订单 completed（真实 XML 传输）', async () => {
  const transport = makeTransport((path, req) => {
    assert.equal(path, '/pay/micropay')
    assert.equal(req.total_fee, '7200')
    assert.equal(req.auth_code, AUTH_CODE)
    return { return_code: 'SUCCESS', result_code: 'SUCCESS', transaction_id: 'WX-E2E-1', out_trade_no: req.out_trade_no, total_fee: req.total_fee }
  })
  const { service } = buildService(transport)
  await withLiveMode(async () => {
    const result = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-1', authCode: AUTH_CODE })
    assert.equal(result.payment.status, 'success')
    assert.equal(result.payment.providerTradeNo, 'WX-E2E-1')
    assert.equal(result.order.status, 'completed')
    assert.equal(result.order.paymentStatus, 'paid')
  })
})

test('E2E：MICROPAY USERPAYING → orderquery SUCCESS → 恢复完成', async () => {
  let calls = 0
  const transport = makeTransport((path, req) => {
    calls += 1
    if (path === '/pay/micropay') {
      return { return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'USERPAYING', err_code_des: '支付中' }
    }
    if (path === '/pay/orderquery') {
      return { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', transaction_id: 'WX-E2E-2', out_trade_no: req.out_trade_no, total_fee: req.total_fee }
    }
    throw new Error(`unexpected path ${path}`)
  })
  const { service } = buildService(transport)
  await withLiveMode(async () => {
    const created = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-2', authCode: AUTH_CODE })
    assert.equal(created.payment.status, 'pending')
    assert.equal(created.payment.reconciliationRequired, true)
    assert.equal(created.order.status, 'pending_payment')
    const queried = await service.queryPayment(created.payment.id)
    assert.equal(queried.payment.status, 'success')
    assert.equal(queried.order.status, 'completed')
    assert.ok(calls >= 2)
  })
})

test('E2E：网络/系统歧义结果 → 由 orderquery 恢复为 SUCCESS', async () => {
  let calls = 0
  const transport = makeTransport((path, req) => {
    calls += 1
    if (path === '/pay/micropay') {
      const error = new Error('NETWORK_ERROR')
      error.code = 'NETWORK_ERROR'
      error.retryable = true
      error.ambiguous = true
      throw error
    }
    if (path === '/pay/orderquery') {
      return { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', transaction_id: 'WX-E2E-3', out_trade_no: req.out_trade_no, total_fee: req.total_fee }
    }
    throw new Error(`unexpected path ${path}`)
  })
  const { service } = buildService(transport)
  await withLiveMode(async () => {
    const created = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-3', authCode: AUTH_CODE })
    assert.equal(created.payment.status, 'pending')
    assert.equal(created.payment.reconciliationRequired, true)
    const queried = await service.queryPayment(created.payment.id)
    assert.equal(queried.payment.status, 'success')
    assert.equal(queried.order.status, 'completed')
  })
})

test('E2E：reverse 终态（recall=N + CLOSED）→ 支付 closed、订单可重新支付', async () => {
  const transport = makeTransport((path, req) => {
    if (path === '/pay/micropay') {
      return { return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'USERPAYING', err_code_des: '支付中' }
    }
    if (path === '/pay/orderquery') {
      return { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', out_trade_no: req.out_trade_no, total_fee: req.total_fee }
    }
    if (path === '/secapi/pay/reverse') {
      return { return_code: 'SUCCESS', result_code: 'SUCCESS', recall: 'N', out_trade_no: req.out_trade_no }
    }
    throw new Error(`unexpected path ${path}`)
  })
  const { service } = buildService(transport)
  await withLiveMode(async () => {
    const created = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-4', authCode: AUTH_CODE })
    const closed = await service.closePayment(created.payment.id)
    assert.equal(closed.payment.status, 'closed')
    assert.equal(closed.order.paymentStatus, 'unpaid')
  })
})

test('E2E：签名错误响应 → 拒绝完成订单（pending + 人工核对）', async () => {
  const transport = async (path, xmlBody) => {
    // 返回伪造签名（错误 key）的 SUCCESS 响应
    const request = parseV2Xml(xmlBody)
    const fields = { return_code: 'SUCCESS', result_code: 'SUCCESS', transaction_id: 'WX-BAD', mch_id: MCH_ID, appid: APP_ID, out_trade_no: request.out_trade_no, total_fee: request.total_fee }
    fields.sign = signV2Params(fields, 'wrongkeywrongkeywrongkeywrongkey12', 'HMAC-SHA256')
    return buildV2Xml(fields)
  }
  const { service } = buildService(transport)
  await withLiveMode(async () => {
    const created = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-5', authCode: AUTH_CODE })
    assert.equal(created.payment.status, 'pending')
    assert.equal(created.payment.reconciliationRequired, true)
    assert.notEqual(created.order.status, 'completed')
  })
})

test('E2E：灰度——订单门店未授权时创建支付被拒绝（403）', async () => {
  const transport = makeTransport(() => ({ return_code: 'SUCCESS', result_code: 'SUCCESS', transaction_id: 'WX-X' }))
  const { service, db } = buildService(transport)
  db.orders[0].storeId = 'store-999' // 未授权门店
  await withLiveMode(async () => {
    await assert.rejects(
      () => service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-6', authCode: AUTH_CODE }),
      (error) => error.status === 403 && /未授权微信支付/.test(error.message),
    )
  })
})

test('E2E：CDATA 响应格式（微信真实格式）完整走通', async () => {
  const transport = async (path, xmlBody) => {
    const request = parseV2Xml(xmlBody)
    const fields = { return_code: 'SUCCESS', result_code: 'SUCCESS', transaction_id: 'WX-CDATA', mch_id: MCH_ID, appid: APP_ID, out_trade_no: request.out_trade_no, total_fee: request.total_fee }
    fields.sign = signV2Params(fields, API_V2_KEY, 'HMAC-SHA256')
    return `<xml><return_code>${cdata(fields.return_code)}</return_code><result_code>${cdata(fields.result_code)}</result_code><mch_id>${cdata(MCH_ID)}</mch_id><appid>${cdata(APP_ID)}</appid><transaction_id>${cdata(fields.transaction_id)}</transaction_id><out_trade_no>${cdata(fields.out_trade_no)}</out_trade_no><total_fee>${cdata(fields.total_fee)}</total_fee><sign>${cdata(fields.sign)}</sign></xml>`
  }
  const { service } = buildService(transport)
  await withLiveMode(async () => {
    const result = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-7', authCode: AUTH_CODE })
    assert.equal(result.payment.status, 'success')
    assert.equal(result.order.status, 'completed')
  })
})

test('L：公开微信回调在本阶段无法改动支付状态（伪造回调被验签拒绝）', async () => {
  const transport = makeTransport((path, req) => ({
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    transaction_id: 'WX-E2E-1',
    out_trade_no: req.out_trade_no,
    total_fee: req.total_fee,
  }))
  const { service, db } = buildService(transport)
  await withLiveMode(async () => {
    const created = await service.createPayment({ orderId: 'order-1', channel: 'wechat', requestKey: 'e2e-request-callback-1', authCode: AUTH_CODE })
    assert.equal(created.payment.status, 'success')
    assert.equal(created.order.status, 'completed')
    // 伪造回调（无有效签名）走公开验签路径，必须被拒绝且不改变状态
    const forged = {
      return_code: 'SUCCESS',
      result_code: 'SUCCESS',
      mch_id: MCH_ID,
      appid: APP_ID,
      out_trade_no: created.payment.merchantTradeNo,
      transaction_id: 'WX-FORGED',
      sign: 'INVALID',
    }
    await assert.rejects(() => service.handleCallback('wechat_pay', forged), (error) => error.status === 401)
    const after = await service.result(created.payment.id)
    assert.equal(after.payment.status, 'success')
    assert.equal(after.payment.providerTradeNo, 'WX-E2E-1')
    assert.notEqual(after.payment.providerTradeNo, 'WX-FORGED')
    // 合法签名但走公开回调路径同样不允许在本阶段生效（路由已 404；服务层仍验签）
    assert.equal(db.paymentLogs.filter((log) => log.event === 'payment.success').length >= 1, true)
  })
})
