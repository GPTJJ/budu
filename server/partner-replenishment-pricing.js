import { httpError } from './pos-core.js'

export const PARTNER_ORDER_UNITS = Object.freeze({ KG: 'KG', PCS: 'PCS', NATIVE: 'NATIVE' })
export const MAX_PARTNER_BASE_QUANTITY = 9_999_999
export const MAX_PARTNER_AMOUNT_CENTS = 99_999_999_999n
export const BPS_DENOMINATOR = 10_000n
export const GRAMS_PER_KG = 1_000n

function pricingError(message, code = 'PARTNER_QUOTE_INVALID', status = 400) {
  const error = httpError(message, status)
  error.code = code
  return error
}

export function normalizePositiveSafeInteger(value, label = '数量') {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw pricingError(`${label}必须是正整数`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_PARTNER_BASE_QUANTITY) {
    throw pricingError(`${label}必须是 1-${MAX_PARTNER_BASE_QUANTITY} 的安全整数`)
  }
  return result
}

function normalizePositiveBigInt(value, label) {
  let result
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe')
    if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw new Error('invalid')
    result = BigInt(value)
  } catch {
    throw pricingError(`${label}必须是正整数`)
  }
  if (result < 1n || result > MAX_PARTNER_AMOUNT_CENTS) throw pricingError(`${label}超出允许范围`)
  return result
}

export function normalizeDiscountBps(value) {
  const result = normalizePositiveSafeInteger(value, '合作折扣')
  if (result > 10_000) throw pricingError('合作折扣必须在 1-10000 基点之间')
  return result
}

export function roundPositiveRatioHalfUp(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) throw pricingError('金额计算参数不正确')
  return (numerator + denominator / 2n) / denominator
}

export function validatePartnerQuantity({ quantityBase }) {
  return normalizePositiveSafeInteger(quantityBase)
}

export function calculatePartnerAmountCents({ orderUnit, quantityBase, basePriceCents, discountBps }) {
  const quantity = normalizePositiveSafeInteger(quantityBase)
  const price = normalizePositiveBigInt(basePriceCents, orderUnit === PARTNER_ORDER_UNITS.KG ? 'KG 标准补货价' : '商品标准售价')
  const discount = normalizeDiscountBps(discountBps)
  const denominator = orderUnit === PARTNER_ORDER_UNITS.KG
    ? GRAMS_PER_KG * BPS_DENOMINATOR
    : [PARTNER_ORDER_UNITS.PCS, PARTNER_ORDER_UNITS.NATIVE].includes(orderUnit)
      ? BPS_DENOMINATOR
      : null
  if (!denominator) throw pricingError('补货单位不正确', 'PARTNER_QUOTE_UNIT_INVALID')
  const amount = roundPositiveRatioHalfUp(BigInt(quantity) * price * BigInt(discount), denominator)
  if (amount > MAX_PARTNER_AMOUNT_CENTS) throw pricingError('Quote 金额超出允许范围', 'PARTNER_QUOTE_OVERFLOW', 409)
  return amount
}
