export const PARTNER_PORTAL_TABS = Object.freeze(['home', 'replenish', 'orders', 'profile'])

export const PARTNER_ORDER_STATUS_LABELS = Object.freeze({
  SUBMITTED: '待审核',
  APPROVED: '待发货',
  PARTIALLY_SHIPPED: '部分发货 / 运输中',
  SHIPPED: '已发货',
  REJECTED: '已驳回',
  CANCELLED: '已取消',
})

export function partnerUnitLabel(orderUnit, nativeUnit = '') {
  if (orderUnit === 'KG') return 'kg'
  if (orderUnit === 'PCS') return '颗'
  return String(nativeUnit || '').trim() || '单位'
}

export function quantityLabel(quantityBase, orderUnit, nativeUnit = '') {
  const quantity = Number(quantityBase || 0)
  if (orderUnit === 'KG') return `${(quantity / 1000).toFixed(3).replace(/\.?0+$/, '') || '0'} kg`
  return `${quantity} ${partnerUnitLabel(orderUnit, nativeUnit)}`
}

export function displayQuantity(quantityBase, orderUnit) {
  return orderUnit === 'KG' ? String(Number(quantityBase || 0) / 1000) : String(Number(quantityBase || 0))
}

export function parseDisplayQuantity(value, orderUnit) {
  const text = String(value ?? '').trim()
  if (orderUnit !== 'KG') {
    if (!/^\d+$/.test(text)) return null
    const quantity = Number(text)
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null
  }
  const match = text.match(/^(\d+)(?:\.(\d{1,3}))?$/)
  if (!match) return null
  const grams = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'))
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null
}

export function quantityValidationMessage(product, quantityBase) {
  if (!Number.isSafeInteger(quantityBase) || quantityBase <= 0) return '请输入有效数量'
  return ''
}

export function adjustShortcutQuantity(quantityBase, orderUnit, direction) {
  const increment = orderUnit === 'KG' ? 100 : orderUnit === 'PCS' ? 10 : 1
  return Math.max(0, Number(quantityBase || 0) + (direction < 0 ? -increment : increment))
}

export function buildReorderDraft(order, catalogue) {
  const currentById = new Map(catalogue.map((product) => [product.productId, product]))
  const items = []
  const issues = []
  for (const historical of order.items || []) {
    const current = currentById.get(historical.inventoryItemId)
    if (!current) {
      issues.push(`${historical.productNameSnapshot} 当前已下架或不可补货`)
      continue
    }
    if (current.orderUnit !== historical.orderUnitSnapshot) {
      issues.push(`${historical.productNameSnapshot} 当前补货单位已变化，请重新选择数量`)
      continue
    }
    if (current.orderUnit === 'NATIVE' && current.nativeUnit !== historical.nativeUnitSnapshot) {
      issues.push(`${historical.productNameSnapshot} 当前商品单位已变化，请重新选择数量`)
      continue
    }
    const quantityBase = Number(historical.requestedQuantityBase)
    const validation = quantityValidationMessage(current, quantityBase)
    items.push({ productId: current.productId, quantityBase, validation })
    if (validation) issues.push(`${current.name}：${validation}`)
  }
  return { storeId: order.partnerStore?.id || '', items, issues }
}

export function buildPartnerSubmission({ partnerStoreId, selected, catalogue }) {
  const currentById = new Map(catalogue.map((product) => [product.productId, product]))
  if (!partnerStoreId) throw new Error('请选择收货门店')
  const items = Object.entries(selected).filter(([, quantityBase]) => Number(quantityBase) > 0).map(([productId, quantityBase]) => {
    const product = currentById.get(productId)
    if (!product) throw new Error('商品当前不可补货，请刷新')
    const validation = quantityValidationMessage(product, Number(quantityBase))
    if (validation) throw new Error(`${product.name}：${validation}`)
    return { inventoryItemId: product.productId, quantity: Number(quantityBase), orderUnit: product.orderUnit }
  })
  if (items.length === 0) throw new Error('请至少选择一项商品')
  return { partnerStoreId, items }
}

export function orderMatchesGroup(order, group) {
  if (group === 'pending') return order.status === 'SUBMITTED'
  if (group === 'fulfillment') return ['APPROVED', 'PARTIALLY_SHIPPED', 'SHIPPED'].includes(order.status)
  if (group === 'closed') return ['CANCELLED', 'REJECTED'].includes(order.status)
  return true
}
