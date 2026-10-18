import { assertOperatingStore } from './store-operation-policy.js'

// Persisted quotes keep the fulfillment identity in commerceIntent. Delivery
// storeRef is a catalogue selection, not an OS pickup fulfillment destination.
export async function assertOnlinePickupOperatingStore(db, selection, options = {}) {
  if (selection?.fulfillment !== 'PICKUP') return
  const storeRef = selection.commerceIntent ? selection.commerceIntent.storeRef : selection.storeRef
  return assertOperatingStore(db, storeRef, options)
}
