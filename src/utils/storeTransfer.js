export const TRANSFER_VIEW_STATUS = Object.freeze({
  pending: 'pending',
  shipped: 'shipped',
  completed: 'shipped',
  in_transit: 'shipped',
  done: 'shipped',
  canceled: 'canceled',
  rejected: 'canceled',
})

export const TRANSFER_VIEW_STATUS_LABEL = Object.freeze({
  pending: '待备货',
  shipped: '已发货',
  canceled: '已撤回',
})

export function transferViewStatus(status) {
  return TRANSFER_VIEW_STATUS[String(status || '')] || 'unknown'
}

export function transferStatusLabel(status) {
  if (status === 'rejected') return '已驳回'
  if (status === 'canceled') return '已撤回'
  const view = transferViewStatus(status)
  return TRANSFER_VIEW_STATUS_LABEL[view] || '—'
}

export function validTransferQuantity(value) {
  const quantity = Number(value)
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 999999
}

export function initialTransferDraft() {
  return {
    product: { selectedNames: [], batchQuantity: '' },
    material: { quantities: {} },
  }
}

export function toggleDraftProduct(draft, name) {
  const selected = draft.product.selectedNames.includes(name)
    ? draft.product.selectedNames.filter((item) => item !== name)
    : [...draft.product.selectedNames, name]
  return { ...draft, product: { ...draft.product, selectedNames: selected } }
}

export function setDraftProductQuantity(draft, value) {
  return { ...draft, product: { ...draft.product, batchQuantity: value } }
}

export function setDraftMaterialQuantity(draft, name, value) {
  return {
    ...draft,
    material: { ...draft.material, quantities: { ...draft.material.quantities, [name]: value } },
  }
}

export function materialDraftItems(draft) {
  return Object.entries(draft.material.quantities)
    .filter(([, quantity]) => validTransferQuantity(quantity))
    .map(([productName, quantity]) => ({ category: 'material', productName, quantity: Number(quantity), note: '' }))
}

export function productDraftRows(draft) {
  if (!validTransferQuantity(draft.product.batchQuantity)) return []
  return draft.product.selectedNames.map((productName) => ({
    category: 'product',
    productName,
    quantity: Number(draft.product.batchQuantity),
    note: '',
  }))
}

export function mergeTransferItems(current, incoming) {
  const rows = [...current]
  for (const item of incoming) {
    const index = rows.findIndex((row) => row.category === item.category && row.productName === item.productName)
    if (index >= 0) rows[index] = { ...rows[index], ...item }
    else rows.push(item)
  }
  return rows
}

export function itemCountLabel(items) {
  const rows = Array.isArray(items) ? items : []
  return `${rows.length} 种 / ${rows.reduce((sum, item) => sum + Number(item.quantity || 0), 0)} 件`
}
