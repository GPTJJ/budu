import test from 'node:test'
import assert from 'node:assert/strict'
import { serviceTemplates, selectServiceTemplate, normalizeServiceSubscription, createServiceWechatSender } from '../server/store-service-notifications.js'
import { _resetMiniprogramTokenAuthority } from '../server/wechat-access-token.js'

const adopted = {
  MAILING_EXPRESS: { id: 'synthetic-express-template', verified: true, semantic: 'SHIPMENT_CONFIRMED',
    fields: { character_string5: 'trackingNo', thing20: 'carrier', thing13: 'shipmentNote', time9: 'shipmentConfirmedAt' } },
  MAILING_FLASH: { id: 'synthetic-flash-template', verified: true, semantic: 'SHIPMENT_CONFIRMED',
    fields: { thing20: 'carrier', time9: 'shipmentConfirmedAt', thing13: 'shipmentNote' } },
  INVOICE: { id: 'synthetic-invoice-template', verified: true, semantic: 'INVOICE_RECEIVED',
    fields: { thing2: 'invoiceTitle', amount3: 'amount', time4: 'submittedAt', thing5: 'invoiceReceivedNote' } },
  MAILING: { id: 'synthetic-legacy-template', verified: true, semantic: 'SHIPMENT_CONFIRMED', fields: { thing1: 'status' } },
}
const templates = serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify(adopted) })
const config = { enabled: true, appId: 'synthetic-app', cloudBaseEnvId: 'synthetic-env', appSecret: 'synthetic-only' }
test('unavailable configuration is nonfatal and never coerces numeric IDs', () => {
  for (const input of ['null', '[]', 'true', '1', '"text"', '{'])
    assert.deepEqual(serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: input }), {})
  assert.deepEqual(serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({
    INVOICE: { ...adopted.INVOICE, id: 1234567890123 },
  }) }), {})
})
function fixture(kind) {
  const selected = adopted[kind], method = kind === 'MAILING_FLASH' ? '同城闪送' : '顺丰邮寄'
  const request = { id: 'csr-synthetic-' + kind, type: kind === 'INVOICE' ? 'INVOICE' : 'MAILING',
    storeKey: 'synthetic-store', requestMetadata: { method }, linkedBusinessRecordId: 'synthetic-business',
    subscriptionChoice: 'accept', subscriptionTemplateId: selected.id, submittedAt: new Date('2026-10-25T15:59:00Z'),
    shipmentConfirmedAt: new Date('2026-10-25T16:03:00Z'), carrier: '合成承运服务', trackingNo: 'SYNTHETIC123456',
    deliveryProof: method === '同城闪送' ? '合成配送凭证，请凭交接记录核对' : null,
    note: '顾客注入内容不能成为提醒文案', customerUserId: 'synthetic-owner', customerOpenId: 'synthetic-caller',
    customerAppId: config.appId, customerEnvId: config.cloudBaseEnvId }
  const business = { id: request.linkedBusinessRecordId, storeKey: request.storeKey, deletedAt: null,
    method, companyName: '合成开票抬头', amountCents: 12345n }
  const delivery = { templateId: selected.id, event: selected.semantic, userId: request.customerUserId,
    openId: request.customerOpenId, appId: config.appId, envId: config.cloudBaseEnvId }
  const messages = []; let tokens = 0
  const fetchImpl = async (url, input) => {
    if (url.includes('/stable_token')) { tokens++; return { ok: true, json: async () => ({ access_token: 'synthetic-token', expires_in: 7200 }) } }
    messages.push(JSON.parse(input.body)); return { ok: true, json: async () => ({ errcode: 0 }) }
  }
  return { request, business, delivery, messages, fetchImpl, tokens: () => tokens }
}

test('unique admission choice comes only from saved request type and method; legacy is lookup-only', () => {
  for (const [kind, type, method] of [['MAILING_EXPRESS', 'MAILING', '顺丰邮寄'], ['MAILING_FLASH', 'MAILING', '同城闪送'], ['INVOICE', 'INVOICE', undefined]]) {
    const request = { type, requestMetadata: { method }, carrier: '同城闪送', templateId: 'forged', method: 'forged' }
    assert.equal(selectServiceTemplate(templates, request).id, adopted[kind].id)
  }
  assert.equal(selectServiceTemplate(templates, { type: 'MAILING', requestMetadata: { method: 'not-supported' } }), null)
  assert.equal(selectServiceTemplate({ MAILING: templates.MAILING }, { type: 'MAILING', requestMetadata: { method: '顺丰邮寄' } }), null)
  assert.equal(selectServiceTemplate(templates, { type: 'MAILING', requestMetadata: { method: '顺丰邮寄' } }, { method: '同城闪送' }), null)
})

test('exact three final messages use one matching ID, exact field names and original business timestamps', async t => {
  for (const kind of ['MAILING_EXPRESS', 'MAILING_FLASH', 'INVOICE']) {
    await t.test(kind, async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture(kind)
      if (kind === 'MAILING_FLASH') f.request.trackingNo = null
      const send = createServiceWechatSender({ config, templates, envVersion: 'developer', fetchImpl: f.fetchImpl })
      assert.equal((await send(f.delivery, f.request, '合成门店', f.business)).status, 'ACCEPTED')
      const expected = kind === 'INVOICE'
        ? { thing2: { value: f.business.companyName }, amount3: { value: '￥123.45' },
          time4: { value: '2026年10月25日 23:59' }, thing5: { value: '申请已收到，待财务办理，请留意邮箱' } }
        : kind === 'MAILING_FLASH'
          ? { thing20: { value: f.request.carrier }, time9: { value: '2026年10月26日 00:03' },
            thing13: { value: '商家已确认发出，点击查看配送凭证' } }
          : { character_string5: { value: f.request.trackingNo }, thing20: { value: f.request.carrier },
            thing13: { value: '商家已确认发货，点击查看配送详情' }, time9: { value: '2026年10月26日 00:03' } }
      assert.deepEqual(f.messages, [{ touser: f.request.customerOpenId, template_id: f.request.subscriptionTemplateId,
        page: `pages/store-service/detail?id=${f.request.id}`, miniprogram_state: 'developer', lang: 'zh_CN', data: expected }])
      assert.equal(f.delivery.templateId, f.request.subscriptionTemplateId)
      assert.equal(JSON.stringify(f.messages).includes(f.request.note), false)
    })
  }
})

test('rejected/cancelled/unavailable/config-changed authorization is retained but never grants a new ID', () => {
  for (const status of ['accept', 'reject', 'cancel', 'unavailable']) {
    const actual = normalizeServiceSubscription(templates.MAILING_EXPRESS, { status, templateId: adopted.MAILING_EXPRESS.id })
    assert.equal(actual.status, status); assert.equal(actual.templateId, adopted.MAILING_EXPRESS.id); assert.equal(actual.validation.matched, true)
  }
  const changed = normalizeServiceSubscription(templates.MAILING_FLASH, { status: 'accept', templateId: adopted.MAILING_EXPRESS.id })
  assert.equal(changed.status, 'unavailable'); assert.equal(changed.templateId, adopted.MAILING_EXPRESS.id)
  assert.equal(changed.validation.reportedChoice, 'accept'); assert.equal(changed.validation.matched, false)
  assert.equal(changed.validation.expectedTemplateId, adopted.MAILING_FLASH.id)
  assert.equal(changed.validation.code, 'TEMPLATE_MISMATCH')
  assert.equal(normalizeServiceSubscription(null, { status: 'accept', templateId: adopted.MAILING_EXPRESS.id }).status, 'unavailable')
})

test('sender blocks changed template/method/authorization and never rotates or borrows a template', async t => {
  for (const kind of ['delivery-id', 'saved-id', 'config-id', 'method', 'refused']) {
    await t.test(kind, async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture('MAILING_EXPRESS'); let selected = templates
      if (kind === 'delivery-id') f.delivery.templateId = adopted.MAILING_FLASH.id
      if (kind === 'saved-id') f.request.subscriptionTemplateId = adopted.MAILING_FLASH.id
      if (kind === 'config-id') selected = { ...templates, MAILING_EXPRESS: { ...templates.MAILING_EXPRESS, id: 'synthetic-replacement-template' } }
      if (kind === 'method') f.business.method = '同城闪送'
      if (kind === 'refused') f.request.subscriptionChoice = 'reject'
      const send = createServiceWechatSender({ config, templates: selected, fetchImpl: f.fetchImpl })
      const actual = await send(f.delivery, f.request, '合成门店', f.business)
      assert.ok(['BLOCKED_CONFIG', 'NO_PERMISSION'].includes(actual.status)); assert.equal(f.messages.length, 0); assert.equal(f.tokens(), 0)
      assert.equal(f.delivery.templateId, kind === 'delivery-id' ? adopted.MAILING_FLASH.id : adopted.MAILING_EXPRESS.id)
    })
  }
})

test('full waybill must fit its field; proof is still mandatory when flash template has no waybill field', async t => {
  for (const [kind, value, expected] of [['MAILING_EXPRESS', '', 'FIELD_INVALID'], ['MAILING_EXPRESS', 'S'.repeat(33), 'FIELD_INVALID'],
    ['MAILING_EXPRESS', 'S'.repeat(80), 'FIELD_INVALID'], ['MAILING_FLASH', '', 'DELIVERY_PROOF_INVALID']]) {
    await t.test(kind + ':' + value.length, async () => {
      _resetMiniprogramTokenAuthority(); const f = fixture(kind)
      if (kind === 'MAILING_EXPRESS') f.request.trackingNo = value
      else { f.request.trackingNo = null; f.request.deliveryProof = value }
      const send = createServiceWechatSender({ config, templates, fetchImpl: f.fetchImpl })
      assert.deepEqual(await send(f.delivery, f.request, '合成门店', f.business), { status: 'FAILED', code: expected })
      assert.equal(f.messages.length, 0); assert.equal(f.tokens(), 0)
      if (kind === 'MAILING_EXPRESS') assert.equal(f.request.trackingNo, value)
    })
  }
})

test('unknown field types are explicitly rejected, including unchecked adapter input', async () => {
  for (const key of ['date9', 'constructor1', 'unknown1']) {
    const bad = { ...adopted.INVOICE, fields: { [key]: 'amount' } }
    assert.equal(serviceTemplates({ STORE_SERVICE_TEMPLATE_CONFIG: JSON.stringify({ INVOICE: bad }) }).INVOICE, undefined)
    _resetMiniprogramTokenAuthority(); const f = fixture('INVOICE')
    const send = createServiceWechatSender({ config, templates: { INVOICE: bad }, fetchImpl: f.fetchImpl })
    assert.deepEqual(await send(f.delivery, f.request, '合成门店', f.business), { status: 'FAILED', code: 'FIELD_INVALID' })
    assert.equal(f.messages.length, 0); assert.equal(f.tokens(), 0)
  }
})

test('message text refuses control characters without changing the business title', async () => {
  _resetMiniprogramTokenAuthority(); const f = fixture('INVOICE')
  f.business.companyName = '合成\n抬头'
  const send = createServiceWechatSender({ config, templates, fetchImpl: f.fetchImpl })
  assert.deepEqual(await send(f.delivery, f.request, '合成门店', f.business), { status: 'FAILED', code: 'FIELD_INVALID' })
  assert.equal(f.business.companyName, '合成\n抬头'); assert.equal(f.messages.length, 0); assert.equal(f.tokens(), 0)
})
