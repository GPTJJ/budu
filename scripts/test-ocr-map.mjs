/** 发票 OCR 字段映射单测：node scripts/test-ocr-map.mjs */
import { mapVatInfos } from '../server/ocr.js'

const sample = [
  { Name: '发票抬头', Value: '深圳市腾讯计算机系统有限公司' },
  { Name: '购买方识别号', Value: '91440300MA5FG0WX8K' },
  { Name: '价税合计(小写)', Value: '￥1,234.56' },
  { Name: '开票日期', Value: '2026年08月08日' },
]
const r = mapVatInfos(sample)
console.log(JSON.stringify(r))
if (
  r.companyName !== '深圳市腾讯计算机系统有限公司' ||
  r.taxNo !== '91440300MA5FG0WX8K' ||
  r.amountYuan !== 1234.56 ||
  r.titleType !== 'company'
) {
  throw new Error('公司发票映射失败')
}

const personal = mapVatInfos([
  { Name: '发票抬头', Value: '张三' },
  { Name: '价税合计(小写)', Value: '100.00' },
])
console.log(JSON.stringify(personal))
if (personal.titleType !== 'personal' || personal.taxNo !== '' || personal.amountYuan !== 100) {
  throw new Error('个人发票映射失败')
}

const empty = mapVatInfos([])
if (empty.companyName !== '' || empty.taxNo !== '' || empty.amountYuan !== null) {
  throw new Error('空结果映射失败')
}

console.log('OCR mapping OK')
