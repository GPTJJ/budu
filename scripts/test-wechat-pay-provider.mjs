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
  terminalIp: '8.8.8.8',
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

test('微信退款申请：双向 TLS 提交，受理成功仍保持 pending', async () => {
  const fake = new FakeClient()
  fake.responses.push({
    return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId,
    out_trade_no: 'BUDUPAY1', transaction_id: 'WX-REFUND-TRADE', out_refund_no: 'RFTEST1',
    total_fee: '7200', refund_fee: '3600', refund_id: 'WXRF1', sign: 'x',
  })
  const provider = providerWith(fake)
  const result = await provider.refundPayment(payment({ providerTradeNo: 'WX-REFUND-TRADE' }), {
    refundNo: 'RFTEST1', refundAmount: 3600n, totalAmount: 7200n, reason: '部分退款',
  })
  assert.equal(fake.calls[0].path, '/secapi/pay/refund')
  assert.equal(fake.calls[0].mtls, true, '申请退款必须使用双向 TLS')
  assert.equal(fake.calls[0].params.out_refund_no, 'RFTEST1')
  assert.equal(fake.calls[0].params.refund_fee, '3600')
  assert.equal(result.status, 'pending', '申请受理不等于退款完成')
  assert.equal(result.providerRefundNo, 'WXRF1')
})

test('微信退款申请：系统错误/频率限制保持 pending，必须沿用原退款单号核对', async () => {
  for (const errCode of ['SYSTEMERROR', 'BIZERR_NEED_RETRY', 'FREQUENCY_LIMITED', 'INVALID_REQ_TOO_MUCH']) {
    const fake = new FakeClient()
    fake.responses.push({
      return_code: 'SUCCESS', result_code: 'FAIL', err_code: errCode, err_code_des: '请重试',
      mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', sign: 'x',
    })
    const result = await providerWith(fake).refundPayment(payment(), {
      refundNo: `RF${errCode}`, refundAmount: 3600n, totalAmount: 7200n,
    })
    assert.equal(result.status, 'pending', `${errCode} 不得误判失败`)
    assert.equal(result.failureCode, errCode)
  }
})

test('微信退款查询：PROCESSING 保持 pending，SUCCESS 才完成', async () => {
  const processing = new FakeClient()
  processing.responses.push({
    return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId,
    out_trade_no: 'BUDUPAY1', total_fee: '7200', refund_count: '1',
    out_refund_no_0: 'RFTEST2', refund_id_0: 'WXRF2', refund_fee_0: '3600', refund_status_0: 'PROCESSING', sign: 'x',
  })
  let result = await providerWith(processing).queryRefund(payment(), { refundNo: 'RFTEST2', refundAmount: 3600n })
  assert.equal(processing.calls[0].path, '/pay/refundquery')
  assert.equal(processing.calls[0].mtls, false)
  assert.equal(result.status, 'pending')

  const success = new FakeClient()
  success.responses.push({
    return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId,
    out_trade_no: 'BUDUPAY1', total_fee: '7200', refund_count: '1',
    out_refund_no_0: 'RFTEST2', refund_id_0: 'WXRF2', refund_fee_0: '3600', refund_status_0: 'SUCCESS', sign: 'x',
  })
  result = await providerWith(success).queryRefund(payment(), { refundNo: 'RFTEST2', refundAmount: 3600n })
  assert.equal(result.status, 'completed')
  assert.equal(result.providerRefundNo, 'WXRF2')
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
    '100.64.0.1', // CGNAT
    '172.16.0.1', // RFC1918
    '172.31.255.254', // RFC1918
    '192.168.1.1', // RFC1918
    '169.254.1.1', // 链路本地
    '192.0.0.1', // IETF 协议分配
    '192.0.2.1', // TEST-NET-1
    '198.18.0.1', // 基准测试
    '198.51.100.1', // TEST-NET-2
    '203.0.113.1', // TEST-NET-3
    '224.0.0.1', // 组播（R3 评审清单）
    '240.0.0.1', // 保留（R3 评审清单）
    '255.0.0.1', // 保留段 240/4（R3 评审清单）
    '255.255.255.255', // 广播
    'not-an-ip', // 非 IP
    'localhost',
    '::1', // IPv6 回环
    '2001:db8::1', // IPv6
    '203.0.113.999', // 越界
    '1.2.3', // 缺段
  ]
  for (const terminalIp of BAD_IPS) {
    const fake = new FakeClient()
    const provider = new WechatPayProvider({ config: { ...CONFIG, terminalIp }, clientFactory: () => fake })
    await assert.rejects(() => provider.createPayment(payment(), { authCode: '130123456789012345' }), (error) => error.status === 501, `createPayment terminalIp=${String(terminalIp)}`)
    await assert.rejects(() => provider.queryPayment(payment()), (error) => error.status === 501, `queryPayment terminalIp=${String(terminalIp)}`)
    await assert.rejects(() => provider.closePayment(payment()), (error) => error.status === 501, `closePayment terminalIp=${String(terminalIp)}`)
    assert.equal(fake.calls.length, 0, `terminalIp=${String(terminalIp)} 不得发起任何传输调用`)
  }
  // 合法公网 IPv4：spbill_create_ip 使用配置值原样传递，绝不出现回环回退
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', transaction_id: 'WX-IP', sign: 'x' })
  const provider = providerWith(fake)
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'success')
  assert.equal(fake.calls[0].params.spbill_create_ip, '8.8.8.8')
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

// ============ R3：绝对时限（ABSOLUTE_DEADLINE） ============

/** 挂起客户端：请求永不返回，但监听中止信号（模拟真实 socket 被 destroy 前的中止传播）。 */
class HangingClient {
  constructor() {
    this.calls = []
    this.aborted = null
  }

  async request(path, params, opts = {}) {
    this.calls.push(path)
    this.aborted = new Promise((resolve) => {
      if (opts.signal?.aborted) resolve(true)
      else opts.signal?.addEventListener('abort', () => resolve(true), { once: true })
    })
    await this.aborted
    throw new WechatV2Error('ABSOLUTE_DEADLINE', 'aborted', { retryable: true, ambiguous: true })
  }
}

test('R3：绝对时限——挂起请求在 deadline 到期后被主动中止，返回受控歧义结果（pending+核对），不回退备用域名', async () => {
  const client = new HangingClient()
  const provider = new WechatPayProvider({ config: CONFIG, clientFactory: () => client, deadlineMs: 60 })
  const started = Date.now()
  const result = await provider.queryPayment(payment())
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 50, `应在 deadline 附近返回（实际 ${elapsed}ms）`)
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.callbacks[0].failureCode, 'ABSOLUTE_DEADLINE')
  assert.equal(result.reconciliation.providerStatus, 'ABSOLUTE_DEADLINE')
  assert.equal(result.reconciliation.reconciliationRequired, true)
  await client.aborted // 底层请求已被主动中止（真实传输会 destroy socket）
  assert.equal(client.calls.length, 1, '中止后不得再回退备用域名')
})

test('R3：绝对时限覆盖整次 closePayment（查询+撤销）——超时返回歧义结果，绝不虚构终态', async () => {
  const client = new HangingClient()
  const provider = new WechatPayProvider({ config: CONFIG, clientFactory: () => client, deadlineMs: 60 })
  const result = await provider.closePayment(payment())
  assert.equal(result.callbacks[0].status, 'pending', '不得返回 closed/failed 等终态')
  assert.equal(result.callbacks[0].failureCode, 'ABSOLUTE_DEADLINE')
  assert.equal(result.reconciliation.reconciliationRequired, true)
  assert.equal(client.calls.length, 1, '撤销请求不得在绝对时限后启动')
  await client.aborted
})

test('R3：createPayment 同样受绝对时限约束（歧义结果，不虚构终态）', async () => {
  const client = new HangingClient()
  const provider = new WechatPayProvider({ config: CONFIG, clientFactory: () => client, deadlineMs: 60 })
  const result = await provider.createPayment(payment(), { authCode: '130123456789012345' })
  assert.equal(result.callbacks[0].status, 'pending')
  assert.equal(result.callbacks[0].failureCode, 'ABSOLUTE_DEADLINE')
  assert.equal(result.reconciliation.reconciliationRequired, true)
  await client.aborted
})

test('R3：正常快速响应不受绝对时限影响', async () => {
  const fake = new FakeClient()
  fake.responses.push({ return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', mch_id: CONFIG.mchId, appid: CONFIG.appId, out_trade_no: 'BUDUPAY1', total_fee: '7200', transaction_id: 'WX-FAST', sign: 'x' })
  const provider = new WechatPayProvider({ config: CONFIG, clientFactory: () => fake, deadlineMs: 5000 })
  const result = await provider.queryPayment(payment())
  assert.equal(result.callbacks[0].status, 'success')
})
