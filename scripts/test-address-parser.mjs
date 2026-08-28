import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRecipientFields, normalizeRecipientText, parseRecipientText } from '../src/utils/addressParser.js'

const expectFields = (input, expected) => {
  const actual = parseRecipientText(input)
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key)
  return actual
}

test('primary structure: multiline name/address/phone/product note', () => {
  expectFields(
    '童小诗\n福建省三明市永安市星河花园12栋二单元1001\n18250577559\n92生巧，柚子生巧，赠麻薯豆',
    {
      recipientName: '童小诗',
      phone: '18250577559',
      address: '福建省三明市永安市星河花园12栋二单元1001',
      note: '92生巧，柚子生巧，赠麻薯豆',
      matched: true,
    },
  )
})

test('name/phone/address order variations', () => {
  const address = '北京市朝阳区望京街道阜通东大街6号院3号楼1201室'
  for (const input of [
    `张三 13800138000 ${address}`,
    `13800138000 张三 ${address}`,
    `${address}\n张三\n13800138000`,
    `张三\n13800138000\n${address}`,
  ]) {
    expectFields(input, { recipientName: '张三', phone: '13800138000', address })
  }
})

test('labeled and compact inputs use the same rules', () => {
  expectFields('收件人：李四\n电话：13912345678\n地址：上海市浦东新区张江路88号', {
    recipientName: '李四',
    phone: '13912345678',
    address: '上海市浦东新区张江路88号',
  })
  expectFields('河南省武冈市上店镇廖庄壹号收件人古月手机号135-2375-7594', {
    recipientName: '古月',
    phone: '13523757594',
    address: '河南省武冈市上店镇廖庄壹号',
  })
})

test('phone normalization supports spaces, hyphens and full-width digits', () => {
  expectFields('古月\n135 2375 7594\n河南省武冈市上店镇27号', { phone: '13523757594' })
  expectFields('古月\n135-2375-7594\n河南省武冈市上店镇27号', { phone: '13523757594' })
  expectFields('古月\n１３５２３７５７５９４\n河南省武冈市上店镇27号', { phone: '13523757594' })
})

test('address keeps building/unit/room facts and stops before note', () => {
  expectFields('王五\n13712345678\n广州市天河区体育西路12栋2单元1001\n巧克力2盒，下午送', {
    address: '广州市天河区体育西路12栋2单元1001',
    note: '巧克力2盒，下午送',
  })
  expectFields('王五，13712345678，广州市天河区体育西路27号，蛋糕1个', {
    address: '广州市天河区体育西路27号',
    note: '蛋糕1个',
  })
})

test('name lengths 2/3/4 Chinese characters', () => {
  for (const name of ['张三', '林小满', '欧阳小满']) {
    expectFields(`${name}\n13800138000\n北京市海淀区中关村大街1号`, { recipientName: name })
  }
})

test('multiple phones prefer labeled contact and preserve the other number', () => {
  const result = parseRecipientText('备用 13900001111\n联系人：张三\n联系电话：13800138000\n北京市海淀区中关村大街1号')
  assert.equal(result.phone, '13800138000')
  assert.match(result.note, /13900001111/)
})

test('bank card and order/product numbers are never recognized as phone', () => {
  const result = parseRecipientText('银行卡 6222030405017853986\n电话 13800138000\n北京市海淀区中关村大街1号\n订单 202608280001')
  assert.equal(result.phone, '13800138000')
  assert.doesNotMatch(result.phone, /6222/)
  const productOnly = parseRecipientText('商品 1380013800 盒')
  assert.equal(productOnly.phone, '')
})

test('note optional and partial parse remains fail-safe', () => {
  assert.equal(parseRecipientText('张三\n13800138000\n北京市海淀区中关村大街1号').note, '')
  expectFields('北京市海淀区中关村大街1号', { recipientName: '', phone: '', address: '北京市海淀区中关村大街1号' })
  expectFields('13800138000\n北京市海淀区中关村大街1号', { recipientName: '', phone: '13800138000', address: '北京市海淀区中关村大街1号' })
  const ambiguous = parseRecipientText('今天天气不错')
  assert.equal(ambiguous.matched, false)
  assert.equal(ambiguous.recipientName, '')
  assert.equal(ambiguous.phone, '')
  assert.equal(ambiguous.address, '')
  assert.equal(ambiguous.note, '')
  assert.equal(ambiguous.unparsedText, '今天天气不错')
})

test('CRLF, spacing and punctuation normalization preserves field boundaries', () => {
  assert.equal(normalizeRecipientText(' 张三\r\n 138 0013 8000 \r\n 北京市朝阳区XX路2号 '), '张三\n138 0013 8000\n北京市朝阳区XX路2号')
  expectFields('张三；138-0013-8000；北京市朝阳区XX路2号；备注：晚间配送', {
    recipientName: '张三',
    phone: '13800138000',
    address: '北京市朝阳区XX路2号',
    note: '晚间配送',
  })
})

test('existing user-entered values are never overwritten', () => {
  const parsed = parseRecipientText('李四\n13912345678\n上海市浦东新区张江路88号\n蛋糕1个')
  assert.deepEqual(
    mergeRecipientFields(
      { recipientName: '手工姓名', phone: '13600000000', address: '手工地址', note: '手工备注' },
      parsed,
    ),
    { recipientName: '手工姓名', phone: '13600000000', address: '手工地址', note: '手工备注' },
  )
  assert.deepEqual(
    mergeRecipientFields({ recipientName: '', phone: '', address: '', note: '' }, parsed),
    { recipientName: '李四', phone: '13912345678', address: '上海市浦东新区张江路88号', note: '蛋糕1个' },
  )
})
