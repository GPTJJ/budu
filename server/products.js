import crypto from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, dbReady } from './pg.js'
import { httpError, normalizeSku, parseCents } from './pos-core.js'

export const productsRouter = Router()

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU 或商品名称已存在' })
    }
    const status = error.status || 500
    if (status >= 500) console.error('[products]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function requireProductManager(user) {
  if (!user || !['developer', 'manager'].includes(user.role)) throw httpError('无权限', 403)
}

function text(value, max, label, required = false) {
  const result = String(value ?? '').trim()
  if (required && !result) throw httpError(`请填写${label}`)
  if (result.length > max) throw httpError(`${label}不能超过 ${max} 个字符`)
  return result
}

function imageValue(value) {
  const image = String(value ?? '')
  if (image.length > 600000) throw httpError('商品图片过大，请压缩后重试')
  if (image && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image)) throw httpError('商品图片格式不正确')
  return image
}

function productData(body) {
  const sku = normalizeSku(body.sku)
  if (!sku) throw httpError('请填写 SKU')
  if (sku.length > 64) throw httpError('SKU 不能超过 64 个字符')
  const sortOrder = Number(body.sortOrder ?? 0)
  if (!Number.isInteger(sortOrder) || sortOrder < -999999 || sortOrder > 999999) {
    throw httpError('排序必须是 -999999 至 999999 的整数')
  }
  return {
    name: text(body.name, 50, '商品名称', true),
    sku,
    posCategory: text(body.posCategory, 30, '商品分类', true),
    salePriceCents: parseCents(body.salePriceCents, '售价'),
    costPriceCents: parseCents(body.costPriceCents, '成本价'),
    unit: text(body.unit, 20, '单位', true),
    image: imageValue(body.image),
    barcode: text(body.barcode, 64, '条码'),
    isActive: body.isActive !== false,
    trackInventory: body.trackInventory === true,
    sortOrder,
  }
}

export function serializeProduct(product) {
  return {
    productId: product.id,
    name: product.name,
    sku: product.sku,
    posCategory: product.posCategory,
    salePriceCents: product.salePriceCents == null ? null : product.salePriceCents.toString(),
    costPriceCents: product.costPriceCents == null ? null : product.costPriceCents.toString(),
    unit: product.unit,
    image: product.image || '',
    barcode: product.barcode || '',
    isActive: product.isActive,
    trackInventory: product.trackInventory,
    sortOrder: product.sortOrder,
    version: product.version,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  }
}

productsRouter.get('/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const q = text(req.query.q, 80, '搜索词')
  const posCategory = text(req.query.category, 30, '商品分类')
  const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined
  const rows = await prisma.inventoryItem.findMany({
    where: {
      sku: { not: null },
      ...(posCategory ? { posCategory } : {}),
      ...(active === undefined ? {} : { isActive: active }),
      ...(q ? { OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: normalizeSku(q), mode: 'insensitive' } },
        { barcode: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  res.json({ rows: rows.map(serializeProduct) })
}))

productsRouter.post('/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const data = productData(req.body || {})
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryItem.findUnique({ where: { name: data.name } })
    if (!existing) return tx.inventoryItem.create({ data: { id: `it-${crypto.randomUUID()}`, category: 'product', ...data } })
    if (existing.sku) throw httpError('商品名称已存在', 409)
    const upgraded = await tx.inventoryItem.updateMany({ where: { id: existing.id, sku: null }, data: { ...data, version: { increment: 1 } } })
    if (upgraded.count !== 1) throw httpError('商品已被其他人更新，请刷新后重试', 409)
    return tx.inventoryItem.findUnique({ where: { id: existing.id } })
  })
  res.status(201).json({ ok: true, product: serializeProduct(row) })
}))

productsRouter.put('/products/:productId', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw httpError('商品版本不正确，请刷新后重试')
  const data = productData(req.body || {})
  const result = await prisma.inventoryItem.updateMany({
    where: { id: req.params.productId, sku: { not: null }, version },
    data: { ...data, version: { increment: 1 } },
  })
  if (result.count !== 1) {
    const latest = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId } })
    if (!latest || !latest.sku) throw httpError('商品不存在', 404)
    return res.status(409).json({ error: '商品已被其他人修改，已返回最新数据', latest: serializeProduct(latest) })
  }
  const row = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId } })
  res.json({ ok: true, product: serializeProduct(row) })
}))
