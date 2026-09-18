import test from 'node:test'
import assert from 'node:assert/strict'
import { createWechatLogistics } from '../server/wechat-logistics.js'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'

const CONFIG = { appId: 'wxfce0a3c4bb430023', appSecret: 's'.repeat(32) }
const MINI = 'pages/order-detail/order-detail?payNo=B123'

function fetcher({ token = 'TOKEN-A', tokenFails = false, waybill }) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null })
    if (url.includes('stable_token')) {
      return { ok: true, json: async () => (tokenFails ? { errcode: 40013 } : { access_token: token, expires_in: 7200 }) }
    }
    const next = typeof waybill === 'function' ? waybill(calls) : waybill
    if (next === 'TRANSPORT') return null
    if (next === 'NON_JSON') return { ok: true, json: async () => { throw new SyntaxError('bad body') } }
    return { ok: true, json: async () => next }
  }
  return { impl, calls }
}

const valid = {
  openid: 'oPENID-1',
  receiverPhone: '13800000000',
  waybillId: 'SF1234567890',
  transId: '4200003114202609180000000001',
  orderDetailPath: MINI,
  goodsName: '92%生巧克力',
  goodsImgUrl: 'https://cdn.example.com/p/c1.jpg',
}

function client(waybill, extra = {}) {
  _resetMiniprogramTokenAuthority()
  const { impl, calls } = fetcher({ waybill, ...extra })
  return { logistics: createWechatLogistics({ config: CONFIG, fetchImpl: impl }), calls }
}

test('LOG-01 a Sweet Card-only order has no trans_id and is never sent to WeChat', async () => {
  const { logistics, calls } = client({ errcode: 0, waybill_token: 'T' })
  for (const missing of ['', undefined, null, '   ']) {
    const result = await logistics.reportWaybill({ ...valid, transId: missing })
    assert.equal(result.status, 'UNSUPPORTED')
  }
  // Not even a token fetch: there is nothing legitimate to report.
  assert.equal(calls.length, 0)
})

test('LOG-02 other mandatory facts missing also short-circuit', async () => {
  const { logistics, calls } = client({ errcode: 0, waybill_token: 'T' })
  for (const key of ['openid', 'receiverPhone', 'waybillId', 'orderDetailPath', 'goodsName', 'goodsImgUrl']) {
    const result = await logistics.reportWaybill({ ...valid, [key]: '' })
    assert.equal(result.status, 'UNSUPPORTED', `${key} must be required`)
  }
  assert.equal(calls.length, 0)
})

test('LOG-03 a normal report sends exactly what WeChat documents', async () => {
  const { logistics, calls } = client({ errcode: 0, waybill_token: 'TOKEN-WAYBILL' })
  const result = await logistics.reportWaybill(valid)
  assert.deepEqual(result, { status: 'SYNCED', waybillToken: 'TOKEN-WAYBILL' })
  const sent = calls.find(call => call.url.includes('trace_waybill'))
  assert.ok(sent, 'the waybill endpoint must be called')
  assert.equal(sent.body.openid, valid.openid)
  assert.equal(sent.body.receiver_phone, valid.receiverPhone)
  assert.equal(sent.body.waybill_id, valid.waybillId)
  assert.equal(sent.body.trans_id, valid.transId)
  assert.equal(sent.body.order_detail_path, MINI)
  assert.deepEqual(sent.body.goods_info, { detail_list: [{ goods_name: valid.goodsName, goods_img_url: valid.goodsImgUrl }] })
  // delivery_id is optional and is omitted rather than guessed.
  assert.equal('delivery_id' in sent.body, false)
})

test('LOG-04 a success without a waybill_token never invents one locally', async () => {
  const { logistics } = client({ errcode: 0 })
  const result = await logistics.reportWaybill(valid)
  assert.equal(result.status, 'PENDING')
  assert.equal('waybillToken' in result, false)
})

test('LOG-05 permanent rejections stop retrying, retryable ones do not', async () => {
  const permanent = [
    40003, // invalid openid
    9300513, // out of quota
    9300534, // access_token does not match openid
    9300560, // modification limit reached
  ]
  for (const errcode of permanent) {
    const { logistics, calls } = client({ errcode })
    const result = await logistics.reportWaybill(valid)
    assert.equal(result.status, 'FAILED', `errcode ${errcode} must be permanent`)
    assert.equal(calls.filter(call => call.url.includes('trace_waybill')).length, 1)
  }
  for (const errcode of [-1, 9300559]) {
    const { logistics } = client({ errcode })
    const result = await logistics.reportWaybill(valid)
    assert.equal(result.status, 'PENDING', `errcode ${errcode} must stay retryable`)
  }
})

test('LOG-06 a rejected access_token is refreshed once and the report still lands', async () => {
  _resetMiniprogramTokenAuthority()
  let reported = 0
  const calls = []
  const impl = async (url, options) => {
    calls.push(url)
    if (url.includes('stable_token')) {
      // First issue TOKEN-OLD, the forced refresh issues TOKEN-NEW.
      const isRefresh = calls.filter(u => u.includes('stable_token')).length > 1
      return { ok: true, json: async () => ({ access_token: isRefresh ? 'TOKEN-NEW' : 'TOKEN-OLD', expires_in: 7200 }) }
    }
    reported++
    return { ok: true, json: async () => (url.includes('TOKEN-OLD') ? { errcode: 40001 } : { errcode: 0, waybill_token: 'TOKEN-W' }) }
  }
  const logistics = createWechatLogistics({ config: CONFIG, fetchImpl: impl })
  const result = await logistics.reportWaybill(valid)
  assert.deepEqual(result, { status: 'SYNCED', waybillToken: 'TOKEN-W' })
  assert.equal(reported, 2, 'the report is retried exactly once after a token refresh')
})

test('LOG-07 transport failure and unusable token stay retryable, never fatal', async () => {
  const transport = client('TRANSPORT')
  assert.equal((await transport.logistics.reportWaybill(valid)).status, 'PENDING')

  const malformed = client('NON_JSON')
  assert.equal((await malformed.logistics.reportWaybill(valid)).status, 'PENDING')

  _resetMiniprogramTokenAuthority()
  const { impl } = fetcher({ waybill: { errcode: 0 }, tokenFails: true })
  const noToken = createWechatLogistics({ config: CONFIG, fetchImpl: impl })
  assert.equal((await noToken.reportWaybill(valid)).status, 'PENDING')
})

test('LOG-08 no access_token ever leaks into a result, a code or an error message', async () => {
  for (const waybill of [{ errcode: 0, waybill_token: 'TOKEN-W' }, { errcode: 9300513 }, { errcode: 40001 }, 'TRANSPORT']) {
    const { logistics } = client(waybill)
    const serialized = JSON.stringify(await logistics.reportWaybill(valid))
    assert.equal(serialized.includes(CONFIG.appSecret), false)
    assert.equal(serialized.includes('access_token'), false)
    assert.equal(serialized.includes('TOKEN-A'), false)
  }
})

test('LOG-09 over-long values are refused, never truncated', async () => {
  const { logistics, calls } = client({ errcode: 0, waybill_token: 'T' })
  const result = await logistics.reportWaybill({ ...valid, receiverPhone: '9'.repeat(41) })
  assert.equal(result.status, 'UNSUPPORTED')
  assert.equal(calls.length, 0)
})
