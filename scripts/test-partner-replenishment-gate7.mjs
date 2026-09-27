import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildPartnerSubmission,
  buildReorderDraft,
  displayQuantity,
  orderMatchesGroup,
  parseDisplayQuantity,
  quantityValidationMessage,
} from '../src/utils/partnerReplenishmentPortal.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const kg = { productId: 'kg', name: 'KG 糖', orderUnit: 'KG', minimumOrderBaseQty: 1000, orderStepBaseQty: 500 }
const pcs = { productId: 'pcs', name: '颗糖', orderUnit: 'PCS', minimumOrderBaseQty: 20, orderStepBaseQty: 10 }

test('mobile display converts kg to integer grams and keeps pieces integral', () => {
  assert.equal(parseDisplayQuantity('10.5', 'KG'), 10500)
  assert.equal(displayQuantity(10500, 'KG'), '10.5')
  assert.equal(parseDisplayQuantity('21', 'PCS'), 21)
  assert.equal(parseDisplayQuantity('2.0015', 'KG'), null)
  assert.equal(parseDisplayQuantity('1.5', 'PCS'), null)
})

test('current positive quantity rule does not enforce old MOQ or shortcut steps', () => {
  assert.equal(quantityValidationMessage(kg, 10000), '')
  assert.equal(quantityValidationMessage(kg, 1200), '')
  assert.equal(quantityValidationMessage(pcs, 10), '')
})

test('reorder copies only product identity and requested quantity against current catalogue', () => {
  const order = {
    partnerStore: { id: 'store-a' },
    requestedTotalAmountCents: '999999',
    items: [
      { inventoryItemId: 'kg', productNameSnapshot: '旧名称', orderUnitSnapshot: 'KG', requestedQuantityBase: 10000, basePriceSnapshotCents: '1', discountBpsSnapshot: 1 },
      { inventoryItemId: 'gone', productNameSnapshot: '已下架商品', orderUnitSnapshot: 'PCS', requestedQuantityBase: 10 },
    ],
  }
  const draft = buildReorderDraft(order, [kg, pcs])
  assert.deepEqual(draft.items, [{ productId: 'kg', quantityBase: 10000, validation: '' }])
  assert.match(draft.issues.join(' '), /已下架商品.*不可补货/)
  assert.doesNotMatch(JSON.stringify(draft), /999999|basePrice|discount/)
})

test('submission contains only store, current product, integer quantity and unit', () => {
  assert.deepEqual(buildPartnerSubmission({ partnerStoreId: 'store-a', selected: { kg: 10000, pcs: 20 }, catalogue: [kg, pcs] }), {
    partnerStoreId: 'store-a',
    items: [
      { inventoryItemId: 'kg', quantity: 10000, orderUnit: 'KG' },
      { inventoryItemId: 'pcs', quantity: 20, orderUnit: 'PCS' },
    ],
  })
  assert.equal(buildPartnerSubmission({ partnerStoreId: 'store-a', selected: { kg: 1200 }, catalogue: [kg] }).items[0].quantity, 1200)
})

test('mobile order groups preserve all fulfillment and terminal statuses', () => {
  assert.equal(orderMatchesGroup({ status: 'SUBMITTED' }, 'pending'), true)
  for (const status of ['APPROVED', 'PARTIALLY_SHIPPED', 'SHIPPED']) assert.equal(orderMatchesGroup({ status }, 'fulfillment'), true)
  for (const status of ['CANCELLED', 'REJECTED']) assert.equal(orderMatchesGroup({ status }, 'closed'), true)
})

test('portal consumes Partner APIs only and cannot become price, inventory or payment authority', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/PartnerAccessPage.jsx'), 'utf8')
  assert.doesNotMatch(source, /\/api\/v2|partner-management/)
  assert.doesNotMatch(source, /StockLedger|Payment|finalAmountCents\s*:/)
  assert.match(source, /\/catalogue\/quote/)
  assert.match(source, /\/replenishment-orders/)
  assert.match(source, /Idempotency-Key/)
})

test('account basic display is resolved server-side without exposing user identity fields', () => {
  const authSource = fs.readFileSync(path.join(root, 'server/partner-auth.js'), 'utf8')
  assert.match(authSource, /account: \{ username:/)
  assert.doesNotMatch(authSource.match(/function publicPartnerPrincipal[\s\S]*?\n\}/)?.[0] || '', /userId|partnerUserId/)
})

test('Gate 7 adds no migration and preserves zero stock/payment writes', () => {
  const migrationNames = fs.readdirSync(path.join(root, 'prisma/migrations'))
  assert.ok(migrationNames.includes('20260907300000_replenishment_shipment'))
  assert.equal(migrationNames.some((name) => /portal|reorder/i.test(name)), false)
  const portal = fs.readFileSync(path.join(root, 'src/components/PartnerAccessPage.jsx'), 'utf8')
  assert.doesNotMatch(portal, /StockLedger|stockLedger|payment\.|refund\.|\/inventory/i)
})
