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

test('HMAC-SHA256 签名：ASCII 排序 + 剔除空值与 sign/key + 大写', () => {
  const params = {
    appid: 'wx8888888888888888',
    mch_id: '1900000109',
    out_trade_no: 'BUDUPAY123',
    total_fee: '7200',
    nonce_str: 'abc123',
    sign_type: 'HMAC-SHA256',
  }
  const sign = signV2Params(params, KEY, WECHAT_V2_SIGN_HMAC_SHA256)
  assert.match(sign, /^[0-9A-F]{64}$/)
  // 验证：重新签名必须一致
  assert.equal(sign, signV2Params({ ...params, sign }, KEY, WECHAT_V2_SIGN_HMAC_SHA256))
  // 空值与 sign/key 不影响结果
  assert.equal(sign, signV2Params({ ...params, empty: '', sign: 'x', key: 'y' }, KEY, WECHAT_V2_SIGN_HMAC_SHA256))
  // 乱序参数签名一致（ASCII 排序）
  const shuffled = { total_fee: params.total_fee, nonce_str: params.nonce_str, out_trade_no: params.out_trade_no, mch_id: params.mch_id, appid: params.appid, sign_type: params.sign_type }
  assert.equal(sign, signV2Params(shuffled, KEY, WECHAT_V2_SIGN_HMAC_SHA256))
})

test('MD5 签名与验签', () => {
  const params = { a: '1', b: '2', c: '3' }
  const sign = signV2Params(params, KEY, WECHAT_V2_SIGN_MD5)
  assert.match(sign, /^[0-9A-F]{32}$/)
  assert.equal(verifyV2Signature({ ...params, sign }, KEY, WECHAT_V2_SIGN_MD5), true)
})

test('验签：错误密钥/篡改字段/缺失签名一律失败', () => {
  const params = { appid: 'wx1', mch_id: 'm1', out_trade_no: 'o1', total_fee: '100' }
  const sign = signV2Params(params, KEY)
  assert.equal(verifyV2Signature({ ...params, sign }, KEY), true)
  assert.equal(verifyV2Signature({ ...params, sign }, 'wrong-key-1234567890abcdef'), false)
  assert.equal(verifyV2Signature({ ...params, total_fee: '999', sign }, KEY), false)
  assert.equal(verifyV2Signature({ ...params }, KEY), false)
  assert.equal(verifyV2Signature(null, KEY), false)
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
  assert.throws(() => parseV2Xml('<xml><![CDATA[<a>]]></xml>'))
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

test('XML 拒绝超大响应', () => {
  const huge = `<xml><a>${'x'.repeat(WECHAT_V2_MAX_XML_BYTES + 1)}</a></xml>`
  assert.throws(() => parseV2Xml(huge))
})

test('XML 保留五标准实体之外的值原样（未知实体已在前面拒绝）', () => {
  const parsed = parseV2Xml('<xml><a>100&amp;1</a><b>2</b></xml>')
  assert.equal(parsed.a, '100&1')
  assert.equal(parsed.b, '2')
})

test('签名错误消息不泄露密钥或原始数据', () => {
  try {
    signV2Params('not-an-object', KEY)
    assert.fail('应当抛出错误')
  } catch (error) {
    assert.ok(!error.message.includes(KEY))
  }
})
