/** 发票图片 OCR：调用腾讯云「增值税发票识别」提取抬头/税号/金额
 *  未配置 TENCENT_OCR_SECRET_ID/KEY 时返回 501，前端可继续手动填写 */

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
  if (m) raw = m[2]
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
    const code = err && err.code ? `（${err.code}）` : ''
    const e = new Error(`发票识别失败${code}：${(err && err.message) || '腾讯云 OCR 调用异常'}`)
    e.status = 502
    throw e
  }
  const infos = (resp && (resp.VatInvoiceInfos || resp.vatInvoiceInfos)) || []
  const extracted = mapVatInfos(infos)
  if (!extracted.companyName && !extracted.taxNo && extracted.amountYuan == null) {
    const e = new Error('未识别到发票关键信息，请确认图片清晰、发票完整（已自动转 JPG，可重新拍一张）')
    e.status = 422
    throw e
  }
  return { extracted }
}
