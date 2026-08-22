// 微信支付 APIv2 签名与安全 XML 工具（付款码支付 MICROPAY 场景）
//
// 安全约定：
// - 签名：APIv2 密钥，优先 HMAC-SHA256（sign_type=HMAC-SHA256），兼容 MD5。
// - XML：仅支持微信 V2 的扁平 <xml><k>v</k>...</xml> 结构；严格拒绝 DOCTYPE、
//   外部实体、内联实体与超大响应；仅解码五个标准实体。
// - 任何函数都不得把签名密钥、原始 XML 或付款码写入日志/错误消息。
import crypto from 'node:crypto'

export const WECHAT_V2_SIGN_MD5 = 'MD5'
export const WECHAT_V2_SIGN_HMAC_SHA256 = 'HMAC-SHA256'

// 响应体上限（1MB）。微信 V2 正常响应远小于此，用于防超大响应攻击。
export const WECHAT_V2_MAX_XML_BYTES = 1024 * 1024

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const ENTITY_RE = /&(amp|lt|gt|quot|apos);/g

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按微信 V2 规则构造待签名串并签名。
 * 规则：键 ASCII 升序；剔除空值与 sign/key；拼接 k=v&...&key=APIv2密钥。
 * @param {Record<string, string|number>} params
 * @param {string} apiV2Key
 * @param {'MD5'|'HMAC-SHA256'} [signType]
 * @returns {string} 大写十六进制签名
 */
export function signV2Params(params, apiV2Key, signType = WECHAT_V2_SIGN_HMAC_SHA256) {
  if (!isPlainObject(params)) throw new Error('signV2Params: params 必须是对象')
  if (typeof apiV2Key !== 'string' || apiV2Key.length === 0) throw new Error('signV2Params: APIv2 密钥缺失')
  const entries = Object.entries(params)
    .filter(([key, value]) => value !== undefined && value !== null && String(value) !== '' && key !== 'sign' && key !== 'key')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const stringA = entries.map(([key, value]) => `${key}=${value}`).join('&')
  const raw = `${stringA}&key=${apiV2Key}`
  if (signType === WECHAT_V2_SIGN_MD5) {
    return crypto.createHash('md5').update(raw, 'utf8').digest('hex').toUpperCase()
  }
  return crypto.createHmac('sha256', apiV2Key).update(raw, 'utf8').digest('hex').toUpperCase()
}

/**
 * 常量时间比较验证响应签名。
 * @param {Record<string, string>} xmlParams 解析后的响应参数（含 sign）
 * @param {string} apiV2Key
 * @param {'MD5'|'HMAC-SHA256'} [signType]
 */
export function verifyV2Signature(xmlParams, apiV2Key, signType = WECHAT_V2_SIGN_HMAC_SHA256) {
  if (!isPlainObject(xmlParams)) return false
  const sign = String(xmlParams.sign || '')
  if (!sign) return false
  let expected
  try {
    expected = signV2Params(xmlParams, apiV2Key, signType)
  } catch {
    return false
  }
  const a = Buffer.from(sign)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * 构造微信 V2 扁平 XML。
 * 仅接受字符串/数字/布尔值；拒绝嵌套对象与数组（微信 V2 参数均为扁平标量）。
 */
export function buildV2Xml(params) {
  if (!isPlainObject(params)) throw new Error('buildV2Xml: 参数必须是对象')
  const escape = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  const parts = ['<xml>']
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') throw new Error(`buildV2Xml: 不支持嵌套参数 ${key}`)
    parts.push(`<${key}>${escape(value)}</${key}>`)
  }
  parts.push('</xml>')
  return parts.join('')
}

/**
 * 严格解析微信 V2 扁平 XML。
 * 校验顺序：
 *  1. 长度上限；
 *  2. 拒绝 DOCTYPE / ENTITY / CDATA / 注释 / PI / 属性 / 嵌套元素；
 *  3. 仅解析 <xml> 内扁平 <k>v</k> 对；
 *  4. 仅解码五个标准实体，拒绝数字实体与未知实体。
 * @param {string} xml
 * @returns {Record<string, string>}
 */
export function parseV2Xml(xml) {
  if (typeof xml !== 'string' || xml.length === 0) throw new Error('XML 响应为空')
  if (Buffer.byteLength(xml, 'utf8') > WECHAT_V2_MAX_XML_BYTES) throw new Error('XML 响应超出大小限制')
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--|<\?|<!\[/i.test(xml)) {
    throw new Error('XML 包含禁止的声明或实体')
  }
  const trimmed = xml.trim()
  if (!trimmed.startsWith('<xml>') || !trimmed.endsWith('</xml>')) throw new Error('XML 根节点不是 <xml>')
  const body = trimmed.slice(5, -6)
  if (/<[^>]*\s[^>]*>/.test(body) && /<[a-zA-Z0-9_-]+\s+[^>]*>/.test(body)) throw new Error('XML 不支持属性')
  if (/<[a-zA-Z0-9_-]+>.*?<[a-zA-Z0-9_-]+>/s.test(body)) {
    // 逐对校验：先按扁平模式提取，若出现未闭合或嵌套再由提取逻辑拒绝
  }
  const out = {}
  const pairRe = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g
  let match
  let consumed = 0
  const used = new Set()
  while ((match = pairRe.exec(body)) !== null) {
    const [, key, rawValue] = match
    if (used.has(key)) throw new Error('XML 包含重复字段')
    used.add(key)
    if (/<[a-zA-Z0-9_-]+>/.test(rawValue)) throw new Error('XML 不支持嵌套元素')
    if (/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(rawValue)) {
      const unknown = rawValue.match(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g) || []
      const safe = unknown.filter((entity) => ENTITY_MAP[entity.slice(1, -1)] !== undefined)
      if (safe.length !== unknown.length) throw new Error('XML 包含不支持的实体引用')
    }
    out[key] = rawValue.replace(ENTITY_RE, (_, name) => ENTITY_MAP[name])
    consumed = match.index + match[0].length
  }
  const leftover = body.slice(consumed).replace(/[\s]+/g, '')
  if (leftover) throw new Error('XML 包含无法解析的内容')
  return out
}
