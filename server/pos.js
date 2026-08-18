import crypto from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, dbReady } from './pg.js'
import { serializeProduct } from './products.js'
import { buildOrderSnapshot, hashCart, httpError, normalizeCartItems } from './pos-core.js'
import { paymentService } from './payments/index.js'
import { paymentMode, serializePayment } from './payments/payment-service.js'
import { assertOrderTransition } from './order-state.js'
import { resolveStoreName } from './store-names.js'

export const posRouter = Router()

const wrap = (handler) => async (req, res) => {
  try { await handler(req, res) } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[pos]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function requirePosUser(user) {
  if (!user || !['developer', 'manager', 'staff', 'cashier'].includes(user.role)) throw httpError('无权限', 403)
}

function canStore(user, storeId) {
  if (!user || user.role === 'public') return false
  if (user.role === 'developer') return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeId)
}

function canReadOrder(user, order) {
  if (!canStore(user, order.storeId)) return false
  return user.role === 'developer' || order.cashierId === user.id
}

function paymentAuthCode(body, channel) {
  if (!['wechat', 'alipay'].includes(channel)) return ''
  const authCode = String(body?.authCode ?? '').trim()
  if (authCode.length < 6 || authCode.length > 512 || /[\u0000-\u001f\u007f]/.test(authCode)) {
    throw httpError('请扫描有效的顾客付款码')
  }
  return authCode
}

const orderInclude = () => ({
  store: true,
  items: { orderBy: { id: 'asc' } },
  payments: { orderBy: { createdAt: 'desc' } },
  refunds: { orderBy: { createdAt: 'desc' }, include: { items: { include: { orderItem: true } } } },
})

function serializeRefund(refund) {
  return {
    id: refund.id,
    refundNo: refund.refundNo,
    orderId: refund.orderId,
    paymentId: refund.paymentId,
    amount: refund.refundAmount.toString(),
    reason: refund.reason,
    status: refund.status,
    providerRefundNo: refund.providerRefundNo,
    requestedBy: refund.requestedBy,
    approvedBy: refund.approvedBy,
    createdAt: refund.createdAt,
    completedAt: refund.completedAt,
    items: (refund.items || []).map((item) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      productName: item.orderItem?.productNameSnapshot || '',
      quantity: item.quantity,
      amountCents: item.amountCents.toString(),
    })),
  }
}

function serializeOrder(order) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    storeId: order.storeId,
    storeName: order.store ? resolveStoreName(order.store.key, order.store.name) : order.storeId,
    cashierId: order.cashierId,
    cashierNameSnapshot: order.cashierNameSnapshot,
    subtotal: order.subtotal.toString(),
    discountAmount: order.discountAmount.toString(),
    payableAmount: order.payableAmount.toString(),
    businessDate: order.businessDate ? order.businessDate.toISOString().slice(0, 10) : null,
    discountPercent: order.discountPercent ?? 100,
    remark: order.remark || '',
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    paymentMode: order.paymentMode,
    checkoutKey: order.checkoutKey,
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    completedAt: order.completedAt,
    payments: (order.payments || []).map(serializePayment),
    refunds: (order.refunds || []).map(serializeRefund),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productNameSnapshot: item.productNameSnapshot,
      skuSnapshot: item.skuSnapshot,
      unitSnapshot: item.unitSnapshot,
      unitPrice: item.unitPrice.toString(),
      costPriceSnapshot: item.costPriceSnapshot.toString(),
      quantity: item.quantity,
      lineAmount: item.lineAmount.toString(),
      discountAmount: item.discountAmount.toString(),
      actualAmount: item.actualAmount.toString(),
      isGift: item.isGift === true,
    })),
  }
}

function replayOrder(existing, user, storeId, cartHash) {
  if (existing.cashierId !== user.id || existing.storeId !== storeId || existing.cartHash !== cartHash) {
    throw httpError('结算标识已用于另一笔订单，请重新发起结算', 409)
  }
  return existing
}

function buildOrderWhere(user, query = {}) {
  const where = {}
  const allowed = Array.isArray(user.storeKeys) ? user.storeKeys : []
  if (user.role !== 'developer') {
    where.storeId = { in: allowed }
    // 门店收银：查看本店全部订单（收银数据），不按收银员过滤
    if (user.role !== 'cashier') {
      where.cashierId = user.id
    }
  }
  const storeId = String(query.store || '').trim()
  if (storeId && (user.role === 'developer' || allowed.includes(storeId))) where.storeId = storeId
  const from = String(query.from || '').trim()
  const to = String(query.to || '').trim()
  const range = {}
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) range.gte = new Date(`${from}T00:00:00+08:00`)
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const end = new Date(`${to}T00:00:00+08:00`)
    end.setDate(end.getDate() + 1)
    range.lt = end
  }
  if (range.gte || range.lt) where.createdAt = range
  const paymentMethod = String(query.paymentMethod || '').trim()
  if (['wechat', 'alipay', 'cash'].includes(paymentMethod)) where.paymentMethod = paymentMethod
  const status = String(query.status || '').trim()
  if (['draft', 'pending_payment', 'paid', 'completed', 'cancelled', 'partially_refunded', 'refunded'].includes(status)) {
    where.status = status
  }
  const q = String(query.q || '').trim()
  if (q) where.orderNo = { contains: q, mode: 'insensitive' }
  return where
}

posRouter.get('/pos/config', wrap(async (req, res) => {
  requirePosUser(req.user)
  const mode = paymentMode()
  // 微信/支付宝扫码支付尚未开通：结算界面两通道显示「暂未开通」且不可点击；开通后在 channels 中放开
  const channels = ['cash']
  res.json({ mode, mock: mode === 'mock', channels })
}))

posRouter.get('/pos/orders', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const where = buildOrderWhere(req.user, req.query)
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderInclude(), orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.order.count({ where }),
  ])
  res.json({ ok: true, total, rows: rows.map(serializeOrder) })
}))

posRouter.delete('/pos/orders/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  if (req.user.role !== 'developer') throw httpError('仅开发者可删除订单', 403)
  const order = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!order) throw httpError('订单不存在', 404)
  await prisma.$transaction(async (tx) => {
    await tx.paymentLog.deleteMany({ where: { orderId: order.id } })
    await tx.refund.deleteMany({ where: { orderId: order.id } })
    await tx.payment.deleteMany({ where: { orderId: order.id } })
    await tx.orderItem.deleteMany({ where: { orderId: order.id } })
    await tx.order.delete({ where: { id: order.id } })
  })
  res.json({ ok: true })
}))

posRouter.post('/pos/orders/:id/refunds', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const current = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!current) throw httpError('订单不存在', 404)
  const allowed = req.user.role !== 'public' && canStore(req.user, current.storeId)
  if (!allowed) throw httpError('无退款权限', 403)
  const result = await paymentService.createRefund({
    orderId: current.id,
    items: req.body?.items,
    reason: req.body?.reason,
    requestKey: req.body?.requestKey,
    operator: req.user.username,
  })
  const order = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude() })
  res.status(201).json({ ok: true, refund: serializeRefund(result.refund), order: serializeOrder(order) })
}))

posRouter.get('/pos/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const rows = await prisma.inventoryItem.findMany({
    where: { isActive: true, sku: { not: null }, salePriceCents: { not: null }, costPriceCents: { not: null } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  res.json({
    rows: rows.map((product) => ({ ...serializeProduct(product), image: '', hasImage: Boolean(product.image) })),
  })
}))

posRouter.get('/pos/products/:productId/image', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const product = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId } })
  if (!product || !product.image) throw httpError('商品图片不存在', 404)
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.*)$/i.exec(String(product.image))
  if (!match) throw httpError('商品图片格式不正确', 400)
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.setHeader('Content-Type', `image/${match[1]}`)
  res.send(Buffer.from(match[2], 'base64'))
}))

posRouter.post('/pos/orders', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const storeId = String(req.body?.storeId ?? '').trim()
  const checkoutKey = String(req.body?.checkoutKey ?? '').trim()
  if (!canStore(req.user, storeId)) throw httpError('无权在该门店点单', 403)
  if (checkoutKey.length < 8 || checkoutKey.length > 100) throw httpError('结算标识不正确')
  const normalizedItems = normalizeCartItems(req.body?.items)
  const discountPercent = Number(req.body?.discountPercent ?? 100)
  const remark = String(req.body?.remark ?? '').slice(0, 200)
  const cartHash = hashCart({ items: normalizedItems, discountPercent, remark })
  const previous = await prisma.order.findUnique({ where: { checkoutKey }, include: orderInclude() })
  if (previous) return res.json({ ok: true, reused: true, order: serializeOrder(replayOrder(previous, req.user, storeId, cartHash)) })

  const store = await prisma.store.findUnique({ where: { key: storeId } })
  if (!store) throw httpError('门店不存在，请先同步门店资料', 404)
  const products = await prisma.inventoryItem.findMany({ where: { id: { in: normalizedItems.map((item) => item.productId) } } })
  const snapshot = buildOrderSnapshot(products, normalizedItems, { discountPercent, remark })
  const now = new Date()
  const businessDate = new Date(`${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`)
  const id = `ord-${crypto.randomUUID()}`
  const orderNo = `POS${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`

  try {
    const order = await prisma.order.create({
      data: {
        id, orderNo, storeId, cashierId: req.user.id, cashierNameSnapshot: req.user.username,
        subtotal: snapshot.subtotal, discountAmount: snapshot.discountAmount, payableAmount: snapshot.payableAmount,
        businessDate,
        discountPercent: snapshot.discountPercent, remark: snapshot.remark,
        checkoutKey, cartHash, status: 'pending_payment', paymentStatus: 'unpaid',
        items: { create: snapshot.lines.map((line) => ({ id: `oi-${crypto.randomUUID()}`, ...line })) },
      },
      include: orderInclude(),
    })
    return res.status(201).json({ ok: true, reused: false, order: serializeOrder(order) })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const existing = await prisma.order.findUnique({ where: { checkoutKey }, include: orderInclude() })
    if (!existing) throw httpError('订单号冲突，请重新结算', 409)
    return res.json({ ok: true, reused: true, order: serializeOrder(replayOrder(existing, req.user, storeId, cartHash)) })
  }
}))

posRouter.get('/pos/orders/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude() })
  if (!order) throw httpError('订单不存在', 404)
  if (!canReadOrder(req.user, order)) throw httpError('无权限', 403)
  res.json({ order: serializeOrder(order) })
}))

posRouter.post('/pos/orders/:id/payments', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const current = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!current) throw httpError('订单不存在', 404)
  if (!canReadOrder(req.user, current)) throw httpError('无权限', 403)
  const channel = String(req.body?.channel || '')
  const result = await paymentService.createPayment({
    orderId: current.id,
    channel,
    requestKey: req.body?.requestKey,
    paymentMethod: req.body?.paymentMethod,
    ...(paymentMode() === 'mock'
      ? { scenario: req.body?.mockScenario || 'success', callbackDelayMs: req.body?.callbackDelayMs }
      : {}),
    authCode: paymentAuthCode(req.body, channel),
  })
  res.status(result.reused ? 200 : 201).json({
    ok: true,
    reused: result.reused,
    payment: serializePayment(result.payment),
    order: serializeOrder(result.order),
  })
}))

posRouter.get('/pos/payments/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const result = await paymentService.result(req.params.id)
  if (!canReadOrder(req.user, result.order)) throw httpError('无权限', 403)
  res.json({ payment: serializePayment(result.payment), order: serializeOrder(result.order) })
}))

posRouter.post('/pos/payments/:id/query', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const before = await paymentService.result(req.params.id)
  if (!canReadOrder(req.user, before.order)) throw httpError('无权限', 403)
  const result = await paymentService.queryPayment(req.params.id)
  res.json({ payment: serializePayment(result.payment), order: serializeOrder(result.order) })
}))

posRouter.post('/pos/payments/:id/close', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const before = await paymentService.result(req.params.id)
  if (!canReadOrder(req.user, before.order)) throw httpError('无权限', 403)
  const result = await paymentService.closePayment(req.params.id)
  res.json({ ok: true, payment: serializePayment(result.payment), order: serializeOrder(result.order) })
}))

posRouter.post('/pos/orders/:id/cancel', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  let current = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!current) throw httpError('订单不存在', 404)
  if (!canReadOrder(req.user, current)) throw httpError('无权限', 403)
  if (current.status === 'cancelled') {
    const order = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude() })
    return res.json({ ok: true, order: serializeOrder(order) })
  }
  assertOrderTransition(current.status, 'cancelled')
  const active = await paymentService.activePayment(current.id)
  if (active?.status === 'success') throw httpError('订单已支付成功，不能取消', 409)
  if (active) await paymentService.closePayment(active.id)
  current = await prisma.order.findUnique({ where: { id: current.id } })
  const changed = await prisma.order.updateMany({
    where: { id: current.id, status: current.status },
    data: { status: 'cancelled', version: { increment: 1 } },
  })
  if (changed.count !== 1) throw httpError('订单状态已变化，请刷新后重试', 409)
  const order = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude() })
  res.json({ ok: true, order: serializeOrder(order) })
}))

// V1 compatibility: old clients still complete through the PaymentService.
posRouter.post('/pos/orders/:id/complete', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const paymentMethod = String(req.body?.paymentMethod ?? '')
  if (!['wechat', 'alipay', 'cash'].includes(paymentMethod)) throw httpError('支付方式不正确')
  const current = await prisma.order.findUnique({ where: { id: req.params.id } })
  if (!current) throw httpError('订单不存在', 404)
  if (!canReadOrder(req.user, current)) throw httpError('无权限', 403)
  if (current.status === 'completed' && current.paymentStatus === 'paid') {
    const order = await prisma.order.findUnique({ where: { id: current.id }, include: orderInclude() })
    return res.json({ ok: true, order: serializeOrder(order) })
  }
  const result = await paymentService.createPayment({
    orderId: current.id,
    channel: paymentMethod,
    requestKey: `v1:${current.id}:${paymentMethod}`,
    paymentMethod: 'cashier-confirm',
  })
  res.json({ ok: true, payment: serializePayment(result.payment), order: serializeOrder(result.order) })
}))
