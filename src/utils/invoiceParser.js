// 发票开票信息智能拆分：从一段文本（粘贴/OCR/语音）中提取 抬头/税号/金额
//
// 支持格式：
// - 带标签：抬头：北京某某科技有限公司 税号：91110108MA01XXXXXX 金额：500元
// - 自由文本：北京某某科技有限公司 91110108MA01XXXXXX 500
// - 金额带符号：¥500.00 / 500元 / 金额 500
// - 税号：18 位统一社会信用代码（数字+大写字母）或 15 位老税号

const TAX_NO_RE = /(?:\d{15}|\d{18}|[0-9A-HJ-NPQRTUWXY]{18})/i
const LABELED_TAX_RE = /(?:税号|纳税人识别号|统一社会信用代码|信用代码|识别号)[:：]?\s*([0-9A-HJ-NPQRTUWXY]{15,18})/i

const LABELED_NAME_RE = /(?:(?:公司名称|购买方名称|购买方|单位名称|开票名称|抬头|开票抬头|发票抬头|名称)[:：]?|公司[:：])\s*([^\n，,；;]+?)(?=\s*(?:税号|纳税人识别号|统一社会信用代码|信用代码|识别号|金额|开票金额|价税合计|合计|电话|手机|邮箱|$))/i

const LABELED_AMOUNT_RE = /(?:金额|开票金额|价税合计|合计金额|合计|小写金额)[:：]?[¥￥]?\s*(\d+(?:\.\d{1,2})?)/i
const SYMBOL_AMOUNT_RE = /[¥￥]\s*(\d+(?:\.\d{1,2})?)/

const COMPANY_HINT_RE = /(公司|企业|集团|工作室|中心|厂|商行|事务所|经营部|店|医院|学校|研究院)/

const EMAIL_RE = /[\w.-]+@[\w.-]+\.\w+/

/** 清理文本 */
function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[，,；;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取税号：优先带标签，其次全文本（排除金额/日期等数字干扰） */
function extractTaxNo(text) {
  const labeled = text.match(LABELED_TAX_RE)
  if (labeled && labeled[1]) return labeled[1].toUpperCase()
  // 全文本找 18 位（含大写字母）或 15 位数字
  const m = text.match(/\b([0-9A-HJ-NPQRTUWXY]{18})\b/i) || text.match(/\b(\d{15})\b/)
  return m ? m[1].toUpperCase() : ''
}

/** 提取金额（元） */
function extractAmount(text) {
  const labeled = text.match(LABELED_AMOUNT_RE)
  if (labeled && labeled[1]) return labeled[1]
  const sym = text.match(SYMBOL_AMOUNT_RE)
  if (sym && sym[1]) return sym[1]
  const plain = text.match(/(\d+(?:\.\d{1,2})?)\s*元(?!\d)/)
  if (plain && plain[1]) return plain[1]
  return ''
}

/** 提取抬头名称：带标签优先；否则取含公司特征词的最长片段 */
function extractCompanyName(text, taxNo, amount) {
  const labeled = text.match(LABELED_NAME_RE)
  if (labeled && labeled[1]) {
    return labeled[1].trim()
  }
  let rest = text
  if (taxNo) rest = rest.replace(taxNo, ' ')
  if (amount) rest = rest.replace(amount, ' ')
  rest = rest
    .replace(/(?:税号|纳税人识别号|统一社会信用代码|信用代码|识别号)[:：]?\s*/gi, ' ')
    .replace(/(?:抬头|开票抬头|发票抬头|公司名称|购买方名称|购买方|单位名称|开票名称|名称)[:：]?\s*/gi, ' ')
    .replace(/(?:金额|开票金额|价税合计|合计金额|合计|小写金额)[:：]?[¥￥]?\s*/gi, ' ')
    .replace(/[¥￥]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 取含公司特征词的最长连续片段
  const segments = rest.split(' ')
  let best = ''
  for (const seg of segments) {
    if (seg.length >= 2 && seg.length <= 60 && COMPANY_HINT_RE.test(seg)) {
      if (seg.length > best.length) best = seg
    }
  }
  if (best) return best
  // 无公司特征词：仅接受 2-4 字纯中文（个人姓名/简短抬头）；排除纯数字（电话等）与长句子
  for (const seg of segments) {
    if (/^\d{7,}$/.test(seg)) continue
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(seg) && seg.length > best.length) best = seg
  }
  return best
}

/**
 * 智能拆分发票开票文本。
 * @param {string} text 原始文本
 * @returns {{ companyName: string, taxNo: string, amount: string, email: string, titleType: 'company'|'personal', matched: boolean }}
 */
export function parseInvoiceText(text) {
  const cleaned = cleanText(text)
  if (!cleaned) return { companyName: '', taxNo: '', amount: '', email: '', titleType: 'company', matched: false }
  const taxNo = extractTaxNo(cleaned)
  const amount = extractAmount(cleaned)
  const companyName = extractCompanyName(cleaned, taxNo, amount)
  const emailMatch = cleaned.match(EMAIL_RE)
  const email = emailMatch ? emailMatch[0] : ''
  const matched = Boolean(taxNo || amount || companyName || email)
  // 识别到公司特征词 → 公司抬头；纯姓名 → 个人
  // 带「公司/购买方/单位」标签或名称含公司特征词 → 公司抬头；否则视为个人
  const labeledCompany = /(?:公司|购买方|单位)[:：]/.test(cleaned)
  const titleType =
    companyName && (labeledCompany || COMPANY_HINT_RE.test(companyName)) ? 'company' : companyName ? 'personal' : 'company'
  return { companyName, taxNo, amount, email, titleType, matched }
}
