// ProductCategory.id is the classification authority. This is the existing
// 太妃糖12口味 category, not a product-name/weight heuristic or another switch.
export const PARTNER_CANDY_CATEGORY_IDS = Object.freeze(['pc-mtd9xjer-sfcmx2'])

export function isPartnerCandy(product) {
  return PARTNER_CANDY_CATEGORY_IDS.includes(product?.productCategoryId)
}

export function isPartnerUnitAllowed(product, unit = product?.partnerOrderUnit) {
  return !isPartnerCandy(product) || unit === 'PCS'
}
