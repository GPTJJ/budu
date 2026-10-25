import test from 'node:test'
import assert from 'node:assert/strict'
import * as notifications from '../server/store-service-notifications.js'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'

const fields = { thing2: 'invoiceTitle', amount3: 'amount', time4: 'submittedAt', thing5: 'invoiceReceivedNote' }
const template = { id: 'synthetic-invoice-received-template-66798', verified: true, semantic: 'INVOICE_RECEIVED', fields }
const fixedNote = '申请已收到，待财务办理，请留意邮箱'
const config = { enabled: true, appId: 'synthetic-invoice-app', cloudBaseEnvId: 'synthetic-invoice-env', appSecret: 'synthetic-only' }
function fixture() {
  const invoice = { id: 'inv-synthetic-linked', storeKey: 'synthetic-store', titleType: 'company',
    companyName: '合成验收企业抬头', amountCents: 120029n, deletedAt: null, note: '顾客备注不得作为已收到确认文案' }
  const request = { id: 'csr-synthetic-invoice-received', type: 'INVOICE', storeKey: invoice.storeKey,
    linkedBusinessRecordId: invoice.id, subscriptionChoice: 'accept', subscriptionTemplateId: template.id,
    submittedAt: new Date('2026-10-25T16:05:06.000Z'),
    receiptConfirmedAt: new Date('2026-10-27T01:00:00.000Z'), requestMetadata: { amountCents: 1, invoiceTitle: '不能采用的影子抬头' },
    customerUserId: 'synthetic-owner', customerOpenId: 'synthetic-requester', customerAppId: config.appId,
    customerEnvId: config.cloudBaseEnvId, store: { name: '合成门店' } }
  const delivery = { id: 'ssd-synthetic', requestId: request.id, templateId: template.id, event: 'INVOICE_RECEIVED',
    userId: request.customerUserId, openId: request.customerOpenId, appId: config.appId, envId: config.cloudBaseEnvId, attempts: 1 }
  const messages = []; let tokenCalls = 0
  const fetchImpl = async (url, input) => {
    if (url.includes('/stable_token')) { tokenCalls++; return { ok: true, json: async () => ({ access_token: 'synthetic-only-token', expires_in: 7200 }) } }
    messages.push(JSON.parse(input.body)); return { ok: true, json: async () => ({ errcode: 0 }) }
  }
  const templates = notifications.serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ INVOICE: template }) })
  const send = notifications.createServiceWechatSender({ config, templates, fetchImpl })
  return { invoice, request, delivery, messages, send, templates, tokenCalls: () => tokenCalls }
}

test('invoice adopted field mapping accepts time and rejects incompatible field kinds', () => {
  const f = fixture()
  assert.deepEqual(f.templates.INVOICE, { id: template.id, semantic: 'INVOICE_RECEIVED', fields })
  for (const badFields of [{ ...fields, time4: 'invoiceTitle' }, { ...fields, thing5: 'submittedAt' },
    { ...fields, amount3: 'invoiceReceivedNote' }, { ...fields, thing2: 'carrier' }]) {
    const actual = notifications.serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ INVOICE: { ...template, fields: badFields } }) })
    assert.equal(actual.INVOICE, undefined)
  }
  assert.equal(notifications.serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ MAILING: { ...template, semantic: 'SHIPMENT_CONFIRMED' } }) }).MAILING, undefined)
})

test('final invoice request uses linked invoice amount/title, original submittedAt and fixed received note', async () => {
  _resetMiniprogramTokenAuthority(); const f = fixture()
  assert.deepEqual(await f.send(f.delivery, f.request, f.request.store.name, f.invoice), { status: 'ACCEPTED', code: '0' })
  assert.deepEqual(f.messages, [{ touser: f.delivery.openId, template_id: template.id,
    page: `pages/store-service/detail?id=${f.request.id}`, miniprogram_state: 'formal', lang: 'zh_CN',
    data: { thing2: { value: f.invoice.companyName }, amount3: { value: '￥1200.29' },
      time4: { value: '2026年10月26日 00:05' }, thing5: { value: fixedNote } } }])
  assert.equal(f.invoice.amountCents, 120029n)
  assert.equal(JSON.stringify(f.messages).includes(f.invoice.note), false)
  assert.equal(JSON.stringify(f.messages).includes(f.request.requestMetadata.invoiceTitle), false)
})

test('personal and enterprise titles are actual values; display truncation does not rewrite stored data', async t => {
  for (const [titleType, title] of [['personal', '合成测试个人'], ['company', '合成验收企业抬头'.repeat(8)], ['personal', '测试😀'.repeat(12)]]) {
    await t.test(titleType + ':' + [...title].length, async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture(); f.invoice.titleType = titleType; f.invoice.companyName = title
      assert.equal((await f.send(f.delivery, f.request, f.request.store.name, f.invoice)).status, 'ACCEPTED')
      assert.equal(f.messages[0].data.thing2.value, [...title].length > 20 ? [...title].slice(0, 19).join('') + '…' : title)
      assert.equal(f.invoice.companyName, title); assert.ok([...f.messages[0].data.thing2.value].length <= 20)
    })
  }
})

test('amount conversion is exact in cents and refuses missing, fractional, unsafe or oversized values', async t => {
  for (const [cents, value] of [[0n, '￥0.00'], [1n, '￥0.01'], [29n, '￥0.29'], [100005n, '￥1000.05'],
    ['000001', '￥0.01'], [9999999999n, '￥99999999.99'], [10000000000n, null],
    [9007199254740993n, null], [Number.MAX_SAFE_INTEGER + 1, null], [1.5, null], [-1n, null],
    [null, null], [undefined, null], ['', null], ['0x10', null], ['1.5', null]]) {
    await t.test(String(cents), async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture(); f.invoice.amountCents = cents
      const result = await f.send(f.delivery, f.request, f.request.store.name, f.invoice)
      if (value) { assert.equal(result.status, 'ACCEPTED'); assert.equal(f.messages[0].data.amount3.value, value) }
      else { assert.deepEqual(result, { status: 'FAILED', code: 'FIELD_INVALID' }); assert.equal(f.messages.length, 0); assert.equal(f.tokenCalls(), 0) }
    })
  }
})

test('submittedAt uses Asia/Shanghai midnight, year and leap-day boundaries, never confirmation time', async t => {
  for (const [at, expected] of [['2026-10-25T15:59:59.000Z', '2026年10月25日 23:59'],
    ['2026-10-25T16:00:00.000Z', '2026年10月26日 00:00'],
    ['2026-12-31T16:01:00.000Z', '2027年1月1日 00:01'],
    ['2024-02-28T16:00:00.000Z', '2024年2月29日 00:00']]) {
    await t.test(at, async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture(); f.request.submittedAt = new Date(at)
      assert.equal((await f.send(f.delivery, f.request, f.request.store.name, f.invoice)).status, 'ACCEPTED')
      assert.equal(f.messages[0].data.time4.value, expected)
    })
  }
})

test('canonical time field validation independently rejects calendar rollover and non-24-hour values', () => {
  assert.equal(typeof notifications.validServiceMessageTime, 'function')
  assert.equal(notifications.validServiceMessageTime('2024年2月29日 23:59'), true)
  for (const value of ['2026年2月29日 12:00', '2026年4月31日 12:00', '2026年0月1日 12:00',
    '2026年10月25日 24:00', '2026年10月25日 12:60', '2026年10月25日 12:00\n', '', null]) {
    assert.equal(notifications.validServiceMessageTime(value), false, String(value))
  }
})

test('missing linked invoice/title/submittedAt, deleted record or different store fails before platform access', async t => {
  for (const kind of ['missing-record', 'wrong-record', 'deleted-record', 'foreign-store', 'empty-title', 'missing-submitted', 'invalid-submitted']) {
    await t.test(kind, async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture(); let invoice = f.invoice
      if (kind === 'missing-record') invoice = null
      if (kind === 'wrong-record') invoice.id = 'inv-different'
      if (kind === 'deleted-record') invoice.deletedAt = new Date()
      if (kind === 'foreign-store') invoice.storeKey = 'other-store'
      if (kind === 'empty-title') invoice.companyName = ''
      if (kind === 'missing-submitted') f.request.submittedAt = null
      if (kind === 'invalid-submitted') f.request.submittedAt = new Date(NaN)
      const result = await f.send(f.delivery, f.request, f.request.store.name, invoice)
      assert.equal(result.status, 'FAILED'); assert.equal(f.messages.length, 0); assert.equal(f.tokenCalls(), 0)
    })
  }
})
