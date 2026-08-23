/** 图片文字 OCR：优先「增值税发票识别」，非标准版式自动回退「通用印刷体识别」，
 *  从照片文字中匹配抬头/税号/金额，并结合系统开票公司字典互相补齐
 *  未配置 TENCENT_OCR_SECRET_ID/KEY 时返回 501，前端可继续手动填写 */
import { prisma } from './pg.js'

export function ocrConfigured() {
  return Boolean(process.env.TENCENT_OCR_SECRET_ID && process.env.TENCENT_OCR_SECRET_KEY)
}

const FIELD_PATTERNS = {
  companyName: [/发票抬头/i, /购买方名称/i, /购买方信息/i, /购买方纳税人名称/i, /名称/i],
  taxNo: [/购买方识别号/i, /纳税人识别号/i, /购买方税号/i, /税号/i, /统一社会信用代码/i, /信用代码/i],
  amount: [/价税合计\(小写\)/i, /价税合计/i, /合计金额\(小写\)/i, /小写金额/i],
  date: [/开票日期/i],
}

const NAME_EXCLUDE = [/识别号/i, /税号/i, /号码/i, /账号/i, /开户行/i, /地址/i, /电话/i]

function parseAmount(text) {
  const m = String(text || '')
    .replace(/[￥¥,\s]/g, '')
    .match(/\d+(\.\d{1,2})?/)
  return m ? Number(m[0]) : null
}

/** 从通用 OCR 文本中匹配抬头/税号/金额/日期（纯函数，便于测试） */
export function parseGeneralText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const joined = lines.join('\n')

  let taxNo = ''
  const taxPatterns = [
    /(?:统一社会信用代码|纳税人识别号|税号|信用代码)[:：]?\s*([0-9A-Za-z]{15,20})/i,
    /(?:^|\n)\s*([0-9A-Z]{18})\s*(?:\n|$)/,
    /\b([0-9A-Z]{18})\b/,
  ]
  for (const p of taxPatterns) {
    const m = joined.match(p)
    if (m) {
      taxNo = m[1].toUpperCase()
      break
    }
  }

  let companyName = ''
  const namePatterns = [
    /(?:发票抬头|开票抬头|抬头|公司名称|抬头名称|购买方名称|购买方|单位名称|开票名称)[:：]?\s*([^\n]{2,50})/i,
  ]
  for (const p of namePatterns) {
    const m = joined.match(p)
    if (m && !/税号|识别号|信用代码/.test(m[1])) {
      companyName = m[1].replace(/[，。、\s]+$/, '').trim()
      break
    }
  }
  if (!companyName) {
    const cand = lines.find(
      (l) =>
        l.length >= 4 &&
        l.length <= 40 &&
        /(公司|企业|集团|工作室|中心|厂|商行|事务所|经营部)/.test(l) &&
        !/税号|识别号|信用代码|电话|地址|银行|发票号码/.test(l),
    )
    if (cand) companyName = cand.replace(/^(?:开票)?(?:抬头|名称|单位|公司名称)[:：]\s*/, '').trim()
  }
  if (!companyName && taxNo) {
    const idx = lines.findIndex((l) => l.includes(taxNo))
    if (idx > 0 && lines[idx - 1].length <= 40 && !/税号|识别号|信用代码/.test(lines[idx - 1])) {
      companyName = lines[idx - 1]
    }
  }

  let amountYuan = null
  const amountPatterns = [
    /(?:价税合计|合计金额|合计|金额|总计|应收|实收|小写金额)[:：]?[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/,
  ]
  for (const p of amountPatterns) {
    const m = joined.match(p)
    if (m) {
      const v = Number(m[1].replace(/,/g, ''))
      if (!Number.isNaN(v)) {
        amountYuan = v
        break
      }
    }
  }

  let date = ''
  const dm = joined.match(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/)
  if (dm) date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`

  return {
    titleType: taxNo || companyName ? 'company' : 'personal',
    companyName,
    taxNo,
    amountYuan,
    date,
  }
}

/** 结合系统开票公司字典：公司名 ↔ 税号 互相补齐 */
async function matchCompany(extracted) {
  const out = { ...extracted }
  try {
    if (out.companyName && !out.taxNo) {
      const hit = await prisma.invoiceCompany.findUnique({ where: { name: out.companyName } })
      if (hit && hit.taxNo) out.taxNo = hit.taxNo
    }
    if (!out.companyName && out.taxNo) {
      const hit = await prisma.invoiceCompany.findFirst({ where: { taxNo: out.taxNo }, take: 1 })
      if (hit && hit.name) out.companyName = hit.name
    }
  } catch {
    /* 字典查询失败不影响识别结果 */
  }
  out.titleType = out.taxNo || out.companyName ? 'company' : 'personal'
  return out
}

/** 将腾讯云 VatInvoiceOCR 返回的 Name/Value 数组映射为表单字段（纯函数，便于测试） */
export function mapVatInfos(infos) {
  const rows = Array.isArray(infos) ? infos : []
  const get = (patterns, exclude = []) => {
    for (const p of patterns) {
      const hit = rows.find((r) => p.test(String(r.Name || '')) && !exclude.some((x) => x.test(String(r.Name || ''))))
      if (hit && String(hit.Value || '').trim()) return String(hit.Value).trim()
    }
    return ''
  }
  const companyName = get(FIELD_PATTERNS.companyName, NAME_EXCLUDE)
  const taxNo = get(FIELD_PATTERNS.taxNo)
  const amountText = get(FIELD_PATTERNS.amount)
  const date = get(FIELD_PATTERNS.date)
  return {
    titleType: taxNo ? 'company' : 'personal',
    companyName,
    taxNo,
    amountYuan: parseAmount(amountText),
    date,
  }
}

/** 解析图片 base64 并调用腾讯云增值税发票识别 */
export async function extractInvoiceFromBase64(imageBase64) {
  if (!ocrConfigured()) {
    const e = new Error('未配置腾讯云 OCR 密钥（TENCENT_OCR_SECRET_ID/KEY）')
    e.status = 501
    throw e
  }
  let raw = String(imageBase64 || '')
  const m = raw.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)
  if (m) raw = m[1]
  raw = raw.replace(/\s+/g, '')
  if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) {
    const e = new Error('图片数据无法读取，请重新拍摄或从相册选择')
    e.status = 400
    throw e
  }
  const buf = Buffer.from(raw, 'base64')
  if (buf.length === 0) {
    const e = new Error('图片内容为空，请重新选择图片')
    e.status = 400
    throw e
  }
  if (buf.length > 8 * 1024 * 1024) {
    const e = new Error('图片不能超过 8MB')
    e.status = 400
    throw e
  }
  const ftyp = buf.subarray(4, 12).toString('latin1')
  const brand = buf.subarray(8, 12).toString('latin1')
  if (ftyp.includes('ftyp') && /heic|heif|mif1/i.test(brand)) {
    const e = new Error('检测到手机 HEIC 原图，请下拉刷新页面后重试（新版会自动转换为 JPG）')
    e.status = 415
    throw e
  }
  const { ocr } = await import('tencentcloud-sdk-nodejs-ocr')
  const client = new ocr.v20181119.Client({
    credential: {
      secretId: process.env.TENCENT_OCR_SECRET_ID,
      secretKey: process.env.TENCENT_OCR_SECRET_KEY,
    },
    region: process.env.TENCENT_OCR_REGION || 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } },
  })
  let resp
  try {
    resp = await client.VatInvoiceOCR({ ImageBase64: raw })
  } catch (err) {
    resp = null
  }
  const infos = (resp && (resp.VatInvoiceInfos || resp.vatInvoiceInfos)) || []
  let extracted = mapVatInfos(infos)
  const enough = Boolean(extracted.companyName && extracted.taxNo && extracted.amountYuan != null)
  if (!enough) {
    // 非标准发票/收据/对账单照片：回退到通用印刷体识别，再从文字中匹配
    let general
    try {
      general = await client.GeneralBasicOCR({ ImageBase64: raw })
    } catch (err) {
      const code = err && err.code ? `（${err.code}）` : ''
      const e = new Error(`文字识别失败${code}：${(err && err.message) || '腾讯云 OCR 调用异常'}`)
      e.status = 502
      throw e
    }
    const text = ((general && (general.TextDetections || general.textDetections)) || [])
      .map((t) => t.DetectedText || t.detectedText || '')
      .join('\n')
    const parsed = parseGeneralText(text)
    extracted = {
      titleType: extracted.titleType || parsed.titleType,
      companyName: extracted.companyName || parsed.companyName,
      taxNo: extracted.taxNo || parsed.taxNo,
      amountYuan: extracted.amountYuan != null ? extracted.amountYuan : parsed.amountYuan,
      date: extracted.date || parsed.date,
    }
  }
  extracted = await matchCompany(extracted)
  if (!extracted.companyName && !extracted.taxNo && extracted.amountYuan == null) {
    const e = new Error('未识别到抬头/税号/金额，请确认照片文字清晰完整')
    e.status = 422
    throw e
  }
  return { extracted }
}

/** 图片文字识别（通用印刷体）：返回纯文本，供前端智能拆分（邮寄收件信息等） */
export async function generalOcrText(imageBase64) {
  const raw = String(imageBase64 || '')
  if (!/^data:image\/(png|jpeg|jpg|webp|bmp);base64,/.test(raw) && !/^[A-Za-z0-9+/=]+$/.test(raw)) {
    const e = new Error('图片数据格式不正确')
    e.status = 400
    throw e
  }
  const base64 = raw.includes(',') ? raw.split(',')[1] : raw
  const buf = Buffer.from(base64, 'base64')
  if (buf.length === 0) {
    const e = new Error('图片内容为空，请重新选择图片')
    e.status = 400
    throw e
  }
  if (buf.length > 8 * 1024 * 1024) {
    const e = new Error('图片不能超过 8MB')
    e.status = 400
    throw e
  }
  if (!ocrConfigured()) {
    const e = new Error('图片识别未配置（缺少腾讯云 OCR 密钥）')
    e.status = 501
    throw e
  }
  const { ocr } = await import('tencentcloud-sdk-nodejs-ocr')
  const client = new ocr.v20181119.Client({
    credential: {
      secretId: process.env.TENCENT_OCR_SECRET_ID,
      secretKey: process.env.TENCENT_OCR_SECRET_KEY,
    },
    region: process.env.TENCENT_OCR_REGION || 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } },
  })
  let resp
  try {
    resp = await client.GeneralBasicOCR({ ImageBase64: base64 })
  } catch (err) {
    const code = err && err.code ? `（${err.code}）` : ''
    const e = new Error(`文字识别失败${code}：${(err && err.message) || '腾讯云 OCR 调用异常'}`)
    e.status = 502
    throw e
  }
  const text = ((resp && (resp.TextDetections || resp.textDetections)) || [])
    .map((t) => t.DetectedText || t.detectedText || '')
    .filter(Boolean)
    .join('\n')
  if (!text.trim()) {
    const e = new Error('未识别到文字，请确认照片文字清晰完整')
    e.status = 422
    throw e
  }
  return { text: text.trim() }
}
