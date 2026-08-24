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
    const comboFlavorIds = Array.isArray(row.comboFlavorIds)
      ? row.comboFlavorIds.map((id) => String(id ?? '').trim()).filter(Boolean).slice(0, 20)
      : []
    if (!productId || productId.length > 100) throw httpError('商品 ID 不正确')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw httpError('商品数量应为 1-999 的整数')
    }
    if (comboFlavorIds.length > 0 && comboFlavorIds.length !== 4) throw httpError('礼盒搭配需选择 4 款口味')
    // 收费与赠送分开归并：同一商品可同时存在“收费行”和“赠送行”
    const comboKey = comboFlavorIds.length ? `\u0001${comboFlavorIds.join(',')}` : ''
    const key = `${productId}\u0000${gift ? 'gift' : 'normal'}${comboKey}`
    const prev = lines.get(key) || { productId, quantity: 0, gift, comboFlavorIds }
    const next = prev.quantity + quantity
    if (next > 999) throw httpError('同一商品数量不能超过 999')
    lines.set(key, { productId, quantity: next, gift, comboFlavorIds })
  }
  return [...lines.values()]
    .map((line) => ({ productId: line.productId, quantity: line.quantity, gift: line.gift, comboFlavorIds: line.comboFlavorIds }))
    .sort((a, b) => a.productId.localeCompare(b.productId) || Number(a.gift) - Number(b.gift))
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
  const lines = items.map(({ productId, quantity, gift, comboFlavorIds }) => {
    const product = byId.get(productId)
    if (!product || !product.isActive || !product.sku || product.salePriceCents == null || product.costPriceCents == null) {
      throw httpError('订单中包含不存在、未上架或资料不完整的商品', 409)
    }
    const unitPrice = BigInt(product.salePriceCents)
    const costPriceSnapshot = BigInt(product.costPriceCents)
    const isGift = gift === true
    const lineAmount = isGift ? 0n : unitPrice * BigInt(quantity)
    // Balls 礼盒搭配：口味明细拼进商品名快照（订单/小票可追溯）
    let productNameSnapshot = product.name
    if (Array.isArray(comboFlavorIds) && comboFlavorIds.length > 0) {
      const flavorNames = comboFlavorIds.map((id) => {
        const f = byId.get(id)
        return f ? String(f.name).replace(/^巧克力豆\./, '') : id
      })
      productNameSnapshot = `${product.name}（${flavorNames.join(' / ')}）`
    }
    return {
      productId: product.id,
      productNameSnapshot,
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

/**
 * 订单删除守卫（真实支付审计要求）：
 * - 存在任何支付记录的订单禁止删除；
 * - 已完成/处理中订单禁止删除；
 * - 删除不得级联清除 PaymentLog/支付历史（因此这里直接拒绝而非清理）。
 */
export function assertOrderDeletable(order) {
  if ((order.payments || []).length > 0) {
    throw httpError('存在支付记录的订单不可删除', 409)
  }
  if (['paid', 'completed', 'partially_refunded', 'refunded', 'pending_payment'].includes(order.status)) {
    throw httpError('已完成或处理中的订单不可删除', 409)
  }
}

/**
 * 订单取消守卫：存在未解决的微信支付（可能已扣款）时禁止取消，
 * 必须等查询/撤销到明确终态（failed/closed/revoked）后才能取消。
 */
export function assertOrderCancelable(order, unresolvedWechatPayment) {
  if (order.status === 'cancelled') return
  if (unresolvedWechatPayment) {
    throw httpError('订单存在未核对的微信支付，请先完成核对后再操作', 409)
  }
}

/** 门店作废权限：最高权限可处理全部；收银/店长可处理所属门店；员工仅处理本人订单。 */
export function canCancelOrder(user, order) {
  if (!user || !order || user.status === 'disabled' || user.role === 'public') return false
  if (['developer', 'admin', 'finance'].includes(user.role)) return true
  const sameStore = Array.isArray(user.storeKeys) && user.storeKeys.includes(order.storeId)
  if (!sameStore) return false
  if (user.role === 'cashier' || user.role === 'manager') return true
  return user.role === 'staff' && order.cashierId === user.id
}

/** 作废原因必须明确、短文本且不可包含控制字符，供永久审计展示。 */
export function normalizeOrderCancelReason(value) {
  const reason = String(value ?? '').trim()
  if (reason.length < 2) throw httpError('请选择或填写作废原因')
  if (reason.length > 100) throw httpError('作废原因不能超过 100 个字')
  if (/[\u0000-\u001f\u007f]/.test(reason)) throw httpError('作废原因包含无效字符')
  return reason
}

/**
 * 营收只认“已成功收款且从未进入退款流程”的干净订单。
 * 待支付/失败/异常订单，以及存在任意退款记录的订单，都不能进入营收、订单数和销量。
 */
export function buildRecognizedRevenueWhere(scope = {}) {
  return {
    AND: [
      scope,
      { status: { in: ['paid', 'completed'] } },
      { paymentStatus: 'paid' },
      { payments: { some: { status: 'success' } } },
      { refunds: { none: {} } },
    ],
  }
}
