/** 发票 OCR 字段映射单测：node scripts/test-ocr-map.mjs */
import { mapVatInfos, parseGeneralText } from '../server/ocr.js'

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

// 通用文字：对账单/收据样式照片
const general = parseGeneralText(
  ['供应商月度对账单', '深圳市甜蜜科技有限公司', '统一社会信用代码：91440300MA5TEST88X', '合计金额：￥1,234.56', '2026年08月08日'].join('\n'),
)
console.log(JSON.stringify(general))
if (
  general.companyName !== '深圳市甜蜜科技有限公司' ||
  general.taxNo !== '91440300MA5TEST88X' ||
  general.amountYuan !== 1234.56 ||
  general.date !== '2026-08-08'
) {
  throw new Error('通用文字匹配失败')
}

// 通用文字：只有公司名，无税号（后续由字典补齐）
const onlyName = parseGeneralText('开票抬头：深圳市快乐食品有限公司\n金额 88.00')
console.log(JSON.stringify(onlyName))
if (onlyName.companyName !== '深圳市快乐食品有限公司' || onlyName.amountYuan !== 88) {
  throw new Error('公司名匹配失败')
}

console.log('OCR mapping OK')
