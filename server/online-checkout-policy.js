// Pure financial policy. Callers must supply server-resolved prices/policies and
// execute reservation/refund decisions under the canonical PG transaction lock.
// This module does not authenticate, persist or certify provider settlement.
export const ONLINE_MAX_CENTS = 2_000_000_000n

function deny(code) {
  throw Object.assign(new Error(code), { status: 400, publicSafe: true })
}

export function cents(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) deny('ONLINE_AMOUNT_INVALID')
  if (!['number', 'string', 'bigint'].includes(typeof value)
      || String(value).length > 10
      || !/^(0|[1-9]\d*)$/.test(String(value))) deny('ONLINE_AMOUNT_INVALID')
  const result = BigInt(value)
  if (result > ONLINE_MAX_CENTS) deny('ONLINE_AMOUNT_LIMIT')
  return result
}

export function onlinePaymentAllowed(userId, env = process.env) {
  if (!userId || env.SWEET_CARD_ONLINE_PAYMENT_ENABLED !== '1') return false
  const allowed = String(env.SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST || '').split(',').map(x => x.trim()).filter(Boolean)
  // Empty is closed, not public. Public enablement must be explicit.
  return allowed.includes(userId) || env.SWEET_CARD_ONLINE_PAYMENT_PUBLIC === '1'
}

export function availableBalance(balanceCents, reservedCents) {
  const balance = cents(balanceCents)
  const reserved = cents(reservedCents)
  if (reserved > balance) deny('ONLINE_RESERVATION_RECONCILIATION_REQUIRED')
  return balance - reserved
}

/**
 * Server catalog adapter supplies each line's authoritative SKU and price,
 * canonical policy decision and server discount. Never pass req.body lines here
 * without catalog resolution. All returned cents are decimal strings for JSON.
 */
export function quoteOnlineCheckout({ lines, shippingCents, availableCents = 0n, desiredSweetCardCents = 0n }) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) deny('ONLINE_LINES_INVALID')
  const seen = new Set()
  let merchandise = 0n
  let eligible = 0n
  let discount = 0n
  const snapshot = lines.map(line => {
    if (!line || typeof line.productId !== 'string' || !line.productId
        || typeof line.skuId !== 'string' || !line.skuId
        || typeof line.name !== 'string' || !line.name
        || typeof line.onlineEligible !== 'boolean'
        || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) deny('ONLINE_LINE_INVALID')
    const identity = JSON.stringify([line.productId, line.skuId])
    if (seen.has(identity)) deny('ONLINE_DUPLICATE_LINE')
    seen.add(identity)
    const unit = cents(line.unitPriceCents)
    if (unit === 0n) deny('ONLINE_PRICE_INVALID')
    const gross = cents(unit * BigInt(line.quantity))
    const reduction = cents(line.discountCents ?? 0n)
    if (reduction > gross) deny('ONLINE_DISCOUNT_INVALID')
    const net = gross - reduction
    merchandise = cents(merchandise + net)
    discount = cents(discount + reduction)
    cents(merchandise + discount)
    if (line.onlineEligible) eligible += net
    return {
      productId: line.productId, skuId: line.skuId, name: line.name,
      quantity: line.quantity, unitPriceCents: String(unit),
      grossCents: String(gross), discountCents: String(reduction),
      lineAmountCents: String(net), onlineEligible: line.onlineEligible,
    }
  })
  const shipping = cents(shippingCents)
  const total = cents(merchandise + shipping)
  if (total === 0n) deny('ONLINE_TOTAL_INVALID')
  const available = cents(availableCents)
  const desired = cents(desiredSweetCardCents)
  const maximum = available < eligible ? available : eligible
  const sweetCard = desired < maximum ? desired : maximum
  return {
    version: 1, currency: 'CNY', lines: snapshot,
    merchandiseCents: String(merchandise), discountCents: String(discount),
    eligibleMerchandiseCents: String(eligible), shippingCents: String(shipping),
    totalCents: String(total), maximumSweetCardCents: String(maximum),
    sweetCardCents: String(sweetCard), wechatCents: String(total - sweetCard),
    shippingTender: 'WECHAT',
  }
}

// Converts merchant-approved quantity intent using the original settlement
// snapshot. `occupied` includes pending quantities; do not use current catalog.
export function refundMerchandiseByQuantity({ lines, occupied = [], requested }) {
  if (!Array.isArray(lines) || !Array.isArray(occupied) || !Array.isArray(requested)
      || !requested.length || requested.length > 100) deny('ONLINE_REFUND_LINES_INVALID')
  const key = row => JSON.stringify([row.productId, row.skuId])
  const originals = new Map()
  for (const row of lines) {
    if (!row || !row.productId || !row.skuId || originals.has(key(row))
        || !Number.isSafeInteger(row.quantity) || row.quantity < 1
        || typeof row.onlineEligible !== 'boolean') deny('ONLINE_REFUND_SNAPSHOT_INVALID')
    originals.set(key(row), row)
  }
  const prior = new Map()
  for (const row of occupied) {
    const original = originals.get(key(row))
    if (!original || prior.has(key(row)) || !Number.isSafeInteger(row.quantity)
        || row.quantity < 0 || row.quantity > original.quantity) deny('ONLINE_REFUND_QUANTITY_INVALID')
    prior.set(key(row), row.quantity)
  }
  let eligible = 0n
  let ineligible = 0n
  const seen = new Set()
  const items = requested.map(row => {
    const original = row && originals.get(key(row))
    if (!original || seen.has(key(row)) || !Number.isSafeInteger(row.quantity) || row.quantity < 1) deny('ONLINE_REFUND_QUANTITY_INVALID')
    seen.add(key(row))
    const before = prior.get(key(row)) || 0
    const after = before + row.quantity
    if (after > original.quantity) deny('ONLINE_REFUND_EXCEEDS_REMAINING')
    const net = cents(original.lineAmountCents)
    const denominator = BigInt(original.quantity)
    const amount = net * BigInt(after) / denominator - net * BigInt(before) / denominator
    if (original.onlineEligible) eligible = cents(eligible + amount)
    else ineligible = cents(ineligible + amount)
    return { productId: original.productId, skuId: original.skuId, quantity: row.quantity, cumulativeQuantity: after, amountCents: String(amount) }
  })
  return { items, eligibleCents: String(eligible), ineligibleCents: String(ineligible) }
}

/**
 * `occupied` includes both completed and pending refund intents. Obtain it while
 * holding the settlement lock, then persist this allocation in that transaction.
 * Denied/failed allocations cannot be removed while later allocations depend on
 * their cumulative position; retry the existing intent instead.
 */
export function allocateOnlineRefund({ original, occupied, requested }) {
  const eligible = cents(original.eligibleMerchandiseCents)
  const merchandise = cents(original.merchandiseCents)
  const shipping = cents(original.shippingCents)
  const card = cents(original.sweetCardCents)
  const wechat = cents(original.wechatCents)
  if (eligible > merchandise || card > eligible || card + wechat !== merchandise + shipping) deny('ONLINE_TENDER_INVALID')
  const previousEligible = cents(occupied.eligibleCents)
  const previousOther = cents(occupied.ineligibleCents)
  const previousShipping = cents(occupied.shippingCents)
  const previousCard = cents(occupied.sweetCardCents)
  const previousWechat = cents(occupied.wechatCents)
  const expectedPreviousCard = eligible === 0n ? 0n : previousEligible * card / eligible
  if (previousEligible > eligible || previousOther > merchandise - eligible || previousShipping > shipping
      || previousCard !== expectedPreviousCard
      || previousCard + previousWechat !== previousEligible + previousOther + previousShipping) deny('ONLINE_REFUND_RECONCILIATION_REQUIRED')
  const nextEligible = cents(requested.eligibleCents)
  const nextOther = cents(requested.ineligibleCents)
  const nextShipping = cents(requested.shippingCents)
  const total = cents(nextEligible + nextOther + nextShipping)
  if (total === 0n) deny('ONLINE_REFUND_AMOUNT_INVALID')
  if (previousEligible + nextEligible > eligible || previousOther + nextOther > merchandise - eligible
      || previousShipping + nextShipping > shipping) deny('ONLINE_REFUND_EXCEEDS_REMAINING')
  const cumulativeEligible = previousEligible + nextEligible
  const cumulativeCard = eligible === 0n ? 0n : cumulativeEligible * card / eligible
  const cardRefund = cumulativeCard - previousCard
  const wechatRefund = total - cardRefund
  if (cardRefund < 0n || wechatRefund < 0n || previousWechat + wechatRefund > wechat) deny('ONLINE_REFUND_RECONCILIATION_REQUIRED')
  return {
    eligibleCents: String(nextEligible), ineligibleCents: String(nextOther), shippingCents: String(nextShipping),
    totalCents: String(total), sweetCardCents: String(cardRefund), wechatCents: String(wechatRefund),
    cumulativeEligibleCents: String(cumulativeEligible), cumulativeSweetCardCents: String(cumulativeCard),
  }
}
