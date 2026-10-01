import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAILING_METHOD,
  MAILING_TIER,
  buildMailingCopyText,
  canGenerateCustomerQr,
  shippingPresentation,
  sortShippedRecords,
} from '../src/utils/mailingWorkflow.js'
import { validateMailingMetadata } from '../server/customer-request-core.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const base = { storeKey: 'xidan', method: MAILING_METHOD.SF, postage: '包邮', shippingTier: MAILING_TIER.STANDARD, paymentConfirmed: false }

test('mailing QR-only configuration matrix and server gate', () => {
  assert.equal(canGenerateCustomerQr(base), true)
  assert.equal(validateMailingMetadata(base).shippingPaymentMode, 'FREE')

  const standard = { ...base, postage: '不包邮', paymentConfirmed: true, shippingAmountCents: 1800 }
  assert.equal(canGenerateCustomerQr({ ...standard, paymentConfirmed: false }), false)
  assert.throws(() => validateMailingMetadata({ ...standard, paymentConfirmed: false }), /确认收到顾客运费/)
  assert.equal(validateMailingMetadata(standard).fee, '标准件18¥')
  assert.equal(validateMailingMetadata(standard).shippingAmountCents, 1800)
  assert.throws(() => validateMailingMetadata({ ...standard, shippingAmountCents: 3500 }), /金额与配送类型不一致/)

  const fresh = { ...standard, shippingTier: MAILING_TIER.FRESH, shippingAmountCents: 3500 }
  assert.equal(validateMailingMetadata(fresh).fee, '生鲜航运35¥')
  assert.equal(validateMailingMetadata(fresh).shippingAmountCents, 3500)

  const flash = { ...base, method: MAILING_METHOD.FLASH, postage: '不包邮' }
  const flashLocked = validateMailingMetadata(flash)
  assert.equal(canGenerateCustomerQr(flash), true)
  assert.equal(flashLocked.shippingPaymentMode, 'WECHAT_COMMUNICATION')
  assert.equal(flashLocked.shippingAmountCents, null)
  assert.equal(flashLocked.fee, '微信沟通')
})

test('record presentation and copy are deterministic and legacy-compatible', () => {
  assert.deepEqual(
    shippingPresentation({ method: '同城闪送', postage: '不包邮', fee: '' }),
    { method: '同城闪送', postage: '不包邮', detail: '不包邮 · 微信沟通', tierLabel: '' },
  )
  assert.equal(shippingPresentation({ method: '顺丰邮寄', postage: '不包邮', fee: '生鲜航运30¥' }).tierLabel, '生鲜')
  const copy = buildMailingCopyText({
    recipient: '测试甲', phone: '13800000001', address: '测试地址1号', remark: '',
    method: '同城闪送', postage: '不包邮', shippingPaymentMode: 'WECHAT_COMMUNICATION',
  })
  assert.equal(copy, '测试甲\n13800000001\n测试地址1号\n配送：同城闪送\n运费：不包邮 · 微信沟通')
  assert.equal(/undefined|null|¥0/.test(copy), false)
})

test('controlled QR assets preserve the reviewer-provided bytes', () => {
  const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src', 'assets', name))).digest('hex')
  assert.equal(sha256('mailing-personal-wechat-qr.jpg'), '1929ebf09fc2486bc61cfd7b7e0ff1850f23e9f04a04b6088bf6fb99c6651306')
  assert.equal(sha256('mailing-payment-qr.jpg'), '064d450fcc007bebd0fac7793a942cc9e6e06187c370e3048c1844e18d8cede3')
})

for (const tier of ['STANDARD', 'FRESH']) {
  test(`SF free ${tier} preserves type without collection facts`, () => {
    const locked = validateMailingMetadata({ ...base, shippingTier: tier, shippingAmountCents: 3500, paymentConfirmed: true })
    assert.equal(locked.shippingTier, tier)
    assert.equal(locked.shippingPaymentMode, 'FREE')
    assert.equal(locked.shippingAmountCents, null)
    assert.equal(locked.paymentConfirmed, false)
    assert.equal(locked.paymentConfirmedAt, null)
    assert.equal(locked.paymentConfirmedBy, null)
    assert.equal(locked.fee, '')
    assert.equal(shippingPresentation(locked).tierLabel, tier === 'FRESH' ? '生鲜' : '标准')
    assert.match(buildMailingCopyText(locked), /运费：包邮/)
  })
}

test('new UI needs an explicit tier; historical free requests keep unknown tier', () => {
  assert.equal(canGenerateCustomerQr({ ...base, shippingTier: '' }), false)
  assert.equal(canGenerateCustomerQr({ ...base, shippingTier: 'INVALID' }), false)
  const legacy = validateMailingMetadata({ ...base, shippingTier: null })
  assert.equal(legacy.shippingTier, null)
  assert.equal(shippingPresentation(legacy).tierLabel, '未记录')
  assert.equal(shippingPresentation({ ...legacy, fee: '标准件18¥' }).tierLabel, '未记录')
  assert.throws(() => validateMailingMetadata({ ...base, shippingTier: 'INVALID' }), /邮寄类型/)
  assert.equal(validateMailingMetadata({ ...base, method: MAILING_METHOD.FLASH }).shippingTier, null)
  assert.equal(canGenerateCustomerQr({ ...base, method: MAILING_METHOD.FLASH, shippingTier: '' }), true)
})

test('shipped display uses shipment time, historical creation fallback and stable ids without mutation', () => {
  const rows = [
    { id: 'old-created-late-shipped', createdAt: '2026-08-01T00:00:00Z', shippedAt: '2026-08-30T00:00:00Z' },
    { id: 'new-created-early-shipped', createdAt: '2026-08-20T00:00:00Z', shippedAt: '2026-08-21T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' },
    { id: 'null-shipment', createdAt: '2026-08-25T00:00:00Z', shippedAt: null },
    { id: 'tie-b', createdAt: '2026-08-01T00:00:00Z', shippedAt: '2026-08-30T00:00:00Z' },
    { id: 'tie-a', createdAt: '2026-08-02T00:00:00Z', shippedAt: '2026-08-30T00:00:00Z' },
  ]
  const snapshot = structuredClone(rows)
  const expected = ['old-created-late-shipped', 'tie-a', 'tie-b', 'null-shipment', 'new-created-early-shipped']
  assert.deepEqual(sortShippedRecords(rows).map(row => row.id), expected)
  assert.deepEqual(sortShippedRecords([...rows].reverse()).map(row => row.id), expected)
  assert.deepEqual(rows, snapshot)
})
