// 发票开票信息智能拆分（抬头/税号/金额）单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseInvoiceText } from '../src/utils/invoiceParser.js'

test('带标签：抬头/税号/金额', () => {
  const r = parseInvoiceText('抬头：北京某某科技有限公司\n税号：91110108MA01ABCD2X\n金额：500元')
  assert.equal(r.companyName, '北京某某科技有限公司')
  assert.equal(r.taxNo, '91110108MA01ABCD2X')
  assert.equal(r.amount, '500')
  assert.equal(r.titleType, 'company')
  assert.equal(r.matched, true)
})

test('自由文本：公司名 税号 金额', () => {
  const r = parseInvoiceText('上海某某贸易有限公司 91310115MA1K3XXXXX ¥1234.56')
  assert.equal(r.companyName, '上海某某贸易有限公司')
  assert.equal(r.taxNo, '91310115MA1K3XXXXX')
  assert.equal(r.amount, '1234.56')
})

test('金额带元后缀', () => {
  const r = parseInvoiceText('广州某某中心 91440101MA5XXXXX 88元')
  assert.equal(r.amount, '88')
})

test('个人抬头（无公司特征词）', () => {
  const r = parseInvoiceText('张三 13800138000 200元')
  assert.equal(r.companyName, '张三')
  assert.equal(r.titleType, 'personal')
  assert.equal(r.amount, '200')
})

test('邮箱识别', () => {
  const r = parseInvoiceText('北京某某科技有限公司 91110108MA01ABCD2X 500元 finance@example.com')
  assert.equal(r.email, 'finance@example.com')
})

test('15 位老税号', () => {
  const r = parseInvoiceText('抬头：某某公司 税号：110101123456789 金额 100')
  assert.equal(r.taxNo, '110101123456789')
})

test('空文本或无关文本不误识别', () => {
  assert.equal(parseInvoiceText('').matched, false)
  assert.equal(parseInvoiceText('今天天气不错').matched, false)
})

test('金额标签带人民币符号', () => {
  const r = parseInvoiceText('公司：某某科技 税号：91310115MA1K3XXXXX 价税合计：¥999.00')
  assert.equal(r.amount, '999.00')
  assert.equal(r.titleType, 'company')
})
