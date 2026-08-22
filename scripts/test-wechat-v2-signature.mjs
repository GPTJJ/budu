// 微信支付 APIv2 签名与安全 XML 单元测试（不连接任何外部系统）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  signV2Params,
  verifyV2Signature,
  buildV2Xml,
  parseV2Xml,
  WECHAT_V2_MAX_XML_BYTES,
  WECHAT_V2_SIGN_HMAC_SHA256,
  WECHAT_V2_SIGN_MD5,
} from '../server/payments/wechat-v2-signature.js'

const KEY = '0123456789abcdef0123456789abcdef'

// ============ J：独立硬编码固定向量（期望值由独立实现预先计算，非断言内现场计算） ============
// key = 0123456789abcdef0123456789abcdef
// fields = { appid: wx8888888888888888, mch_id: 1900000109, nonce_str: abc123, out_trade_no: BUDUPAY1, total_fee: 7200 }
const FIXED_HMAC_CANONICAL = 'appid=wx8888888888888888&mch_id=1900000109&nonce_str=abc123&out_trade_no=BUDUPAY1&total_fee=7200&key=0123456789abcdef0123456789abcdef'
const FIXED_HMAC_KEY = '0123456789abcdef0123456789abcdef'
const FIXED_HMAC_SIGNATURE = 'B5504FF9C20AEDA90993C3BD214A3B78736FD032A6287A46A1B02475D0C292CC'

test('J：HMAC-SHA256 固定向量（独立硬编码期望值）', () => {
  const params = {
    appid: 'wx8888888888888888',
    mch_id: '1900000109',
    out_trade_no: 'BUDUPAY1',
    total_fee: '7200',
    nonce_str: 'abc123',
  }
  const sign = signV2Params(params, FIXED_HMAC_KEY, WECHAT_V2_SIGN_HMAC_SHA256)
  assert.equal(sign, FIXED_HMAC_SIGNATURE)
  assert.equal(sign.length, 64)
  const derived = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&') + `&key=${FIXED_HMAC_KEY}`
  assert.equal(derived, FIXED_HMAC_CANONICAL)
  assert.equal(sign, signV2Params({ ...params, empty: '', sign: 'x', key: 'y' }, FIXED_HMAC_KEY, WECHAT_V2_SIGN_HMAC_SHA256))
  const shuffled = { total_fee: params.total_fee, nonce_str: params.nonce_str, out_trade_no: params.out_trade_no, mch_id: params.mch_id, appid: params.appid }
  assert.equal(sign, signV2Params(shuffled, FIXED_HMAC_KEY, WECHAT_V2_SIGN_HMAC_SHA256))
})

test('J：MD5 固定向量（独立硬编码期望值）', () => {
  const params = { a: '1', b: '2', c: '3' }
  const sign = signV2Params(params, KEY, WECHAT_V2_SIGN_MD5)
  assert.equal(sign, '48235C8E3CBA6B8425924B93F210D7CE')
  assert.equal(sign.length, 32)
  assert.equal(verifyV2Signature({ ...params, sign }, KEY, WECHAT_V2_SIGN_MD5), true)
  assert.equal(verifyV2Signature({ a: '9', b: '2', c: '3', sign }, KEY, WECHAT_V2_SIGN_MD5), false)
})

test('XML 构造与解析往返（含特殊字符转义）', () => {
  const params = { a: '1', b: 'A&B<C>D"E\'F', c: '  空格  ' }
  const xml = buildV2Xml(params)
  const parsed = parseV2Xml(xml)
  assert.deepEqual(parsed, { a: '1', b: 'A&B<C>D"E\'F', c: '  空格  ' })
})

test('XML 拒绝 DOCTYPE / 外部实体 / 内联实体', () => {
  assert.throws(() => parseV2Xml('<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><xml><a>&xxe;</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a>&xxe;</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a>&#65;</a></xml>')) // 数字实体拒绝
  assert.throws(() => parseV2Xml('<xml><![CDATA[x]]></xml>')) // 元素级裸 CDATA 拒绝
  assert.throws(() => parseV2Xml('<xml><![CDATA[<a>]]></xml>')) // 元素级裸 CDATA 拒绝
  assert.throws(() => parseV2Xml('<xml><!-- comment --><a>1</a></xml>'))
})

test('XML 拒绝嵌套、属性、重复字段与非法根节点', () => {
  assert.throws(() => parseV2Xml('<xml><a><b>1</b></a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a x="1">1</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a>1</a><a>2</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a>1</a>'))
  assert.throws(() => parseV2Xml('<notxml><a>1</a></notxml>'))
  assert.throws(() => parseV2Xml(''))
})

test('K：严格全量消费——前缀/后缀/元素间文本一律拒绝', () => {
  assert.throws(() => parseV2Xml('garbage<xml><a>1</a></xml>')) // 前缀垃圾
  assert.throws(() => parseV2Xml('<xml><a>1</a></xml>garbage')) // 后缀垃圾
  assert.throws(() => parseV2Xml('<xml><a>1</a></xml><xml><b>2</b></xml>')) // 双根
  assert.throws(() => parseV2Xml('<xml><a>1</a>garbage<b>2</b></xml>')) // 元素间文本
  assert.throws(() => parseV2Xml('<xml>  <a>1</a>  garbage  <b>2</b>  </xml>')) // 元素间非空白文本
  // 元素间纯空白仍然允许（微信 V2 兼容）
  assert.deepEqual(parseV2Xml('<xml>  <a>1</a>  <b>2</b>  </xml>'), { a: '1', b: '2' })
})

test('K：属性/嵌套/DOCTYPE/ENTITY/重复字段回归', () => {
  assert.throws(() => parseV2Xml('<xml><a x="1">1</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a><b>1</b></a></xml>'))
  assert.throws(() => parseV2Xml('<!DOCTYPE foo><xml><a>1</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a>&xxe;</a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a>1</a><a>2</a></xml>'))
})

test('XML 拒绝超大响应', () => {
  const huge = `<xml><a>${'x'.repeat(WECHAT_V2_MAX_XML_BYTES + 1)}</a></xml>`
  assert.throws(() => parseV2Xml(huge))
})

test('XML 保留五标准实体之外的值原样（未知实体已在前面拒绝）', () => {
  const parsed = parseV2Xml('<xml><a>100&amp;1</a><b>2</b></xml>')
  assert.equal(parsed.a, '100&1')
  assert.equal(parsed.b, '2')
})

test('CDATA：完整包裹值的 CDATA 按字面解析（微信 V2 真实格式），且覆盖校验仍严格', () => {
  const parsed = parseV2Xml('<xml><return_code><![CDATA[SUCCESS]]></return_code><mch_id><![CDATA[1900000109]]></mch_id></xml>')
  assert.deepEqual(parsed, { return_code: 'SUCCESS', mch_id: '1900000109' })
  // CDATA 内含类标签文本按字面处理，不触发嵌套检查
  const parsed2 = parseV2Xml('<xml><a><![CDATA[<b>1</b>]]></a></xml>')
  assert.equal(parsed2.a, '<b>1</b>')
  // 部分包裹的 CDATA（值外残留）必须拒绝
  assert.throws(() => parseV2Xml('<xml><a>x<![CDATA[y]]></a></xml>'))
  assert.throws(() => parseV2Xml('<xml><a><![CDATA[y]]>x</a></xml>'))
})

test('R2：严格 CDATA 畸形夹具清单——全部必须拒绝（含内容内多余 ]]>）', () => {
  // 每一条都代表一种「看似 CDATA、实际畸形」的输入；解析器必须逐一拒绝，
  // 不得被贪婪匹配吞掉，也不得把畸形内容当合法值返回。
  const REJECT_FIXTURES = [
    // 1. CDATA 结束符后残留垃圾（含多余 ]]>）
    '<xml><a><![CDATA[x]]>garbage]]></a></xml>',
    // 2. 双 CDATA 相邻（第一个被贪婪吞并后内容含 ]]>）
    '<xml><a><![CDATA[x]]><![CDATA[y]]></a></xml>',
    // 3. CDATA 前有裸文本（部分包裹）
    '<xml><a>x<![CDATA[y]]></a></xml>',
    // 4. CDATA 前有头部文本（部分包裹）
    '<xml><a>head<![CDATA[x]]></a></xml>',
    // 5. CDATA 后有多余 ]]>（内容内出现禁止的 ]]>）
    '<xml><a><![CDATA[x]]>]]></a></xml>',
    // 6. 未闭合 CDATA（缺右界）
    '<xml><a><![CDATA[x]></a></xml>',
    // 7. 右界书写错误（缺一个 ]，只剩单个 ]>）
    '<xml><a><![CDATA[]></a></xml>',
    // 8. 仅右界符
    '<xml><a>]]></a></xml>',
    // 9. 仅左界符
    '<xml><a><![CDATA[</a></xml>',
    // 10. 内容中间插入 ]]> 再闭合（真实非法：CDATA 内容禁止 ]]>）
    '<xml><a><![CDATA[x]]>y]]></a></xml>',
    // 11. CDATA 正常闭合后残留文本（部分包裹）
    '<xml><a><![CDATA[<b>1</b>]]>x</a></xml>',
    // 12. CDATA 出现在元素级（非值包裹）
    '<xml><![CDATA[x]]></xml>',
  ]
  for (const xml of REJECT_FIXTURES) {
    assert.throws(() => parseV2Xml(xml), `必须拒绝: ${xml}`)
  }
  // 合法全包裹 CDATA 仍然放行（回归）
  assert.deepEqual(parseV2Xml('<xml><a><![CDATA[x]]></a></xml>'), { a: 'x' })
  assert.deepEqual(parseV2Xml('<xml><a><![CDATA[ ]]></a></xml>'), { a: ' ' })
  assert.deepEqual(parseV2Xml('<xml><a><![CDATA[&amp;]]></a></xml>'), { a: '&amp;' })
})

test('签名错误消息不泄露密钥或原始数据', () => {
  try {
    signV2Params('not-an-object', KEY)
    assert.fail('应当抛出错误')
  } catch (error) {
    assert.ok(!error.message.includes(KEY))
  }
})
