// 收件信息智能拆分：从一段文本（粘贴/OCR/语音）中提取 姓名 / 电话 / 地址
//
// 支持格式：
// - 空格/逗号/换行分隔：张三 13800138000 北京市朝阳区望京街道 xx 号
// - 带标签：收件人：张三 电话：13800138000 地址：北京市朝阳区…
// - 顺序任意：13800138000 张三 北京市…
// - 座机：010-12345678 / 02112345678 / (010)12345678
// - 称谓：张三先生 / 李女士

const PHONE_RE = /(?:\+?86[- ]?)?(?:1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8}|\(0\d{2,3}\)\d{7,8})/
const LABELED_PHONE_RE = /(?:电话|手机|联系方式|手机号|联系电话|号码|tel)[:：]?\s*(\+?86[- ]?)?(1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8})/i

const ADDRESS_HINT_RE = /(?:省|市|区|县|自治州|盟|镇|乡|街道|街|路|道|巷|村|庄|园|大厦|广场|中心|小区|苑|号楼|楼|栋|单元|室|号|弄|里|组)/

const LABELED_ADDRESS_RE = /(?:地址|收货地址|收件地址|邮寄地址|送货地址|位置)[:：]?\s*([^\n，,；;]+)/i
const LABELED_NAME_RE = /(?:收件人|收货人|联系人|姓名|名字|称呼)[:：]?\s*([\u4e00-\u9fa5·]{2,12})/i

/** 清理文本：统一分隔符、去标签噪声 */
function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[，,；;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取电话：优先带标签，其次全文本正则 */
function extractPhone(text) {
  const labeled = text.match(LABELED_PHONE_RE)
  if (labeled && labeled[2]) return labeled[2].replace(/[\s-]/g, '')
  const m = text.match(PHONE_RE)
  if (m) return m[0].replace(/[\s-]/g, '')
  return ''
}

/**
 * 提取地址：
 * - 带「地址」标签 → 标签后内容（清理尾部称谓）
 * - 否则取包含地址特征词的连续片段；从第一个「省/市」级词开始取到尾部
 */
function extractAddress(text, phone) {
  const labeled = text.match(LABELED_ADDRESS_RE)
  if (labeled && labeled[1]) {
    return labeled[1].replace(/先生|女士|小姐|师傅|同学|老师|哥|姐$/g, '').trim()
  }
  let rest = text
  if (phone) rest = rest.replace(phone, ' ')
  rest = rest
    .replace(/(?:电话|手机|联系方式|手机号|联系电话|号码|tel)[:：]?\s*/gi, ' ')
    .replace(/(?:收件人|收货人|联系人|姓名|名字|称呼)[:：]?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 找第一个省级/市级词（省优先，其次市/自治州/盟）
  const startMatch = rest.match(/(?:[\u4e00-\u9fa5]{1,4}?省|[\u4e00-\u9fa5]{2,4}?市|[\u4e00-\u9fa5]{2,4}?自治州|[\u4e00-\u9fa5]{2,4}?盟)/)
  let idx = startMatch ? rest.indexOf(startMatch[0]) : -1
  if (idx < 0) {
    const m = rest.search(ADDRESS_HINT_RE)
    idx = m
  }
  if (idx < 0) return ''
  let addr = rest.slice(idx)
  // 尾部若为「空格 + 独立 2-4 字中文（可带称谓）」，视为姓名而非地址的一部分
  addr = addr.replace(/\s+([\u4e00-\u9fa5]{2,4})(?:先生|女士|小姐|师傅|同学|老师|哥|姐)?\s*$/, '')
  addr = addr.replace(/先生|女士|小姐|师傅|同学|老师|哥|姐$/, '').replace(/[。.，,、\s]+$/, '').trim()
  return addr
}

/** 提取姓名：带标签优先；否则在剔除电话/地址后的剩余片段中找 2-4 字人名 */
function extractName(text, phone, address) {
  const labeled = text.match(LABELED_NAME_RE)
  if (labeled && labeled[1]) {
    return labeled[1].replace(/先生|女士|小姐|师傅|同学|老师|哥|姐/g, '').trim()
  }
  let rest = text
  if (phone) rest = rest.replace(phone, ' ')
  if (address) rest = rest.replace(address, '')
  rest = rest
    .replace(/(?:电话|手机|联系方式|手机号|联系电话|号码|tel)[:：]?\s*/gi, ' ')
    .replace(/(?:地址|收货地址|收件地址|邮寄地址|送货地址|位置)[:：]?\s*/gi, ' ')
    .replace(/(?:收件人|收货人|联系人|姓名|名字|称呼)[:：]?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 空格分隔时取第一段
  const seg = rest.split(' ')[0] || ''
  const m = seg.match(/^[\u4e00-\u9fa5·]{2,12}$/)
  if (m) return m[0].replace(/先生|女士|小姐|师傅|同学|老师|哥|姐$/g, '')
  // 无分隔：在剩余文本里找 2-4 字人名（不包含地址特征词）
  const nameMatch = rest.match(/[\u4e00-\u9fa5]{2,4}/)
  if (nameMatch && !ADDRESS_HINT_RE.test(nameMatch[0]) && !/电话|手机|地址/.test(nameMatch[0])) {
    return nameMatch[0]
  }
  return ''
}

/**
 * 智能拆分收件文本。
 * @param {string} text 原始文本
 * @returns {{ name: string, phone: string, address: string, matched: boolean }}
 *   matched=false 表示未能识别出任何字段
 */
export function parseRecipientText(text) {
  const cleaned = cleanText(text)
  if (!cleaned) return { name: '', phone: '', address: '', matched: false }
  const phone = extractPhone(cleaned)
  const address = extractAddress(cleaned, phone)
  // 只有「姓名+电话」「姓名+地址」或「电话+地址」等组合才算有效识别；
  // 单独一句日常文本（无电话无地址）不算命中
  const hasAddressOrPhone = Boolean(address || phone)
  const name = hasAddressOrPhone ? extractName(cleaned, phone, address) : ''
  const matched = hasAddressOrPhone && Boolean(phone || address || name)
  return { name, phone, address, matched }
}
