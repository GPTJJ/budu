import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INVOICE_CATEGORIES,
  serializePublicRequest,
  validateInvoiceMetadata,
} from '../server/customer-request-core.js'

test('Invoice QR metadata accepts exactly one supported category and a positive cent amount', () => {
  assert.deepEqual(INVOICE_CATEGORIES, ['食品', '巧克力', '太妃糖'])
  for (const category of INVOICE_CATEGORIES) {
    assert.deepEqual(validateInvoiceMetadata({ amountCents: 12800, category }), { amountCents: 12800, category })
  }
  for (const category of ['', '商品', '其他', ['食品', '巧克力']]) {
    assert.throws(() => validateInvoiceMetadata({ amountCents: 12800, category }), /商品类目/)
  }
  for (const amountCents of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateInvoiceMetadata({ amountCents, category: '食品' }), /开票金额/)
  }
})

test('public Invoice view serializes only locked request facts', () => {
  const publicView = serializePublicRequest({
    type: 'INVOICE',
    status: 'WAITING_CUSTOMER',
    storeKey: 'xidan',
    expiresAt: new Date('2026-08-28T17:30:00.000Z'),
    requestMetadata: { amountCents: 12800, category: '巧克力' },
  })
  assert.equal(publicView.invoiceStoreKey, 'xidan')
  assert.equal(publicView.invoiceAmountCents, '12800')
  assert.equal(publicView.invoiceCategory, '巧克力')
  assert.equal('id' in publicView, false)
})

test('legacy in-flight metadata remains readable without weakening new request creation', () => {
  assert.deepEqual(
    validateInvoiceMetadata({ amountCents: 1000, category: '商品' }, { allowLegacyCategory: true }),
    { amountCents: 1000, category: '商品' },
  )
  assert.throws(() => validateInvoiceMetadata({ amountCents: 1000, category: '商品' }), /商品类目/)
})
