const roundQty = (value) => Math.round((Number(value) || 0) * 100) / 100

export const TRANSFER_STATUS_LABEL = {
  pending: '待审核',
  in_transit: '运输中',
  completed: '已完成',
  rejected: '已驳回',
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

function changeInventory(rows, storeKey, items, direction, actor, now) {
  let next = Array.isArray(rows) ? rows : []
  for (const item of items) {
    const current = inventoryQuantity(next, storeKey, item.productName)
    const quantity = roundQty(current + direction * Number(item.quantity || 0))
    if (quantity < 0) throw new Error(`「${item.productName}」库存不足（当前 ${current}）`)
    next = setInventoryQuantity(next, storeKey, item.productName, quantity, actor, now)
  }
  return next
}

export function transitionInventoryRequest({ requests, inventory, id, action, actor, note = '', now = new Date() }) {
  const list = Array.isArray(requests) ? requests : []
  const target = list.find((request) => request.id === id)
  if (!target || target.type !== 'transfer') throw new Error('未找到该调货申请')
  const rules = {
    ship: { from: 'pending', to: 'in_transit', label: '审核通过并确认发货' },
    receive: { from: 'in_transit', to: 'completed', label: '确认收货' },
    reject: { from: 'pending', to: 'rejected', label: '驳回申请' },
  }
  const rule = rules[action]
  if (!rule || target.status !== rule.from) throw new Error('当前状态不能执行此操作')

  const iso = now.toISOString()
  let nextInventory = Array.isArray(inventory) ? inventory : []
  if (action === 'ship') {
    nextInventory = changeInventory(nextInventory, target.fromStoreKey, target.items, -1, actor, iso)
  } else if (action === 'receive') {
    nextInventory = changeInventory(nextInventory, target.storeKey, target.items, 1, actor, iso)
  }
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
  const updated = { ...target, status: rule.to, history, updatedAt: iso }
  return {
    requests: list.map((request) => (request.id === id ? updated : request)),
    inventory: nextInventory,
  }
}
