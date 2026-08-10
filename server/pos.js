import crypto from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, dbReady } from './pg.js'
import { serializeProduct } from './products.js'
import { buildOrderSnapshot, hashCart, httpError, normalizeCartItems } from './pos-core.js'

export const posRouter = Router()

const wrap = (handler) => async (req, res) => {
  try { await handler(req, res) } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[pos]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function requirePosUser(user) {
  if (!user || !['developer', 'manager', 'staff'].includes(user.role)) throw httpError('无权限', 403)
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

const orderInclude = () => ({ store: true, items: { orderBy: { id: 'asc' } } })

function serializeOrder(order) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    storeId: order.storeId,
    storeName: order.store?.name || order.storeId,
    cashierId: order.cashierId,
    cashierNameSnapshot: order.cashierNameSnapshot,
    subtotal: order.subtotal.toString(),
    discountAmount: order.discountAmount.toString(),
    payableAmount: order.payableAmount.toString(),
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    paymentMode: order.paymentMode,
    checkoutKey: order.checkoutKey,
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    completedAt: order.completedAt,
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
    })),
  }
}

function replayOrder(existing, user, storeId, cartHash) {
  if (existing.cashierId !== user.id || existing.storeId !== storeId || existing.cartHash !== cartHash) {
    throw httpError('结算标识已用于另一笔订单，请重新发起结算', 409)
  }
  return existing
}

posRouter.get('/pos/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const rows = await prisma.inventoryItem.findMany({
    where: { isActive: true, sku: { not: null }, salePriceCents: { not: null }, costPriceCents: { not: null } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  res.json({ rows: rows.map(serializeProduct) })
}))

posRouter.post('/pos/orders', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const storeId = String(req.body?.storeId ?? '').trim()
  const checkoutKey = String(req.body?.checkoutKey ?? '').trim()
  if (!canStore(req.user, storeId)) throw httpError('无权在该门店点单', 403)
  if (checkoutKey.length < 8 || checkoutKey.length > 100) throw httpError('结算标识不正确')
  const normalizedItems = normalizeCartItems(req.body?.items)
  const cartHash = hashCart(normalizedItems)
  const previous = await prisma.order.findUnique({ where: { checkoutKey }, include: orderInclude() })
  if (previous) return res.json({ ok: true, reused: true, order: serializeOrder(replayOrder(previous, req.user, storeId, cartHash)) })

  const store = await prisma.store.findUnique({ where: { key: storeId } })
  if (!store) throw httpError('门店不存在，请先同步门店资料', 404)
  const products = await prisma.inventoryItem.findMany({ where: { id: { in: normalizedItems.map((item) => item.productId) } } })
  const snapshot = buildOrderSnapshot(products, normalizedItems)
  const now = new Date()
  const id = `ord-${crypto.randomUUID()}`
  const orderNo = `POS${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`

  try {
    const order = await prisma.order.create({
      data: {
        id, orderNo, storeId, cashierId: req.user.id, cashierNameSnapshot: req.user.username,
        subtotal: snapshot.subtotal, discountAmount: snapshot.discountAmount, payableAmount: snapshot.payableAmount,
        checkoutKey, cartHash,
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

posRouter.post('/pos/orders/:id/complete', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requirePosUser(req.user)
  const paymentMethod = String(req.body?.paymentMethod ?? '')
  if (!['wechat', 'alipay', 'cash'].includes(paymentMethod)) throw httpError('支付方式不正确')
  const order = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: req.params.id }, include: orderInclude() })
    if (!current) throw httpError('订单不存在', 404)
    if (!canReadOrder(req.user, current)) throw httpError('无权限', 403)
    if (current.status === 'completed' && current.paymentStatus === 'paid') return current
    if (current.status !== 'pending' || current.paymentStatus !== 'unpaid') throw httpError('当前订单状态不可支付', 409)
    await tx.order.updateMany({
      where: { id: current.id, status: 'pending', paymentStatus: 'unpaid' },
      data: { status: 'completed', paymentStatus: 'paid', paymentMethod, paymentMode: 'mock', completedAt: new Date(), version: { increment: 1 } },
    })
    return tx.order.findUnique({ where: { id: current.id }, include: orderInclude() })
  })
  res.json({ ok: true, order: serializeOrder(order) })
}))
