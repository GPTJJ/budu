import { httpError } from '../pos-core.js'

function refundableAmount(item) {
  const actual = BigInt(item.actualAmount ?? 0)
  return actual > 0n ? actual : BigInt(item.lineAmount) - BigInt(item.discountAmount || 0)
}

export function allocateManualExternalRefund(order, rawItems, refundAmount) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
    throw httpError('请选择退款商品')
  }
  const selected = []
  const selectedIds = new Set()
  for (const row of rawItems) {
    const orderItemId = String(row?.orderItemId || '').trim()
    const quantity = Number(row?.quantity)
    if (!orderItemId || !Number.isInteger(quantity) || quantity < 1) throw httpError('退款商品或数量不正确')
    if (selectedIds.has(orderItemId)) throw httpError('同一退款商品不能重复提交')
    selectedIds.add(orderItemId)
    selected.push({ orderItemId, quantity })
  }

  const byId = new Map(order.items.map((item) => [item.id, item]))
  const used = new Map()
  for (const refund of order.refunds || []) {
    if (!['pending', 'completed'].includes(refund.status)) continue
    for (const item of refund.items || []) {
      const current = used.get(item.orderItemId) || { quantity: 0, amount: 0n }
      current.quantity += item.quantity
      current.amount += BigInt(item.amountCents)
      used.set(item.orderItemId, current)
    }
  }

  const capacities = selected.map((selection) => {
    const item = byId.get(selection.orderItemId)
    if (!item) throw httpError('退款商品不存在于该订单')
    if (item.isGift === true) throw httpError('赠送商品没有可退收入金额')
    const before = used.get(item.id) || { quantity: 0, amount: 0n }
    if (before.quantity + selection.quantity > item.quantity) throw httpError(`「${item.productNameSnapshot}」可退数量不足`, 409)
    const lineActual = refundableAmount(item)
    const cumulativeCap = lineActual * BigInt(before.quantity + selection.quantity) / BigInt(item.quantity)
    const capacity = cumulativeCap - before.amount
    if (capacity < 0n) throw httpError(`「${item.productNameSnapshot}」退款金额事实异常`, 409)
    return { ...selection, capacity, productName: item.productNameSnapshot }
  })
  const totalCapacity = capacities.reduce((sum, row) => sum + row.capacity, 0n)
  if (refundAmount <= 0n) throw httpError('平台实际退款金额必须大于 0')
  if (refundAmount > totalCapacity) throw httpError('平台实际退款金额超过所选商品剩余可退金额', 409)

  let allocated = 0n
  const lines = capacities.map((row) => {
    const numerator = refundAmount * row.capacity
    const amountCents = totalCapacity === 0n ? 0n : numerator / totalCapacity
    allocated += amountCents
    return { ...row, amountCents, remainder: totalCapacity === 0n ? 0n : numerator % totalCapacity }
  })
  let remainder = refundAmount - allocated
  const byRemainder = [...lines].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1
    return a.orderItemId.localeCompare(b.orderItemId)
  })
  for (const line of byRemainder) {
    if (remainder === 0n) break
    if (line.amountCents < line.capacity) {
      line.amountCents += 1n
      remainder -= 1n
    }
  }
  if (remainder !== 0n) throw httpError('退款金额分摊无法严格守恒', 409)
  return lines
    .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId))
    .map(({ orderItemId, quantity, amountCents }) => ({ orderItemId, quantity, amountCents }))
}
