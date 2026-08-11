import crypto from 'node:crypto'

export function normalizeSku(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase()
}

export function parseCents(value, label = '金额') {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim()
  if (!/^\d+$/.test(text)) throw httpError(`${label}必须是非负整数（单位：分）`)
  const cents = BigInt(text)
  if (cents > 99999999999n) throw httpError(`${label}超出允许范围`)
  return cents
}

export function normalizeCartItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
    throw httpError('订单至少包含 1 个商品，且不能超过 100 行')
  }
  const lines = new Map()
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw httpError('订单商品格式不正确')
    if ('price' in row || 'unitPrice' in row || 'costPrice' in row || 'lineAmount' in row) {
      throw httpError('订单金额只能由服务器计算')
    }
    const productId = String(row.productId ?? '').trim()
    const quantity = Number(row.quantity)
    const gift = row.gift === true
    if (!productId || productId.length > 100) throw httpError('商品 ID 不正确')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw httpError('商品数量应为 1-999 的整数')
    }
    const prev = lines.get(productId) || { quantity: 0, gift: false }
    const next = prev.quantity + quantity
    if (next > 999) throw httpError('同一商品数量不能超过 999')
    lines.set(productId, { quantity: next, gift: prev.gift || gift })
  }
  return [...lines.entries()]
    .map(([productId, line]) => ({ productId, quantity: line.quantity, gift: line.gift }))
    .sort((a, b) => a.productId.localeCompare(b.productId))
}

export function hashCart(items) {
  const payload = Array.isArray(items) ? { items } : items
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function buildOrderSnapshot(products, items, options = {}) {
  const discountPercent = Number(options.discountPercent ?? 100)
  if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 100) {
    throw httpError('折扣必须是 1-100 之间的整数百分比')
  }
  const remark = String(options.remark ?? '').slice(0, 200)
  const byId = new Map(products.map((product) => [product.id, product]))
  const lines = items.map(({ productId, quantity, gift }) => {
    const product = byId.get(productId)
    if (!product || !product.isActive || !product.sku || product.salePriceCents == null || product.costPriceCents == null) {
      throw httpError('订单中包含不存在、未上架或资料不完整的商品', 409)
    }
    const unitPrice = BigInt(product.salePriceCents)
    const costPriceSnapshot = BigInt(product.costPriceCents)
    const isGift = gift === true
    const lineAmount = isGift ? 0n : unitPrice * BigInt(quantity)
    return {
      productId: product.id,
      productNameSnapshot: product.name,
      skuSnapshot: product.sku,
      skuId: product.sku || '',
      unitSnapshot: product.unit || '',
      unitPrice,
      costPriceSnapshot,
      quantity,
      lineAmount,
      isGift,
    }
  })
  // 折前金额包含赠送商品原价；实付只计算非赠送商品。
  // 因此优惠金额同时包含“赠送减免”和普通折扣减免。
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n)
  const chargeableAmount = lines.reduce((sum, line) => sum + line.lineAmount, 0n)
  const payableAmount = (chargeableAmount * BigInt(discountPercent) + 50n) / 100n
  const discountAmount = subtotal - payableAmount
  const paidLines = lines.filter((line) => !line.isGift)
  let allocated = 0n
  const finalizedLines = lines.map((line) => {
    const grossAmount = line.unitPrice * BigInt(line.quantity)
    if (line.isGift) return { ...line, discountAmount: grossAmount, actualAmount: 0n }
    const isLast = line === paidLines[paidLines.length - 1]
    const actualAmount = isLast
      ? payableAmount - allocated
      : (line.lineAmount * BigInt(discountPercent) + 50n) / 100n
    allocated += actualAmount
    return { ...line, discountAmount: grossAmount - actualAmount, actualAmount }
  })
  return { lines: finalizedLines, subtotal, discountAmount, payableAmount, discountPercent, remark }
}

export function httpError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}
