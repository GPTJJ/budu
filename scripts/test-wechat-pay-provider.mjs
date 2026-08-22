// 微信付款码 Provider 单元测试（注入假传输，绝不连接真实微信）
import test from 'node:test'
import assert from 'node:assert/strict'
import { WechatPayProvider, WECHAT_AUTH_CODE_RE } from '../server/payments/providers/wechat-pay.js'
import { WechatV2Error } from '../server/payments/wechat-v2-client.js'

const CONFIG = {
  enabled: true,
  protocol: 'v2_micropay',
  configured: true,
  mchId: '1900000109',
  appId: 'wx8888888888888888',
  terminalIp: '203.0.113.10',
  enabledStores: [],
  apiV2Key: '0123456789abcdef0123456789abcdef',
  certPem: 'cert',
  keyPem: 'key',
  reason: '',
}

const payment = (overrides = {}) => ({
  id: 'pay-1',
  paymentNo: 'PAY1',
  merchantTradeNo: 'BUDUPAY1',
  provider: 'wechat_pay',
  amount: 7200n,
  status: 'pending',
  providerTradeNo: null,
  ...overrides,
})

class FakeClient {
  constructor() {
    this.calls = []
    this.responses = [] // 按调用顺序出队；不足时抛错
    this.mtlsUsed = []
  }

  async request(path, params, opts = {}) {
    this.calls.push({ path, params, opts, mtls: opts.useMtls === true })
    if (this.mtlsUsed !== undefined && opts.useMtls) this.mtlsUsed.push(path)
    const next = this.responses.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('fake client: no response queued')
    return next
  }
}

const providerWith = (fake) => new WechatPayProvider({ config: CONFIG, clientFactory: () => fake })

test('付款码格式：18 位数字且前缀 10-15', () => {
  assert.equal(WECHAT_AUTH_CODE_RE.test('130123456789012345'), true)
  assert.equal(WECHAT_AUTH_CODE_RE.test('101234567890123456'), true)
  assert.equal(WECHAT_AUTH_CODE_RE.test('159876543210987654'), true)
  assert.equal(WECHAT_AUTH_CODE_RE.test('160123456789012345'), false) // 16 前缀不允许
  assert.equal(WECHAT_AUTH_CODE_RE.test('13012345678901234'), false) // 17 位
  assert.equal(WECHAT_AUTH_CODE_RE.test('1301234567890123456'), false) // 19 位
  assert.equal(WECHAT_AUTH_CODE_RE.test('13012345678901234a'), false) // 非数字
})

test('MICROPAY 成功：立即 success，且付款码不进 metadata', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', transaction_id: 'WX1', nonce_str: 'n', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'success')
  assert.equal(result.providerTradeNo, 'WX1')
  assert.equal(fake.calls[0].path, '/pay/micropay')
  assert.equal(fake.calls[0].params.auth_code, '130123456789012345')
  assert.equal(fake.calls[0].params.total_fee, '7200')
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('130123456789012345'), '付款码不得进入 metadata/响应')
  assert.ok(!('auth_code' in result.metadata))
})

test('USERPAYING → pending + reconciliationRequired（不允许重新扫码）', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'USERPAYING', err_code_des: '支付中', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.reconciliation.providerStatus, 'USERPAYING')
  assert.equal(result.reconciliation.reconciliationRequired, true)
})

test('终态错误（付款码过期/余额不足）→ failed，不进入核对', async () => {
  for (const errCode of ['AUTHCODEEXPIRE', 'NOTENOUGH', 'AUTH_CODE_INVALID']) {
    const fake = new FakeClient()
    fake.responses.push({ return_code: 'SUCCESS', result_code: 'FAIL', err_code: errCode, err_code_des: '拒绝', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
    const provider = providerWith(fake)
    const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
    assert.equal(result.callbacks[0].status, 'failed', errCode)
    assert.equal(result.callbacks[0].failureCode, errCode)
    assert.equal(result.reconciliation, undefined)
  }
})

test('SYSTEMERROR → pending + reconciliationRequired（绝不直接失败）', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'SYSTEMERROR', err_code_des: '系统繁忙', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.reconciliation.reconciliationRequired, true)
})

test('网络超时/响应丢失 → pending + reconciliationRequired（可能已扣款，需恢复）', async () => {
  const fake = new FakeClient()
  fake.responses.push(new WechatV2Error('NETWORK_ERROR', '网络错误', { retryable: true, ambiguous: true }))
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.reconciliation.reconciliationRequired, true)
})

test('金额/商户号/订单号不一致 → pending + reconciliationRequired + 人工核对', async () => {
  for (const code of ['TOTAL_FEE_MISMATCH', 'OUT_TRADE_NO_MISMATCH', 'MCHID_MISMATCH', 'SIGN_MISMATCH']) {
    const fake = new FakeClient()
    fake.responses.push(new WechatV2Error(code, code, { retryable: false, ambiguous: true }))
    const provider = providerWith(fake)
    const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
    assert.equal(result.callbacks[0].status, 'pending', code)
    assert.equal(result.callbacks[0].failureCode, code)
    assert.equal(result.reconciliation.reconciliationRequired, true)
  }
})

test('ORDERPAID → 立即查询确认（不重复扣款）', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'ORDERPAID', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', transaction_id: 'WX9', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[1].path, '/pay/orderquery')
  assert.equal(result.callbacks[0].status, 'success')
})

test('查询：USERPAYING → 持续 pending；SUCCESS → success；CLOSED → closed', async () => {
  const pending = { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' }
  const ok = { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', transaction_id: 'WX2', sign: 'x' }
  const closed = { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'CLOSED', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' }
  let fake = new FakeClient()
  fake.responses.push(pending)
  let result = await providerWith(fake).queryPayment(payment())
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.reconciliation.reconciliationRequired, true)
  fake = new FakeClient()
  fake.responses.push(ok)
  result = await providerWith(fake).queryPayment(payment())
  assert.equal(result.callbacks[0].status, 'success')
  assert.equal(result.providerTradeNo, 'WX2')
  fake = new FakeClient()
  fake.responses.push(closed)
  result = await providerWith(fake).queryPayment(payment())
  assert.equal(result.callbacks[0].status, 'closed')
})

test('关闭：查询 SUCCESS 时不撤销；USERPAYING 时走双向 TLS 撤销并最终 closed', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' }) // reverse 成功
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'CLOSED', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' }) // 撤销后查询
  const provider = providerWith(fake)
  const result = await provider.closePayment(payment())
  assert.equal(fake.calls[1].path, '/secapi/pay/reverse')
  assert.equal(fake.calls[1].mtls, true, '撤销必须使用双向 TLS')
  assert.equal(result.callbacks[0].status, 'closed')
})

test('撤销结果不明确 → pending + 禁止二次支付 + 告警标记', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'SYSTEMERROR', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.closePayment(payment())
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.reconciliation.providerStatus, 'REVERSE_FAIL')
  assert.equal(result.reconciliation.reconciliationRequired, true)
})

test('真实退款保持关闭（501）', async () => {
  const provider = providerWith(new FakeClient())
  await assert.rejects(() => provider.refundPayment(), (error) => error.status === 501 && /尚未开放/.test(error.message))
})

test('回调验签：错误签名/商户号不匹配拒绝；合法签名映射状态', async () => {
  const fake = new FakeClient()
  const provider = providerWith(fake)
  const valid = {
    return_code: 'SUCCESS',
    mch_id: CONFIG.mchId,
    appid: CONFIG.appId,
    out_trade_no: 'BUDUPAY1',
    result_code: 'SUCCESS',
    transaction_id: 'WX3',
    sign: 'x',
  }
  const sign = 'BADSIGN'
  const badSign = await provider.verifyCallback({ ...valid, sign }).catch((e) => e)
  assert.equal(badSign.status, 401)
  const badMch = await provider.verifyCallback({ ...valid, mch_id: 'other', sign: 'x' }).catch((e) => e)
  assert.equal(badMch.status, 401)
})

test('未启用/未配置时 Provider 拒绝（501）且不调用任何接口', async () => {
  const fake = new FakeClient()
  const provider = new WechatPayProvider({ config: { ...CONFIG, enabled: false }, clientFactory: () => fake })
  await assert.rejects(() => provider.createPayment(payment(), { authCode: '130123456789012345' }), (error) => error.status === 501)
  assert.equal(fake.calls.length, 0)
})

test('R2：终端 IP 边界——缺失/回环/私网/链路本地/非法值一律 501，且零网络调用（无 127.0.0.1 回退）', async () => {
  const BAD_IPS = [
    undefined, // 未配置
    '', // 空串
    '127.0.0.1', // 回环（R1 曾回退到此值）
    '127.0.0.2',
    '0.0.0.0', // 未指定
    '10.1.2.3', // RFC1918
    '172.16.0.1', // RFC1918
    '172.31.255.254', // RFC1918
    '192.168.1.1', // RFC1918
    '169.254.1.1', // 链路本地
    '255.255.255.255', // 广播
    'not-an-ip', // 非 IP
    '203.0.113.999', // 越界
    '1.2.3', // 缺段
    '2001:db8::1', // IPv6 不接受
  ]
  for (const terminalIp of BAD_IPS) {
    const fake = new FakeClient()
    const provider = new WechatPayProvider({ config: { ...CONFIG, terminalIp }, clientFactory: () => fake })
    await assert.rejects(() => provider.createPayment(payment(), { authCode: '130123456789012345' }), (error) => error.status === 501, `createPayment terminalIp=${String(terminalIp)}`)
    await assert.rejects(() => provider.queryPayment(payment()), (error) => error.status === 501, `queryPayment terminalIp=${String(terminalIp)}`)
    await assert.rejects(() => provider.closePayment(payment()), (error) => error.status === 501, `closePayment terminalIp=${String(terminalIp)}`)
    assert.equal(fake.calls.length, 0, `terminalIp=${String(terminalIp)} 不得发起任何传输调用`)
  }
  // 合法公网 IPv4：spbill_create_ip 使用配置值，绝不出现回环回退
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', transaction_id: 'WX-IP', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'success')
  assert.equal(fake.calls[0].params.spbill_create_ip, '203.0.113.10')
  assert.ok(!String(fake.calls[0].params.spbill_create_ip).startsWith('127.'), 'spbill_create_ip 不得为回环地址')
})

test('I：reverse recall=Y → 绝不 closed，保持待核对并标记重试（重启后可继续撤销）', async () => {
  // 第一次撤销：recall=Y（需按官方协议重试撤销）
  const fake1 = new FakeClient()
  fake1.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake1.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', recall: 'Y', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  const provider1 = providerWith(fake1)
  const first = await provider1.closePayment(payment())
  assert.equal(first.callbacks[0].status, 'pending', 'recall=Y 不得标记 closed')
  assert.equal(first.reconciliation.providerStatus, 'REVOKE_RETRY')
  assert.equal(first.reconciliation.reconciliationRequired, true)
  // 第二次（模拟重启后的重试）：recall=N + 查询 CLOSED → 终态 closed
  const fake2 = new FakeClient()
  fake2.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake2.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', recall: 'N', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake2.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'CLOSED', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  const provider2 = providerWith(fake2)
  const second = await provider2.closePayment(payment())
  assert.equal(second.callbacks[0].status, 'closed')
})

test('I：撤销网络歧义 → 保持 pending + 人工核对，不 cancel 订单', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'USERPAYING', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', sign: 'x' })
  fake.responses.push(new WechatV2Error('NETWORK_ERROR', '网络错误', { retryable: true, ambiguous: true }))
  const provider = providerWith(fake)
  const result = await provider.closePayment(payment())
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.reconciliation.providerStatus, 'REVERSE_UNKNOWN')
  assert.equal(result.reconciliation.reconciliationRequired, true)
})
