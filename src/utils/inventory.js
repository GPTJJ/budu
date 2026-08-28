const roundQty = (value) => Math.round((Number(value) || 0) * 100) / 100

export const TRANSFER_STATUS_LABEL = {
  pending: '待备货',
  shipped: '已发货',
  in_transit: '已发货',
  completed: '已发货',
  rejected: '已驳回',
  canceled: '已撤回',
}

export function inventoryQuantity(rows, storeKey, productName) {
  const row = (Array.isArray(rows) ? rows : []).find(
    (item) => item.storeKey === storeKey && item.productName === productName,
  )
  return roundQty(row?.quantity)
}

export function setInventoryQuantity(rows, storeKey, productName, quantity, actor, now = new Date().toISOString()) {
  const name = String(productName || '').trim()
  const nextQuantity = roundQty(quantity)
  if (!storeKey || !name) throw new Error('请选择门店并填写商品名称')
  if (nextQuantity < 0) throw new Error('库存数量不能小于 0')
  const next = (Array.isArray(rows) ? rows : []).filter(
    (row) => !(row.storeKey === storeKey && row.productName === name),
  )
  next.push({
    storeKey,
    productName: name,
    quantity: nextQuantity,
    updatedAt: now,
    updatedBy: actor?.username || '',
  })
  return next
}

export function transitionInventoryRequest({ requests, inventory, id, action, actor, note = '', now = new Date() }) {
  const list = Array.isArray(requests) ? requests : []
  const target = list.find((request) => request.id === id)
  if (!target || target.type !== 'transfer') throw new Error('未找到该门店调拨')
  const rules = {
    ship: { from: 'pending', to: 'shipped', label: '确认发货' },
    cancel: { from: 'pending', to: 'canceled', label: '撤回调拨' },
  }
  const rule = rules[action]
  if (!rule || target.status !== rule.from) throw new Error('当前状态不能执行此操作')

  const iso = now.toISOString()
  const nextInventory = Array.isArray(inventory) ? inventory : []
  const history = [
    ...(Array.isArray(target.history) ? target.history : []),
    {
      action: rule.label,
      status: rule.to,
      operator: actor?.username || '',
      at: iso,
      note: String(note || '').trim().slice(0, 100),
    },
  ]
  const audit = action === 'ship'
    ? { shippedBy: actor?.username || '', shippedAt: iso }
    : { withdrawnBy: actor?.username || '', withdrawnAt: iso }
  const updated = { ...target, ...audit, status: rule.to, history, updatedAt: iso }
  return {
    requests: list.map((request) => (request.id === id ? updated : request)),
    inventory: nextInventory,
  }
}
