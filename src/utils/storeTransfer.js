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
    product: { selectedIds: [], batchQuantity: '', unitQuantities: {} },
    material: { quantities: {} },
  }
}

export function isPackagedTransferItem(item) {
  return Boolean(item?.transferBoxEnabled || item?.transferPieceEnabled)
}

export function toggleDraftProduct(draft, itemId) {
  const selected = draft.product.selectedIds.includes(itemId)
    ? draft.product.selectedIds.filter((id) => id !== itemId)
    : [...draft.product.selectedIds, itemId]
  return { ...draft, product: { ...draft.product, selectedIds: selected } }
}

export function setDraftProductQuantity(draft, value) {
  return { ...draft, product: { ...draft.product, batchQuantity: value } }
}

export function setDraftProductUnitQuantity(draft, itemId, unit, value) {
  const current = draft.product.unitQuantities[itemId] || { boxQuantity: '', pieceQuantity: '' }
  return {
    ...draft,
    product: {
      ...draft.product,
      unitQuantities: {
        ...draft.product.unitQuantities,
        [itemId]: { ...current, [unit === 'box' ? 'boxQuantity' : 'pieceQuantity']: value },
      },
    },
  }
}

export function setDraftMaterialQuantity(draft, itemId, value) {
  return {
    ...draft,
    material: { ...draft.material, quantities: { ...draft.material.quantities, [itemId]: value } },
  }
}

export function materialDraftItems(draft, masterItems = []) {
  const byId = new Map(masterItems.map((item) => [item.id, item]))
  return Object.entries(draft.material.quantities)
    .filter(([, quantity]) => validTransferQuantity(quantity))
    .flatMap(([itemId, quantity]) => {
      const item = byId.get(itemId)
      return item ? [{ itemId, category: 'material', productName: item.name, quantity: Number(quantity), note: '' }] : []
    })
}

export function productDraftRows(draft, masterItems) {
  const byId = new Map((masterItems || []).map((item) => [item.id, item]))
  return draft.product.selectedIds.flatMap((itemId) => {
    const item = byId.get(itemId)
    if (!item) return []
    if (!isPackagedTransferItem(item)) {
      if (!validTransferQuantity(draft.product.batchQuantity)) return []
      return [{ itemId, category: 'product', productName: item.name, quantity: Number(draft.product.batchQuantity), note: '' }]
    }
    const values = draft.product.unitQuantities[itemId] || {}
    const boxQuantity = Number(values.boxQuantity || 0)
    const pieceQuantity = Number(values.pieceQuantity || 0)
    if ((!Number.isInteger(boxQuantity) || boxQuantity < 0 || boxQuantity > 999999)
      || (!Number.isInteger(pieceQuantity) || pieceQuantity < 0 || pieceQuantity > 999999)
      || (boxQuantity === 0 && pieceQuantity === 0)) return []
    return [{
      itemId,
      category: 'product',
      productName: item.name,
      quantity: null,
      boxQuantity,
      pieceQuantity,
      boxWeightGrams: item.transferBoxWeightGrams || null,
      pieceWeightGrams: item.transferPieceWeightGrams || null,
      note: '',
    }]
  })
}

export function validTransferItemQuantity(item) {
  if (!isPackagedTransferItem(item) && item?.quantity !== null) return validTransferQuantity(item?.quantity)
  const boxQuantity = Number(item?.boxQuantity || 0)
  const pieceQuantity = Number(item?.pieceQuantity || 0)
  return Number.isInteger(boxQuantity) && boxQuantity >= 0 && boxQuantity <= 999999
    && Number.isInteger(pieceQuantity) && pieceQuantity >= 0 && pieceQuantity <= 999999
    && (boxQuantity > 0 || pieceQuantity > 0)
}

export function transferQuantityLabel(item) {
  if (isPackagedTransferItem(item) || item?.quantity === null) {
    return [Number(item?.boxQuantity || 0) > 0 ? `${Number(item.boxQuantity)}箱` : '', Number(item?.pieceQuantity || 0) > 0 ? `${Number(item.pieceQuantity)}颗` : ''].filter(Boolean).join(' + ') || '0'
  }
  return `${Number(item?.quantity || 0)}件`
}

export function transferShipmentRecorded(item) {
  return item?.shipmentRecorded === true
}

export function transferShippedQuantityLabel(item) {
  if (!transferShipmentRecorded(item)) return transferQuantityLabel(item)
  if (isPackagedTransferItem(item) || item?.quantity === null) {
    return [Number(item?.shippedBoxQuantity || 0) > 0 ? `${Number(item.shippedBoxQuantity)}箱` : '', Number(item?.shippedPieceQuantity || 0) > 0 ? `${Number(item.shippedPieceQuantity)}颗` : ''].filter(Boolean).join(' + ') || '0'
  }
  return `${Number(item?.shippedQuantity || 0)}件`
}

export function transferShipmentDiffers(item) {
  if (!transferShipmentRecorded(item)) return false
  if (isPackagedTransferItem(item) || item?.quantity === null) {
    return Number(item?.boxQuantity || 0) !== Number(item?.shippedBoxQuantity || 0)
      || Number(item?.pieceQuantity || 0) !== Number(item?.shippedPieceQuantity || 0)
  }
  return Number(item?.quantity || 0) !== Number(item?.shippedQuantity || 0)
}

export function buildTransferShipmentDraft(request) {
  return (request?.items || []).map((item) => (
    isPackagedTransferItem(item) || item?.quantity === null
      ? {
          itemId: item.itemId,
          shippedBoxQuantity: Number(item.boxQuantity || 0),
          shippedPieceQuantity: Number(item.pieceQuantity || 0),
        }
      : { itemId: item.itemId, shippedQuantity: Number(item.quantity || 0) }
  ))
}

export function validateTransferShipmentDraft(request, shipmentItems) {
  const requested = Array.isArray(request?.items) ? request.items : []
  const shipped = Array.isArray(shipmentItems) ? shipmentItems : []
  if (!requested.length || shipped.length !== requested.length) return '实际发货明细必须与原申请完全一致'
  const byId = new Map()
  for (const item of shipped) {
    if (!item?.itemId || byId.has(item.itemId)) return '实际发货明细必须与原申请完全一致'
    byId.set(item.itemId, item)
  }
  let total = 0
  for (const item of requested) {
    const actual = byId.get(item.itemId)
    if (!actual) return '实际发货明细必须与原申请完全一致'
    if (isPackagedTransferItem(item) || item?.quantity === null) {
      const box = Number(actual.shippedBoxQuantity)
      const piece = Number(actual.shippedPieceQuantity)
      if (!Number.isInteger(box) || box < 0 || box > Number(item.boxQuantity || 0)) return `「${item.productName}」实发箱数不能超过申请`
      if (!Number.isInteger(piece) || piece < 0 || piece > Number(item.pieceQuantity || 0)) return `「${item.productName}」实发颗数不能超过申请`
      total += box + piece
    } else {
      const quantity = Number(actual.shippedQuantity)
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > Number(item.quantity || 0)) return `「${item.productName}」实发数量不能超过申请`
      total += quantity
    }
  }
  return total > 0 ? '' : '没有实际发货商品'
}

export function transferEstimatedWeightGrams(item) {
  if (Number.isFinite(Number(item?.estimatedWeightGrams))) return Number(item.estimatedWeightGrams)
  return Number(item?.boxQuantity || 0) * Number(item?.boxWeightGrams || 0)
    + Number(item?.pieceQuantity || 0) * Number(item?.pieceWeightGrams || 0)
}

export function transferEstimatedWeightLabel(item) {
  const grams = transferEstimatedWeightGrams(item)
  return grams > 0 ? `约${(grams / 1000).toFixed(2)}kg` : ''
}

export function transferShippedEstimatedWeightGrams(item) {
  if (!transferShipmentRecorded(item)) return transferEstimatedWeightGrams(item)
  return Number(item?.shippedBoxQuantity || 0) * Number(item?.boxWeightGrams || 0)
    + Number(item?.shippedPieceQuantity || 0) * Number(item?.pieceWeightGrams || 0)
}

export function mergeTransferItems(current, incoming) {
  const rows = [...current]
  for (const item of incoming) {
    const index = rows.findIndex((row) => row.category === item.category && (item.itemId ? row.itemId === item.itemId : row.productName === item.productName))
    if (index >= 0) rows[index] = { ...rows[index], ...item }
    else rows.push(item)
  }
  return rows
}

export function itemCountLabel(items) {
  const rows = Array.isArray(items) ? items : []
  const groups = ['product', 'material'].map((category) => {
    const categoryRows = rows.filter((item) => item.category === category)
    if (!categoryRows.length) return ''
    const boxes = categoryRows.reduce((sum, item) => sum + Number(item.boxQuantity || 0), 0)
    const pieces = categoryRows.reduce((sum, item) => sum + Number(item.pieceQuantity || 0), 0)
    const legacy = categoryRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
    const quantities = [boxes > 0 ? `${boxes}箱` : '', pieces > 0 ? `${pieces}颗` : '', legacy > 0 ? `${legacy}件` : ''].filter(Boolean).join(' + ')
    return `${categoryRows.length}种${category === 'product' ? '产品' : '物料'}${quantities ? ` · ${quantities}` : ''}`
  }).filter(Boolean)
  return groups.join(' / ') || '0种'
}

export function transferDeliveryCardSummary(value) {
  const successful = Array.isArray(value?.successful) ? value.successful : []
  const undelivered = Array.isArray(value?.undelivered) ? value.undelivered : []
  if (successful.length === 0 && undelivered.length === 0) {
    return { empty: true, recipientText: '', undeliveredText: '' }
  }
  const first = successful.slice(0, 2).map((row) => row.label).filter(Boolean)
  const recipientText = successful.length > 2 ? `${first.join('、')} 等${successful.length}人` : first.join('、')
  const allPeople = undelivered.every((row) => ['individual', 'developer'].includes(row.type))
  return {
    empty: false,
    recipientText,
    undeliveredText: undelivered.length > 0 ? `${undelivered.length}${allPeople ? '人' : '项'}未投递` : '',
  }
}

export function transferDeliveryReasonLabel(reason) {
  if (reason === 'NO_WECOM_BINDING') return '未绑定企业微信'
  if (reason === 'CHANNEL_NOT_CONFIGURED') return '通知通道未配置'
  if (reason === 'NOT_DELIVERED') return '未投递'
  return '发送失败'
}
