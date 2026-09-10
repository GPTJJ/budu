import { httpError } from './pos-core.js'
import { cents } from './online-checkout-policy.js'

// Intent only: these selections never determine price, inventory or eligibility.
// Preserve order/multiplicity (combo repeats may be allowed by catalog policy).
function selection(value, maximum, length) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > maximum || value.some(x => typeof x !== 'string' || !x.trim() || x.length > length)) {
    throw httpError('商品选项无效', 400)
  }
  return value.slice()
}

export function normalizeOnlineCheckoutIntent(input) {
  if (!Array.isArray(input?.lines) || !input.lines.length || input.lines.length > 100) throw httpError('商品选择无效', 400)
  const lines = input.lines.map(x => {
    if (!x || typeof x.productId !== 'string' || !x.productId || x.productId.length > 160
      || typeof x.skuId !== 'string' || !x.skuId || x.skuId.length > 160
      || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 999) throw httpError('商品选择无效', 400)
    const options = selection(x.options, 32, 120)
    const comboFlavors = x.comboFlavors == null ? null : selection(x.comboFlavors, 100, 160)
    return { productId: x.productId, skuId: x.skuId, quantity: x.quantity,
      ...(options.length ? { options } : {}), ...(comboFlavors === null ? {} : { comboFlavors }) }
  })
  if (!['PICKUP', 'DELIVERY'].includes(input.fulfillment)) throw httpError('配送方式无效', 400)
  if (input.fulfillment === 'DELIVERY' && (typeof input.addressRef !== 'string' || !input.addressRef || input.addressRef.length > 160)) throw httpError('配送地址无效', 400)
  if (input.walletRef != null && (typeof input.walletRef !== 'string' || !input.walletRef || input.walletRef.length > 160)) throw httpError('甜意卡选择无效', 400)
  if (input.storeRef != null && (typeof input.storeRef !== 'string' || !input.storeRef.trim() || input.storeRef.length > 160)) throw httpError('门店选择无效', 400)
  return { lines, fulfillment: input.fulfillment, addressRef: input.fulfillment === 'DELIVERY' ? input.addressRef : null,
    walletRef: input.walletRef || null, desiredSweetCardCents: String(cents(input.desiredSweetCardCents ?? 0)),
    ...(input.storeRef == null ? {} : { storeRef: input.storeRef }) }
}
