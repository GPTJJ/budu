import { assertOperatingStore } from './store-operation-policy.js'
import { httpError } from './pos-core.js'

// Persisted quotes keep the fulfillment identity in commerceIntent. Delivery
// storeRef is a catalogue selection, not an OS pickup fulfillment destination.
export async function assertOnlinePickupOperatingStore(db, selection, options = {}) {
  if (selection?.fulfillment !== 'PICKUP') return
  const storeRef = selection.commerceIntent ? selection.commerceIntent.storeRef : selection.storeRef
  const store = await assertOperatingStore(db, storeRef, options)
  if (store.pickupEnabled !== true) {
    const message = options.payment
      ? '该门店暂不支持顾客自提，该订单无法继续发起支付，请重新选择门店下单。'
      : '该门店暂不支持顾客自提，请选择其他门店。'
    // Preserve the existing client's business-rejection/recovery contract.
    // This gate runs only at new pickup quote, submit and prepay boundaries.
    throw Object.assign(httpError(message, 409), { code: 'STORE_CLOSED', publicCode: 'STORE_CLOSED' })
  }
  return store
}
