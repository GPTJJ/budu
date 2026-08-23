// 收件信息智能拆分（姓名/电话/地址）单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipientText } from '../src/utils/addressParser.js'

test('空格分隔：姓名 电话 地址', () => {
  const r = parseRecipientText('张三 13800138000 北京市朝阳区望京街道阜通东大街6号院3号楼1201室')
  assert.equal(r.name, '张三')
  assert.equal(r.phone, '13800138000')
  assert.ok(r.address.includes('北京市朝阳区'))
  assert.equal(r.matched, true)
})

test('带标签：收件人/电话/地址', () => {
  const r = parseRecipientText('收件人：李四\n电话：13912345678\n地址：上海市浦东新区张江路88号')
  assert.equal(r.name, '李四')
  assert.equal(r.phone, '13912345678')
  assert.ok(r.address.includes('上海市浦东新区'))
})

test('逗号分隔且顺序任意（电话在前）', () => {
  const r = parseRecipientText('13712345678，王五，广州市天河区体育西路123号')
  assert.equal(r.phone, '13712345678')
  assert.equal(r.name, '王五')
  assert.ok(r.address.includes('广州市天河区'))
})

test('座机号码', () => {
  const r = parseRecipientText('赵六 010-67891234 北京市海淀区中关村大街1号')
  assert.equal(r.phone, '01067891234')
  assert.equal(r.name, '赵六')
})

test('带称谓的姓名', () => {
  const r = parseRecipientText('张三先生 13800138000 北京市朝阳区')
  assert.equal(r.name, '张三')
})

test('文本内嵌电话（无空格分隔）', () => {
  const r = parseRecipientText('深圳市南山区科技园路100号 陈七 13512345678')
  assert.equal(r.phone, '13512345678')
  assert.equal(r.name, '陈七')
  assert.ok(r.address.includes('深圳市南山区'))
})

test('OCR 常见多行文本', () => {
  const r = parseRecipientText('周八\n联系电话 13612345678\n收货地址 杭州市西湖区文三路 500 号')
  assert.equal(r.name, '周八')
  assert.equal(r.phone, '13612345678')
  assert.ok(r.address.includes('杭州市西湖区'))
})

test('空文本或无关文本不误识别', () => {
  assert.equal(parseRecipientText('').matched, false)
  const r = parseRecipientText('今天天气不错')
  assert.equal(r.matched, false)
})

test('11 位手机号与 1 开头的座机区分', () => {
  // 1012345678 是 10 位（座机风格），不应被当作手机号匹配成 11 位
  const r = parseRecipientText('钱九 01012345678 北京市东城区')
  assert.equal(r.phone, '01012345678')
})

test('手机号带横杠（135-2375-7594）', () => {
  const r = parseRecipientText('古月 135-2375-7594 河南省武冈市上店镇廖庄壹号')
  assert.equal(r.phone, '13523757594')
  assert.equal(r.name, '古月')
  assert.ok(r.address.includes('河南省武冈市'))
})

test('紧凑无分隔：地址收件人手机号连写', () => {
  // 录屏实际场景：无空格无冒号，姓名/电话标签紧贴地址尾部
  const r = parseRecipientText('河南省武冈市上店镇廖庄壹号收件人古月手机号135-2375-7594')
  assert.equal(r.name, '古月')
  assert.equal(r.phone, '13523757594')
  assert.equal(r.address, '河南省武冈市上店镇廖庄壹号')
})

test('手机号空格分隔（135 2375 7594）', () => {
  const r = parseRecipientText('135 2375 7594 古月 河南省武冈市')
  assert.equal(r.phone, '13523757594')
  assert.equal(r.name, '古月')
})
