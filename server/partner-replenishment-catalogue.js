import { isPartnerUnitAllowed } from '../shared/partnerProductUnits.js'
import { assertPartnerCanCreateBusiness } from './partner-domain-policy.js'
import {
  PARTNER_ORDER_UNITS,
  calculatePartnerAmountCents,
  validatePartnerQuantity,
} from './partner-replenishment-pricing.js'
import { httpError } from './pos-core.js'

export const partnerCatalogueSelect = Object.freeze({
  id: true,
  name: true,
  sku: true,
  spec: true,
  unit: true,
  isActive: true,
  category: true,
  productCategoryId: true,
  productCategory: { select: { id: true, name: true, sortOrder: true } },
  salePriceCents: true,
  partnerReplenishmentEnabled: true,
  partnerOrderUnit: true,
  partnerKgBasePriceCents: true,
  partnerMinOrderBaseQty: true,
  partnerOrderStepBaseQty: true,
  updatedAt: true,
})

const AUTHORITY_INPUT_KEYS = Object.freeze([
  'partnerId', 'discountBps', 'defaultDiscountBps', 'basePriceCents',
  'kgBasePriceCents', 'partnerKgBasePriceCents', 'piecePriceCents',
  'salePriceCents', 'unitPriceCents', 'finalAmountCents', 'amountCents',
])

function quoteError(message, code, status = 400) {
  const error = httpError(message, status)
  error.code = code
  return error
}

export function assertNoQuoteAuthorityInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw quoteError('Quote 请求格式不正确', 'PARTNER_QUOTE_INPUT_INVALID')
  if (AUTHORITY_INPUT_KEYS.some((key) => Object.hasOwn(body, key))) {
    throw quoteError('价格、折扣和合作商身份只能由服务器决定', 'PARTNER_QUOTE_AUTHORITY_INPUT_REJECTED')
  }
}

export function isCatalogueEligible(product) {
  if (!product || product.category !== 'product' || product.partnerReplenishmentEnabled !== true || !product.sku) return false
  if (!isPartnerUnitAllowed(product)) return false
  if (product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG) return product.partnerKgBasePriceCents != null && BigInt(product.partnerKgBasePriceCents) > 0n
  if (product.partnerOrderUnit === PARTNER_ORDER_UNITS.PCS) return product.salePriceCents != null && BigInt(product.salePriceCents) > 0n
  if (product.partnerOrderUnit === PARTNER_ORDER_UNITS.NATIVE) return Boolean(String(product.unit || '').trim()) && product.salePriceCents != null && BigInt(product.salePriceCents) > 0n
  return false
}

export function partnerBasePriceCents(product) {
  return product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG
    ? BigInt(product.partnerKgBasePriceCents)
    : BigInt(product.salePriceCents)
}

function catalogueDto(product, discountBps) {
  const basePriceCents = partnerBasePriceCents(product)
  const referenceQuantityBase = product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG ? 1000 : 1
  return {
    productId: product.id,
    name: product.name,
    sku: product.sku,
    spec: product.spec || '',
    productCategory: product.productCategory ? {
      id: product.productCategory.id,
      name: product.productCategory.name,
      sortOrder: product.productCategory.sortOrder,
    } : null,
    orderUnit: product.partnerOrderUnit,
    basePriceCents: basePriceCents.toString(),
    basePriceUnit: product.partnerOrderUnit === PARTNER_ORDER_UNITS.NATIVE ? 'NATIVE' : product.partnerOrderUnit,
    nativeUnit: product.partnerOrderUnit === PARTNER_ORDER_UNITS.NATIVE ? product.unit : '',
    discountBps,
    referencePriceCents: calculatePartnerAmountCents({
      orderUnit: product.partnerOrderUnit,
      quantityBase: referenceQuantityBase,
      basePriceCents,
      discountBps,
    }).toString(),
    minimumOrderBaseQty: 1,
    orderStepBaseQty: 1,
    shortcutIncrementBaseQty: product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG ? 100 : product.partnerOrderUnit === PARTNER_ORDER_UNITS.PCS ? 10 : 1,
    quantityAuthority: product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG ? 'INTEGER_GRAMS' : product.partnerOrderUnit === PARTNER_ORDER_UNITS.PCS ? 'INTEGER_PIECES' : 'INTEGER_NATIVE_UNITS',
    productUpdatedAt: new Date(product.updatedAt).toISOString(),
  }
}

export async function listPartnerCatalogue({ db, principal }) {
  const partner = await db.partner.findUnique({ where: { id: principal.partnerId } })
  if (!partner) throw quoteError('合作商不存在', 'PARTNER_NOT_FOUND', 404)
  assertPartnerCanCreateBusiness(partner)
  const products = await db.inventoryItem.findMany({
    where: { category: 'product', partnerReplenishmentEnabled: true },
    select: partnerCatalogueSelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  return products.filter(isCatalogueEligible).map((product) => catalogueDto(product, partner.defaultDiscountBps))
}

export async function quotePartnerCatalogueItem({ db, principal, body }) {
  assertNoQuoteAuthorityInput(body)
  const productId = String(body.productId || '').trim()
  const requestedUnit = String(body.orderUnit || '').trim().toUpperCase()
  if (!productId || productId.length > 120) throw quoteError('商品 ID 不正确', 'PARTNER_QUOTE_PRODUCT_INVALID')
  const [partner, product] = await Promise.all([
    db.partner.findUnique({ where: { id: principal.partnerId } }),
    db.inventoryItem.findUnique({ where: { id: productId }, select: partnerCatalogueSelect }),
  ])
  if (!partner) throw quoteError('合作商不存在', 'PARTNER_NOT_FOUND', 404)
  assertPartnerCanCreateBusiness(partner)
  if (product && !isPartnerUnitAllowed(product, requestedUnit)) throw quoteError('糖果合作商补货仅支持单颗 PCS', 'PARTNER_CANDY_PCS_ONLY', 409)
  if (!isCatalogueEligible(product)) throw quoteError('商品当前不可补货', 'PARTNER_QUOTE_PRODUCT_UNAVAILABLE', 409)
  if (requestedUnit !== product.partnerOrderUnit) throw quoteError('请求单位与商品补货单位不一致', 'PARTNER_QUOTE_UNIT_MISMATCH', 409)
  const quantityKey = product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG ? 'quantityGrams' : product.partnerOrderUnit === PARTNER_ORDER_UNITS.PCS ? 'quantityPieces' : 'quantityUnits'
  const forbiddenQuantityKeys = ['quantityGrams', 'quantityPieces', 'quantityUnits'].filter((key) => key !== quantityKey)
  if (forbiddenQuantityKeys.some((key) => Object.hasOwn(body, key))) throw quoteError('请求数量单位不一致', 'PARTNER_QUOTE_UNIT_MISMATCH', 409)
  const quantityBase = validatePartnerQuantity({ quantityBase: body[quantityKey] })
  const basePriceCents = partnerBasePriceCents(product)
  const finalAmountCents = calculatePartnerAmountCents({
    orderUnit: product.partnerOrderUnit,
    quantityBase,
    basePriceCents,
    discountBps: partner.defaultDiscountBps,
  })
  return {
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    orderUnit: product.partnerOrderUnit,
    quantityBase,
    nativeUnit: product.partnerOrderUnit === PARTNER_ORDER_UNITS.NATIVE ? product.unit : '',
    quantityAuthority: product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG ? 'INTEGER_GRAMS' : product.partnerOrderUnit === PARTNER_ORDER_UNITS.PCS ? 'INTEGER_PIECES' : 'INTEGER_NATIVE_UNITS',
    ...(product.partnerOrderUnit === PARTNER_ORDER_UNITS.KG ? { quantityGrams: quantityBase } : product.partnerOrderUnit === PARTNER_ORDER_UNITS.PCS ? { quantityPieces: quantityBase } : { quantityUnits: quantityBase }),
    basePriceCents: basePriceCents.toString(),
    discountBps: partner.defaultDiscountBps,
    finalAmountCents: finalAmountCents.toString(),
    rounding: 'HALF_UP_AT_FINAL_CENT',
    productUpdatedAt: new Date(product.updatedAt).toISOString(),
  }
}
