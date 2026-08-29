import crypto from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, dbReady } from './pg.js'
import { httpError, normalizeSku, parseCents } from './pos-core.js'
import { sendStoredImage } from './product-images.js'
import { hasModuleAccess, isSuperUser, MODULE_KEYS } from '../shared/accountPermissions.js'

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
  if (!user || (!isSuperUser(user) && !(user.role === 'manager' && hasModuleAccess(user, MODULE_KEYS.PRODUCT_CENTER)))) throw httpError('无权限', 403)
}

function requireProductViewer(user) {
  if (!user) throw httpError('无权限', 403)
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

function optionalCents(value, label) {
  if (value === '' || value === null || value === undefined) return null
  return parseCents(value, label)
}

function productData(body, existingImage = '') {
  const sku = normalizeSku(body.sku)
  if (sku.length > 64) throw httpError('SKU 不能超过 64 个字符')
  const sortOrder = Number(body.sortOrder ?? 0)
  if (!Number.isInteger(sortOrder) || sortOrder < -999999 || sortOrder > 999999) {
    throw httpError('排序必须是 -999999 至 999999 的整数')
  }
  const isActive = body.isActive !== false
  const salePriceCents = optionalCents(body.salePriceCents, '售价')
  const costPriceCents = optionalCents(body.costPriceCents, '成本价')
  const unit = text(body.unit || '份', 20, '单位', isActive)
  const transferEnabled = body.transferEnabled === true
  const partnerSupplyEnabled = body.partnerSupplyEnabled === true
  const productGroupId = text(body.productGroupId, 120, '商品组') || null
  const variantName = productGroupId ? text(body.variantName, 30, '款式名称', true) : ''
  const transferCodeInput = text(body.transferCode, 40, '商品编号')
  const transferCode = transferCodeInput || (transferEnabled ? sku || null : null)
  if (isActive && (!sku || salePriceCents === null || costPriceCents === null)) throw httpError('启用 POS 前请填写 SKU、售价和成本价')
  if (transferEnabled && !transferCode) throw httpError('启用门店调拨前请填写 SKU 或商品编号')
  if (partnerSupplyEnabled && (salePriceCents === null || salePriceCents <= 0n)) throw httpError('启用合作商供货前请填写有效零售价')
  return {
    name: text(body.name, 50, '商品名称', true),
    sku: sku || null,
    posCategory: text(body.posCategory, 30, '旧 POS 分类'),
    salePriceCents,
    costPriceCents,
    unit,
    image: Object.prototype.hasOwnProperty.call(body, 'image') ? imageValue(body.image) : existingImage,
    barcode: text(body.barcode, 64, '条码'),
    isActive,
    trackInventory: body.trackInventory === true,
    sortOrder,
    transferCode,
    transferEnabled,
    transferSortOrder: sortOrder,
    partnerSupplyEnabled,
    productCategoryId: text(body.productCategoryId, 120, '商品分类') || null,
    productGroupId,
    variantName,
  }
}

async function requireProductCategory(productCategoryId, currentCategoryId = '') {
  if (!productCategoryId) return null
  const category = await prisma.productCategory.findUnique({ where: { id: productCategoryId } })
  if (!category) throw httpError('商品分类不存在', 404)
  if (!category.isActive && category.id !== currentCategoryId) throw httpError('已停用分类不能接收商品', 409)
  return category
}

async function requireProductGroup(productGroupId, currentGroupId = '') {
  if (!productGroupId) return null
  const group = await prisma.productGroup.findUnique({ where: { id: productGroupId } })
  if (!group) throw httpError('商品组不存在', 404)
  if (!group.isActive && group.id !== currentGroupId) throw httpError('已停用商品组不能接收商品', 409)
  return group
}

export const productListSelect = {
  id: true,
  name: true,
  sku: true,
  posCategory: true,
  transferCode: true,
  salePriceCents: true,
  costPriceCents: true,
  unit: true,
  barcode: true,
  isActive: true,
  transferEnabled: true,
  partnerSupplyEnabled: true,
  productCategoryId: true,
  productGroupId: true,
  variantName: true,
  trackInventory: true,
  sortOrder: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  productCategory: { select: { id: true, name: true, isActive: true, sortOrder: true } },
  productGroup: { select: { id: true, name: true, sortOrder: true, isActive: true, updatedAt: true } },
}

export function serializeProduct(product) {
  return {
    productId: product.id,
    name: product.name,
    sku: product.sku,
    posCategory: product.posCategory,
    transferCode: product.transferCode || '',
    salePriceCents: product.salePriceCents == null ? null : product.salePriceCents.toString(),
    costPriceCents: product.costPriceCents == null ? null : product.costPriceCents.toString(),
    unit: product.unit,
    image: '',
    hasImage: product.hasImage === true || Boolean(product.image),
    barcode: product.barcode || '',
    isActive: product.isActive,
    transferEnabled: product.transferEnabled,
    partnerSupplyEnabled: product.partnerSupplyEnabled,
    productCategoryId: product.productCategoryId || '',
    productCategory: product.productCategory ? {
      id: product.productCategory.id,
      name: product.productCategory.name,
      isActive: product.productCategory.isActive,
      sortOrder: product.productCategory.sortOrder,
    } : null,
    productGroupId: product.productGroupId || '',
    productGroup: product.productGroup ? {
      id: product.productGroup.id,
      name: product.productGroup.name,
      sortOrder: product.productGroup.sortOrder,
      isActive: product.productGroup.isActive,
      hasCoverImage: product.productGroup.hasCoverImage === true || Boolean(product.productGroup.coverImage),
      updatedAt: product.productGroup.updatedAt,
    } : null,
    variantName: product.variantName || '',
    trackInventory: product.trackInventory,
    sortOrder: product.sortOrder,
    version: product.version,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  }
}

productsRouter.get('/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductViewer(req.user)
  const q = text(req.query.q, 80, '搜索词')
  const productCategoryId = text(req.query.category, 120, '商品分类')
  const purpose = text(req.query.purpose, 20, '业务用途')
  const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined
  const [rows, imageRows, groupCoverRows] = await Promise.all([prisma.inventoryItem.findMany({
    where: {
      category: 'product',
      ...(productCategoryId ? { productCategoryId } : {}),
      ...(purpose === 'pos' ? { isActive: active ?? true } : {}),
      ...(purpose === 'transfer' ? { transferEnabled: active ?? true } : {}),
      ...(purpose === 'partner' ? { partnerSupplyEnabled: active ?? true } : {}),
      ...(q ? { OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: normalizeSku(q), mode: 'insensitive' } },
        { transferCode: { contains: q, mode: 'insensitive' } },
        { barcode: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    },
    select: productListSelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  }), prisma.inventoryItem.findMany({
    where: { category: 'product', image: { not: '' } },
    select: { id: true },
  }), prisma.productGroup.findMany({
    where: { coverImage: { not: '' } },
    select: { id: true },
  })])
  const imageIds = new Set(imageRows.map((row) => row.id))
  const groupCoverIds = new Set(groupCoverRows.map((row) => row.id))
  res.json({ rows: rows.map((product) => serializeProduct({
    ...product,
    hasImage: imageIds.has(product.id),
    productGroup: product.productGroup ? { ...product.productGroup, hasCoverImage: groupCoverIds.has(product.productGroup.id) } : null,
  })) })
}))

async function productImage(req) {
  const product = await prisma.inventoryItem.findUnique({
    where: { id: req.params.productId },
    select: { id: true, category: true, image: true, updatedAt: true },
  })
  if (!product || product.category !== 'product' || !product.image) throw httpError('商品图片不存在', 404)
  return product
}

productsRouter.get('/products/:productId/image', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductViewer(req.user)
  const product = await productImage(req)
  await sendStoredImage(req, res, { dataUrl: product.image, updatedAt: product.updatedAt, identity: `product:${product.id}` })
}))

productsRouter.get('/products/:productId/thumbnail', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductViewer(req.user)
  const product = await productImage(req)
  await sendStoredImage(req, res, { dataUrl: product.image, updatedAt: product.updatedAt, identity: `product:${product.id}`, thumbnail: true })
}))

productsRouter.post('/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const data = productData(req.body || {})
  await requireProductCategory(data.productCategoryId)
  await requireProductGroup(data.productGroupId)
  const row = await prisma.inventoryItem.create({
    data: { id: `it-${crypto.randomUUID()}`, category: 'product', ...data },
    include: { productCategory: true, productGroup: true },
  })
  res.status(201).json({ ok: true, product: serializeProduct(row) })
}))

productsRouter.post('/products/import', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const inputRows = req.body?.rows
  if (!Array.isArray(inputRows) || inputRows.length < 1 || inputRows.length > 1000) {
    throw httpError('每次请选择 1-1000 条有效商品导入')
  }

  const seenSku = new Set()
  const seenName = new Set()
  const normalized = inputRows.map((body, index) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(`第 ${index + 1} 行格式不正确`)
    const data = productData({
      ...body,
      unit: body.unit || '份',
      image: '',
      barcode: body.barcode || '',
      isActive: true,
      transferEnabled: false,
      partnerSupplyEnabled: false,
      trackInventory: body.trackInventory === true,
      sortOrder: body.sortOrder === '' || body.sortOrder == null ? index : body.sortOrder,
    })
    if (seenSku.has(data.sku)) throw httpError(`Excel 内 SKU 重复：${data.sku}`)
    if (seenName.has(data.name)) throw httpError(`Excel 内菜品名重复：${data.name}`)
    seenSku.add(data.sku)
    seenName.add(data.name)
    return {
      data,
      provided: {
        unit: Boolean(String(body.unit || '').trim()),
        barcode: Boolean(String(body.barcode || '').trim()),
        sortOrder: !(body.sortOrder === '' || body.sortOrder == null),
        trackInventory: Object.prototype.hasOwnProperty.call(body, 'trackInventory'),
      },
    }
  })

  const result = await prisma.$transaction(async (tx) => {
    const existingRows = await tx.inventoryItem.findMany({
      where: { OR: [
        { sku: { in: normalized.map((row) => row.data.sku) } },
        { name: { in: normalized.map((row) => row.data.name) } },
      ] },
    })
    const bySku = new Map(existingRows.map((row) => [row.sku, row]).filter(([sku]) => sku))
    const byName = new Map(existingRows.map((row) => [row.name, row]))
    const saved = []
    let created = 0
    let updated = 0

    for (const row of normalized) {
      const skuMatch = bySku.get(row.data.sku)
      const nameMatch = byName.get(row.data.name)
      if (skuMatch && nameMatch && skuMatch.id !== nameMatch.id) {
        throw httpError(`「${row.data.name}」的 SKU 与菜品名匹配到不同商品，请先检查 Excel`, 409)
      }
      if (!skuMatch && nameMatch) throw httpError(`「${row.data.name}」名称已存在；禁止按名称自动关联，请在商品中心编辑现有商品`, 409)
      const existing = skuMatch || null
      if (!existing) {
        const createdRow = await tx.inventoryItem.create({ data: { id: `it-${crypto.randomUUID()}`, category: 'product', ...row.data }, include: { productCategory: true, productGroup: true } })
        bySku.set(createdRow.sku, createdRow)
        byName.set(createdRow.name, createdRow)
        saved.push(createdRow)
        created += 1
        continue
      }

      const data = {
        ...row.data,
        image: existing.image || '',
        unit: row.provided.unit ? row.data.unit : existing.unit || '份',
        barcode: row.provided.barcode ? row.data.barcode : existing.barcode || '',
        sortOrder: row.provided.sortOrder ? row.data.sortOrder : existing.sortOrder,
        trackInventory: row.provided.trackInventory ? row.data.trackInventory : existing.trackInventory,
        isActive: true,
        transferCode: existing.transferCode,
        transferEnabled: existing.transferEnabled,
        transferSortOrder: existing.transferSortOrder,
        partnerSupplyEnabled: existing.partnerSupplyEnabled,
        productCategoryId: existing.productCategoryId,
        productGroupId: existing.productGroupId,
        variantName: existing.variantName,
      }
      const updatedRow = await tx.inventoryItem.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } }, include: { productCategory: true, productGroup: true } })
      if (existing.sku) bySku.delete(existing.sku)
      byName.delete(existing.name)
      bySku.set(updatedRow.sku, updatedRow)
      byName.set(updatedRow.name, updatedRow)
      saved.push(updatedRow)
      updated += 1
    }
    return { saved, created, updated }
  }, { maxWait: 5000, timeout: 30000 })

  res.json({
    ok: true,
    created: result.created,
    updated: result.updated,
    rows: result.saved.map(serializeProduct),
  })
}))

productsRouter.put('/products/bulk', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (!ids.length || ids.length > 500) throw httpError('请选择 1-500 个商品')
  const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids }, category: 'product' } })
  if (rows.length !== ids.length) throw httpError('所选商品包含不存在的商品资料', 409)

  const operation = String(req.body?.operation || '')
  if (operation === 'category') {
    const productCategoryId = String(req.body?.productCategoryId || '').trim() || null
    await requireProductCategory(productCategoryId)
    await prisma.inventoryItem.updateMany({
      where: { id: { in: ids }, category: 'product' },
      data: { productCategoryId, version: { increment: 1 } },
    })
  } else if (operation === 'purpose') {
    const purpose = String(req.body?.purpose || '')
    const enabled = req.body?.enabled === true
    if (!['pos', 'transfer', 'partner'].includes(purpose)) throw httpError('业务用途不正确')
    if (enabled && purpose === 'pos' && rows.some((row) => !row.sku || row.salePriceCents === null || row.costPriceCents === null)) {
      throw httpError('所选商品中存在缺少 SKU、售价或成本价的商品，不能批量启用 POS', 409)
    }
    if (enabled && purpose === 'transfer' && rows.some((row) => !row.transferCode && !row.sku)) {
      throw httpError('所选商品中存在缺少 SKU 和商品编号的商品，不能批量启用调拨', 409)
    }
    if (enabled && purpose === 'partner' && rows.some((row) => row.salePriceCents === null || row.salePriceCents <= 0n)) {
      throw httpError('所选商品中存在未设置有效零售价的商品，不能批量启用合作商供货', 409)
    }
    const field = purpose === 'pos' ? 'isActive' : purpose === 'transfer' ? 'transferEnabled' : 'partnerSupplyEnabled'
    await prisma.$transaction(rows.map((row) => prisma.inventoryItem.update({
      where: { id: row.id },
      data: {
        [field]: enabled,
        ...(purpose === 'transfer' && enabled && !row.transferCode ? { transferCode: row.sku } : {}),
        version: { increment: 1 },
      },
    })))
  } else {
    throw httpError('批量操作不正确')
  }

  const saved = await prisma.inventoryItem.findMany({
    where: { id: { in: ids }, category: 'product' },
    include: { productCategory: true, productGroup: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  res.json({ ok: true, updated: saved.length, rows: saved.map(serializeProduct) })
}))

productsRouter.put('/products/:productId', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw httpError('商品版本不正确，请刷新后重试')
  const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId } })
  if (!existing || existing.category !== 'product') throw httpError('商品不存在', 404)
  const data = productData(req.body || {}, existing.image || '')
  await requireProductCategory(data.productCategoryId, existing.productCategoryId || '')
  await requireProductGroup(data.productGroupId, existing.productGroupId || '')
  const result = await prisma.inventoryItem.updateMany({
    where: { id: req.params.productId, category: 'product', version },
    data: { ...data, version: { increment: 1 } },
  })
  if (result.count !== 1) {
    const latest = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId } })
    if (!latest || latest.category !== 'product') throw httpError('商品不存在', 404)
    const latestWithRelations = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId }, include: { productCategory: true, productGroup: true } })
    return res.status(409).json({ error: '商品已被其他人修改，已返回最新数据', latest: serializeProduct(latestWithRelations) })
  }
  const row = await prisma.inventoryItem.findUnique({ where: { id: req.params.productId }, include: { productCategory: true, productGroup: true } })
  res.json({ ok: true, product: serializeProduct(row) })
}))

function productGroupData(body, existingCoverImage = '') {
  const sortOrder = Number(body?.sortOrder ?? 0)
  if (!Number.isInteger(sortOrder) || sortOrder < -999999 || sortOrder > 999999) throw httpError('商品组排序必须是 -999999 至 999999 的整数')
  return {
    name: text(body?.name, 50, '商品组名称', true),
    coverImage: Object.prototype.hasOwnProperty.call(body || {}, 'coverImage') ? imageValue(body?.coverImage) : existingCoverImage,
    sortOrder,
    isActive: body?.isActive !== false,
  }
}

function productGroupMembers(body) {
  const input = Array.isArray(body?.members) ? body.members : []
  if (input.length > 100) throw httpError('每个商品组最多包含 100 个款式')
  const seen = new Set()
  return input.map((member) => {
    const productId = text(member?.productId, 120, '商品')
    if (!productId || seen.has(productId)) throw httpError('商品组成员重复或不正确')
    seen.add(productId)
    return { productId, variantName: text(member?.variantName, 30, '款式名称', true) }
  })
}

function serializeProductGroup(group) {
  return {
    id: group.id,
    name: group.name,
    coverImage: '',
    hasCoverImage: group.hasCoverImage === true || Boolean(group.coverImage),
    sortOrder: group.sortOrder,
    isActive: group.isActive,
    version: group.version,
    memberCount: group.products?.length || 0,
    members: (group.products || []).map((product) => ({ ...serializeProduct(product), image: '' })),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  }
}

async function updateProductGroupMembers(tx, groupId, members) {
  const ids = members.map((member) => member.productId)
  const products = ids.length ? await tx.inventoryItem.findMany({ where: { id: { in: ids }, category: 'product' } }) : []
  if (products.length !== ids.length) throw httpError('商品组中包含不存在或非产品资料', 409)
  const occupied = products.find((product) => product.productGroupId && product.productGroupId !== groupId)
  if (occupied) throw httpError(`商品「${occupied.name}」已属于其他商品组`, 409)
  await tx.inventoryItem.updateMany({
    where: { productGroupId: groupId, ...(ids.length ? { id: { notIn: ids } } : {}) },
    data: { productGroupId: null, variantName: '', version: { increment: 1 } },
  })
  for (const member of members) {
    const updated = await tx.inventoryItem.updateMany({
      where: { id: member.productId, category: 'product', OR: [{ productGroupId: null }, { productGroupId: groupId }] },
      data: { productGroupId: groupId, variantName: member.variantName, version: { increment: 1 } },
    })
    if (updated.count !== 1) throw httpError('商品已被加入其他商品组，请刷新后重试', 409)
  }
}

const productGroupInclude = {
  products: {
    include: { productCategory: true, productGroup: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  },
}

const productGroupListSelect = {
  id: true,
  name: true,
  sortOrder: true,
  isActive: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  products: {
    select: productListSelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  },
}

productsRouter.get('/product-groups', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductViewer(req.user)
  const [rows, imageRows, groupCoverRows] = await Promise.all([prisma.productGroup.findMany({
    select: productGroupListSelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 500,
  }), prisma.inventoryItem.findMany({
    where: { category: 'product', image: { not: '' } },
    select: { id: true },
  }), prisma.productGroup.findMany({
    where: { coverImage: { not: '' } },
    select: { id: true },
  })])
  const imageIds = new Set(imageRows.map((row) => row.id))
  const groupCoverIds = new Set(groupCoverRows.map((row) => row.id))
  res.json({ rows: rows.map((group) => serializeProductGroup({
    ...group,
    hasCoverImage: groupCoverIds.has(group.id),
    products: group.products.map((product) => ({
      ...product,
      hasImage: imageIds.has(product.id),
      productGroup: product.productGroup ? { ...product.productGroup, hasCoverImage: groupCoverIds.has(product.productGroup.id) } : null,
    })),
  })) })
}))

async function productGroupImage(req) {
  const group = await prisma.productGroup.findUnique({
    where: { id: req.params.id },
    select: { id: true, coverImage: true, updatedAt: true },
  })
  if (!group?.coverImage) throw httpError('商品组主图不存在', 404)
  return group
}

productsRouter.get('/product-groups/:id/image', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductViewer(req.user)
  const group = await productGroupImage(req)
  await sendStoredImage(req, res, { dataUrl: group.coverImage, updatedAt: group.updatedAt, identity: `product-group:${group.id}` })
}))

productsRouter.get('/product-groups/:id/thumbnail', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductViewer(req.user)
  const group = await productGroupImage(req)
  await sendStoredImage(req, res, { dataUrl: group.coverImage, updatedAt: group.updatedAt, identity: `product-group:${group.id}`, thumbnail: true })
}))

productsRouter.post('/product-groups', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const data = productGroupData(req.body || {})
  const members = productGroupMembers(req.body || {})
  const duplicate = await prisma.productGroup.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })
  if (duplicate) throw httpError('商品组名称已存在', 409)
  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.productGroup.create({ data: { id: `pg-${crypto.randomUUID()}`, ...data } })
    await updateProductGroupMembers(tx, created.id, members)
    return tx.productGroup.findUnique({ where: { id: created.id }, include: productGroupInclude })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  res.status(201).json({ ok: true, group: serializeProductGroup(group) })
}))

productsRouter.put('/product-groups/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProductManager(req.user)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw httpError('商品组版本不正确，请刷新后重试')
  const existing = await prisma.productGroup.findUnique({ where: { id: req.params.id }, select: { coverImage: true } })
  if (!existing) throw httpError('商品组不存在', 404)
  const data = productGroupData(req.body || {}, existing.coverImage || '')
  const members = productGroupMembers(req.body || {})
  const duplicate = await prisma.productGroup.findFirst({ where: { id: { not: req.params.id }, name: { equals: data.name, mode: 'insensitive' } } })
  if (duplicate) throw httpError('商品组名称已存在', 409)
  const group = await prisma.$transaction(async (tx) => {
    const updated = await tx.productGroup.updateMany({ where: { id: req.params.id, version }, data: { ...data, version: { increment: 1 } } })
    if (updated.count !== 1) throw httpError('商品组已被其他人修改，请刷新后重试', 409)
    await updateProductGroupMembers(tx, req.params.id, members)
    return tx.productGroup.findUnique({ where: { id: req.params.id }, include: productGroupInclude })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  res.json({ ok: true, group: serializeProductGroup(group) })
}))
