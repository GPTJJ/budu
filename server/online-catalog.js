/**
 * ONLINE-CATALOG-ADMIN-001
 *
 * OS-side management authority for the MiniProgram catalog.
 *
 * Postgres owns the editable profile; the CloudBase `products` collection is a
 * published read model consumed by the existing `catalog` cloud function. This
 * module never changes the MiniProgram read path and never writes CloudBase
 * directly during a page save — publishing is an explicit, auditable action.
 */
import crypto from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, dbReady } from './pg.js'
import { httpError, parseCents } from './pos-core.js'
import { hasModuleAccess, isSuperUser, MODULE_KEYS } from '../shared/accountPermissions.js'
import { getOnlineCatalogPublisher, buildProductDoc } from './online-catalog-publisher.js'
import { withDisplayMedia, withDisplayMediaOne } from './online-catalog-media.js'

export const ONLINE_CATALOG_NAMESPACE = 'cloudbase-miniprogram'
export const ONLINE_CATALOG_STATUSES = ['DRAFT', 'ON', 'OFF']

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: '商品名称、SKU 或小程序商品 ID 已存在' })
    }
    const status = error.status || 500
    if (status >= 500) console.error('[online-catalog]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function requireCatalogManager(user) {
  if (!user || (!isSuperUser(user) && !(user.role === 'manager' && hasModuleAccess(user, MODULE_KEYS.PRODUCT_CENTER)))) {
    throw httpError('无权限', 403)
  }
}

export function text(value, max, label, required = false) {
  const result = String(value ?? '').trim()
  if (required && !result) throw httpError(`请填写${label}`)
  if (result.length > max) throw httpError(`${label}不能超过 ${max} 个字符`)
  return result
}

export function integer(value, label, { min = -999999, max = 999999, fallback = 0 } = {}) {
  if (value === '' || value === null || value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw httpError(`${label}必须是 ${min} 至 ${max} 的整数`)
  return number
}

export function yuanToCentsValue(value, label = '金额') {
  const input = String(value ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(input)) throw httpError(`${label}格式不正确`)
  const [yuan, decimal = ''] = input.split('.')
  const cents = BigInt(yuan) * 100n + BigInt(decimal.padEnd(2, '0') || '0')
  if (cents > 99999999999n) throw httpError(`${label}超出允许范围`)
  return cents
}

export function priceCentsFrom(body, label = '线上售价') {
  if (body.priceCents !== undefined && body.priceCents !== null && body.priceCents !== '') {
    return parseCents(body.priceCents, label)
  }
  if (body.price !== undefined && body.price !== null && body.price !== '') {
    return yuanToCentsValue(body.price, label)
  }
  return null
}

export function hasPriceInput(body) {
  const source = body && typeof body === 'object' ? body : {}
  return (source.priceCents !== undefined && source.priceCents !== null && source.priceCents !== '') ||
    (source.price !== undefined && source.price !== null && source.price !== '')
}

export function normalizeMedia(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const strings = (list, maxItems, label) => {
    if (list === undefined || list === null) return []
    if (!Array.isArray(list)) throw httpError(`${label}必须是数组`)
    if (list.length > maxItems) throw httpError(`${label}最多 ${maxItems} 张`)
    return list.map((item) => {
      const src = String(item ?? '').trim()
      if (src.length > 600000) throw httpError(`${label}图片过大`)
      if (src && !/^(data:image\/(png|jpe?g|webp|gif);base64,|cloud:\/\/|https:\/\/|\/images\/)/i.test(src)) {
        throw httpError(`${label}图片格式不正确`)
      }
      return src
    }).filter(Boolean)
  }
  const cover = String(source.cover ?? '').trim()
  if (cover.length > 600000) throw httpError('封面图过大')
  if (cover && !/^(data:image\/(png|jpe?g|webp|gif);base64,|cloud:\/\/|https:\/\/|\/images\/)/i.test(cover)) {
    throw httpError('封面图格式不正确')
  }
  return {
    cover,
    gallery: strings(source.gallery, 9, '轮播图'),
    detail: strings(source.detail, 20, '详情图'),
  }
}

export function normalizeMpId(value, required = false) {
  const id = String(value ?? '').trim()
  if (!id) {
    if (required) throw httpError('请填写小程序商品 ID')
    return ''
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw httpError('小程序商品 ID 只能使用小写字母、数字、下划线和短横线')
  return id
}

/** Deterministic SKU identity used by orders/online-catalog.js for non-combo products. */
export function onlineSkuId(mpId, comboFlavors = null) {
  return 'sku-' + crypto.createHash('sha256')
    .update(JSON.stringify([mpId, comboFlavors === null ? null : comboFlavors.slice().sort()]))
    .digest('hex')
}

const MP_ID_PREFIX = {
  '生巧克力': 'c',
  '糖果': 's',
  '糖果-礼盒': 'g',
  '巧克力豆': 'b',
}

export async function suggestMpId(tx, categoryName) {
  const prefix = MP_ID_PREFIX[categoryName] || 'p'
  const rows = await tx.onlineProductProfile.findMany({
    where: { mpId: { startsWith: prefix } },
    select: { mpId: true },
  })
  let max = 0
  for (const row of rows) {
    const match = row.mpId.match(new RegExp(`^${prefix}(\\d+)$`))
    if (match) max = Math.max(max, Number(match[1]))
  }
  let next = max + 1
  while (rows.some((row) => row.mpId === `${prefix}${next}`)) next += 1
  return `${prefix}${next}`
}

export function productProfileData(body, { existing = null, item = null } = {}) {
  const status = String(body.status ?? existing?.status ?? 'DRAFT').toUpperCase()
  if (!ONLINE_CATALOG_STATUSES.includes(status)) throw httpError('状态只能是 DRAFT、ON 或 OFF')
  // 空字符串视同“未填写”：新建时默认跟随 POS 售价，编辑时保留原线上价。
  // 前端表单始终会带上 price: ''，若按“已提供”处理会把新商品的上架价变成 null。
  const priceCents = hasPriceInput(body)
    ? priceCentsFrom(body, '线上售价')
    : priceCentsFrom({ priceCents: existing?.priceCents ?? item?.salePriceCents ?? null }, '线上售价')
  if (status === 'ON' && (priceCents === null || priceCents <= 0n)) throw httpError('上架前请填写大于 0 的线上售价')
  return {
    title: text(body.title !== undefined ? body.title : existing?.title || item?.name || '', 50, '线上标题', status === 'ON'),
    subtitle: text(body.subtitle !== undefined ? body.subtitle : existing?.subtitle || '', 80, '副标题'),
    spec: text(body.spec !== undefined ? body.spec : existing?.spec || item?.spec || '', 60, '规格'),
    unit: text(body.unit !== undefined ? body.unit : existing?.unit || item?.unit || '份', 20, '单位'),
    priceCents,
    shelfLife: text(body.shelfLife !== undefined ? body.shelfLife : existing?.shelfLife || '', 40, '保质期'),
    storage: text(body.storage !== undefined ? body.storage : existing?.storage || '', 40, '保存方式'),
    media: normalizeMedia(body.media !== undefined ? body.media : existing?.media || {}),
    sortOrder: integer(body.sortOrder !== undefined ? body.sortOrder : existing?.sortOrder ?? 0, '排序'),
    status,
  }
}

export function serializeProfile(profile) {
  if (!profile) return null
  return {
    id: profile.id,
    inventoryItemId: profile.inventoryItemId,
    mpId: profile.mpId,
    onlineCategoryId: profile.onlineCategoryId,
    title: profile.title,
    subtitle: profile.subtitle,
    spec: profile.spec,
    unit: profile.unit,
    priceCents: profile.priceCents === null || profile.priceCents === undefined ? null : String(profile.priceCents),
    shelfLife: profile.shelfLife,
    storage: profile.storage,
    media: profile.media || {},
    sortOrder: profile.sortOrder,
    status: profile.status,
    publishState: profile.publishState,
    publishedVersion: profile.publishedVersion,
    publishedAt: profile.publishedAt,
    lastError: profile.lastError,
    version: profile.version,
    updatedAt: profile.updatedAt,
    category: profile.category ? {
      id: profile.category.id,
      name: profile.category.name,
      sortOrder: profile.category.sortOrder,
      isActive: profile.category.isActive,
      meta: profile.category.meta || {},
    } : null,
    item: profile.inventoryItem ? {
      id: profile.inventoryItem.id,
      name: profile.inventoryItem.name,
      sku: profile.inventoryItem.sku,
      salePriceCents: profile.inventoryItem.salePriceCents === null ? null : String(profile.inventoryItem.salePriceCents),
      costPriceCents: profile.inventoryItem.costPriceCents === null ? null : String(profile.inventoryItem.costPriceCents),
      unit: profile.inventoryItem.unit,
      spec: profile.inventoryItem.spec,
      isActive: profile.inventoryItem.isActive,
    } : null,
  }
}

function previewMedia(media) {
  const summarize = (value) => (typeof value === 'string' && /^data:image\//i.test(value)
    ? `[embedded image ${Math.round(value.length / 1024)}KB]`
    : value)
  const source = media && typeof media === 'object' ? media : {}
  return {
    cover: summarize(source.cover || ''),
    gallery: Array.isArray(source.gallery) ? source.gallery.map(summarize) : [],
    detail: Array.isArray(source.detail) ? source.detail.map(summarize) : [],
  }
}

const profileInclude = { category: true, inventoryItem: true }

async function loadProfile(id) {
  const profile = await prisma.onlineProductProfile.findUnique({ where: { id }, include: profileInclude })
  if (!profile) throw httpError('线上商品不存在', 404)
  return profile
}

async function publishOne(profile) {
  const publisher = await getOnlineCatalogPublisher()
  const category = profile.category
  if (!category) throw httpError('请先选择线上分类', 409)
  if (!category.isActive) throw httpError('分类已停用，不能发布', 409)
  if (!profile.inventoryItem || profile.inventoryItem.isActive !== true) throw httpError('对应 OS 商品未启用，不能发布', 409)

  const categories = await prisma.onlineCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  await publisher.publishCategories(categories)
  const result = await publisher.publishProduct({ profile, category, item: profile.inventoryItem })
  await prisma.onlineProductProfile.update({
    where: { id: profile.id },
    data: {
      publishState: 'PUBLISHED',
      publishedVersion: profile.version,
      publishedAt: new Date(),
      lastError: '',
    },
  })
  return result
}

export const onlineCatalogRouter = Router()

onlineCatalogRouter.get('/online-catalog/status', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const [categories, products] = await Promise.all([
    prisma.onlineCategory.count(),
    prisma.onlineProductProfile.count(),
  ])
  res.json({
    ok: true,
    cloudbase: {
      configured: Boolean(process.env.TCB_ENV_ID && process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY),
      envId: String(process.env.TCB_ENV_ID || ''),
    },
    counts: { categories, products },
  })
}))

onlineCatalogRouter.get('/online-catalog/categories', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const categories = await prisma.onlineCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  res.json({ ok: true, categories })
}))

onlineCatalogRouter.post('/online-catalog/categories', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const body = req.body || {}
  const name = text(body.name, 20, '分类名称', true)
  const sortOrder = integer(body.sortOrder, '排序', { fallback: 0 })
  const category = await prisma.onlineCategory.create({
    data: { id: `oc-${crypto.randomUUID()}`, name, sortOrder, meta: body.meta && typeof body.meta === 'object' ? body.meta : {} },
  })
  res.status(201).json({ ok: true, category })
}))

onlineCatalogRouter.put('/online-catalog/categories/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const body = req.body || {}
  const existing = await prisma.onlineCategory.findUnique({ where: { id: req.params.id } })
  if (!existing) throw httpError('分类不存在', 404)
  const category = await prisma.onlineCategory.update({
    where: { id: existing.id },
    data: {
      name: body.name !== undefined ? text(body.name, 20, '分类名称', true) : existing.name,
      sortOrder: body.sortOrder !== undefined ? integer(body.sortOrder, '排序') : existing.sortOrder,
      isActive: body.isActive !== undefined ? body.isActive === true : existing.isActive,
      meta: body.meta !== undefined && body.meta && typeof body.meta === 'object' ? body.meta : existing.meta,
      version: { increment: 1 },
    },
  })
  res.json({ ok: true, category })
}))

onlineCatalogRouter.get('/online-catalog/items', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const query = text(req.query.q, 50, '搜索词')
  const items = await prisma.inventoryItem.findMany({
    where: {
      category: 'product',
      isActive: true,
      onlineProfile: { is: null },
      ...(query ? { OR: [{ name: { contains: query } }, { sku: { contains: query } }] } : {}),
    },
    orderBy: { name: 'asc' },
    take: 50,
    select: { id: true, name: true, sku: true, salePriceCents: true, costPriceCents: true, unit: true, spec: true, image: true },
  })
  res.json({ ok: true, items: items.map((item) => ({ ...item, salePriceCents: item.salePriceCents === null ? null : String(item.salePriceCents), costPriceCents: item.costPriceCents === null ? null : String(item.costPriceCents) })) })
}))

onlineCatalogRouter.get('/online-catalog/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const query = text(req.query.q, 50, '搜索词')
  const products = await prisma.onlineProductProfile.findMany({
    where: query ? { OR: [{ title: { contains: query } }, { mpId: { contains: query } }, { inventoryItem: { is: { name: { contains: query } } } }] } : undefined,
    include: profileInclude,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  products.sort((a, b) => ((a.category?.sortOrder ?? 999999) - (b.category?.sortOrder ?? 999999)) || (a.sortOrder - b.sortOrder))
  res.json({ ok: true, products: await withDisplayMedia(products.map(serializeProfile)) })
}))

onlineCatalogRouter.post('/online-catalog/products', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const body = req.body || {}
  const mode = body.mode === 'existing' ? 'existing' : 'new'
  const categoryId = text(body.onlineCategoryId, 120, '线上分类', true)
  const category = await prisma.onlineCategory.findUnique({ where: { id: categoryId } })
  if (!category || !category.isActive) throw httpError('线上分类不存在或已停用', 409)

  const created = await prisma.$transaction(async (tx) => {
    let item
    if (mode === 'existing') {
      item = await tx.inventoryItem.findUnique({ where: { id: String(body.inventoryItemId || '') } })
      if (!item) throw httpError('OS 商品不存在', 404)
      if (item.isActive !== true) throw httpError('OS 商品未启用', 409)
      const used = await tx.onlineProductProfile.findUnique({ where: { inventoryItemId: item.id } })
      if (used) throw httpError('该 OS 商品已有线上档案', 409)
    } else {
      const name = text(body.name, 50, '商品名称', true)
      const sku = text(body.sku, 64, 'SKU', true)
      const salePriceCents = yuanToCentsValue(body.salePrice, '售价')
      const costPriceCents = yuanToCentsValue(body.costPrice, '成本价')
      if (salePriceCents <= 0n) throw httpError('售价必须大于 0')
      item = await tx.inventoryItem.create({
        data: {
          id: `it-${crypto.randomUUID()}`,
          name,
          sku,
          unit: text(body.unit || '份', 20, '单位') || '份',
          spec: text(body.spec, 60, '规格'),
          category: 'product',
          salePriceCents,
          costPriceCents,
          isActive: true,
          trackInventory: body.trackInventory === true,
        },
      })
    }
    const mpId = body.mpId ? normalizeMpId(body.mpId, true) : await suggestMpId(tx, category.name)
    const resolvedPriceCents = hasPriceInput(body)
      ? priceCentsFrom(body, '线上售价')
      : item.salePriceCents
    const data = productProfileData({
      title: body.title !== undefined ? body.title : item.name,
      subtitle: body.subtitle,
      spec: body.spec !== undefined ? body.spec : item.spec,
      unit: body.unit !== undefined ? body.unit : item.unit,
      priceCents: resolvedPriceCents,
      shelfLife: body.shelfLife,
      storage: body.storage,
      media: body.media,
      sortOrder: body.sortOrder,
      status: body.status,
    }, { item })
    const profile = await tx.onlineProductProfile.create({
      data: {
        id: `op-${crypto.randomUUID()}`,
        inventoryItemId: item.id,
        mpId,
        onlineCategoryId: category.id,
        ...data,
      },
      include: profileInclude,
    })
    const externalSkuId = onlineSkuId(mpId)
    await tx.onlineProductPolicy.upsert({
      where: { namespace_externalProductId_externalSkuId: { namespace: ONLINE_CATALOG_NAMESPACE, externalProductId: mpId, externalSkuId } },
      update: { productId: item.id, enabled: profile.status === 'ON', updatedById: req.user.id },
      create: {
        id: `opp-${crypto.randomUUID()}`,
        namespace: ONLINE_CATALOG_NAMESPACE,
        externalProductId: mpId,
        externalSkuId,
        productId: item.id,
        enabled: profile.status === 'ON',
        updatedById: req.user.id,
      },
    })
    return profile
  })
  res.status(201).json({ ok: true, product: await withDisplayMediaOne(serializeProfile(created)) })
}))

onlineCatalogRouter.put('/online-catalog/products/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const body = req.body || {}
  const existing = await loadProfile(req.params.id)
  if (body.mpId !== undefined && normalizeMpId(body.mpId, true) !== existing.mpId) throw httpError('小程序商品 ID 创建后不能修改', 409)
  let category = existing.category
  if (body.onlineCategoryId !== undefined && body.onlineCategoryId !== existing.onlineCategoryId) {
    category = await prisma.onlineCategory.findUnique({ where: { id: String(body.onlineCategoryId || '') } })
    if (!category || !category.isActive) throw httpError('线上分类不存在或已停用', 409)
  }
  const data = productProfileData(body, { existing, item: existing.inventoryItem })
  if (data.status === 'ON' && existing.inventoryItem.isActive !== true) throw httpError('对应 OS 商品未启用，不能上架', 409)
  const updated = await prisma.$transaction(async (tx) => {
    const profile = await tx.onlineProductProfile.update({
      where: { id: existing.id },
      data: {
        ...data,
        onlineCategoryId: category ? category.id : null,
        version: { increment: 1 },
      },
      include: profileInclude,
    })
    await tx.onlineProductPolicy.updateMany({
      where: { namespace: ONLINE_CATALOG_NAMESPACE, externalProductId: existing.mpId },
      data: { enabled: profile.status === 'ON', productId: existing.inventoryItemId, updatedById: req.user.id },
    })
    return profile
  })
  res.json({ ok: true, product: await withDisplayMediaOne(serializeProfile(updated)) })
}))

onlineCatalogRouter.get('/online-catalog/products/:id/preview', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const profile = await loadProfile(req.params.id)
  if (!profile.category) throw httpError('请先选择线上分类', 409)
  const doc = buildProductDoc({ profile, category: profile.category, item: profile.inventoryItem })
  res.json({ ok: true, doc: { ...doc, media: previewMedia(doc.media) } })
}))

onlineCatalogRouter.post('/online-catalog/products/:id/publish', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const profile = await loadProfile(req.params.id)
  try {
    const result = await publishOne(profile)
    res.json({ ok: true, result })
  } catch (error) {
    await prisma.onlineProductProfile.update({
      where: { id: profile.id },
      data: { publishState: 'FAILED', lastError: String(error.message || '发布失败').slice(0, 500) },
    }).catch(() => {})
    throw error
  }
}))

onlineCatalogRouter.post('/online-catalog/import-existing', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const publisher = await getOnlineCatalogPublisher()
  const docs = await publisher.readAllProducts()
  const report = { created: [], skipped: [], unmatched: [], combo: [], inactive: [], failed: [] }
  for (const doc of docs) {
    try {
      if (!doc?.id) continue
      if (doc.combo) {
        report.combo.push({ mpId: doc.id, name: doc.name || '' })
        continue
      }
      const existing = await prisma.onlineProductProfile.findUnique({ where: { mpId: doc.id } })
      if (existing) {
        report.skipped.push({ mpId: doc.id, reason: 'ALREADY_MANAGED' })
        continue
      }
      const item = await prisma.inventoryItem.findFirst({ where: { name: String(doc.name || '').trim(), category: 'product' } })
      if (!item) {
        report.unmatched.push({ mpId: doc.id, name: doc.name || '' })
        continue
      }
      if (item.isActive !== true) {
        report.inactive.push({ mpId: doc.id, name: doc.name || '', inventoryItemId: item.id })
        continue
      }
      const categoryName = String(doc.category || '未分类').trim() || '未分类'
      let category = await prisma.onlineCategory.findUnique({ where: { name: categoryName } })
      if (!category) {
        const max = await prisma.onlineCategory.aggregate({ _max: { sortOrder: true } })
        category = await prisma.onlineCategory.create({
          data: {
            id: `oc-${crypto.randomUUID()}`,
            name: categoryName,
            sortOrder: (max._max.sortOrder ?? -1) + 1,
            meta: doc.categoryMeta && typeof doc.categoryMeta === 'object' ? doc.categoryMeta : {},
          },
        })
      }
      const price = Number(doc.unitPriceCent)
      const priceCents = Number.isSafeInteger(price) && price >= 0 ? BigInt(price) : item.salePriceCents
      await prisma.$transaction(async (tx) => {
        await tx.onlineProductProfile.create({
          data: {
            id: `op-${crypto.randomUUID()}`,
            inventoryItemId: item.id,
            mpId: doc.id,
            onlineCategoryId: category.id,
            title: String(doc.name || item.name || '').slice(0, 50),
            subtitle: String(doc.subtitle || '').slice(0, 80),
            spec: String(doc.spec || item.spec || '').slice(0, 60),
            unit: String(doc.unit || item.unit || '份').slice(0, 20),
            priceCents,
            shelfLife: String(doc.shelfLife || '').slice(0, 40),
            storage: String(doc.storage || '').slice(0, 40),
            media: doc.media && typeof doc.media === 'object' ? doc.media : {},
            sortOrder: Number.isInteger(doc.sortOrder) ? doc.sortOrder : 0,
            status: doc.status === 'on' ? 'ON' : 'OFF',
            publishState: 'PUBLISHED',
            publishedVersion: 1,
            publishedAt: new Date(),
          },
        })
        const externalSkuId = onlineSkuId(doc.id)
        await tx.onlineProductPolicy.upsert({
          where: { namespace_externalProductId_externalSkuId: { namespace: ONLINE_CATALOG_NAMESPACE, externalProductId: doc.id, externalSkuId } },
          update: { productId: item.id, enabled: doc.status === 'on', updatedById: req.user.id },
          create: {
            id: `opp-${crypto.randomUUID()}`,
            namespace: ONLINE_CATALOG_NAMESPACE,
            externalProductId: doc.id,
            externalSkuId,
            productId: item.id,
            enabled: doc.status === 'on',
            updatedById: req.user.id,
          },
        })
      })
      report.created.push({ mpId: doc.id, name: doc.name || '', inventoryItemId: item.id, category: category.name })
    } catch (error) {
      report.failed.push({ mpId: doc?.id || '', error: error.message || '导入失败' })
    }
  }
  res.json({ ok: true, report })
}))

onlineCatalogRouter.post('/online-catalog/publish-batch', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => String(id)).filter(Boolean) : []
  if (!ids.length || ids.length > 100) throw httpError('请选择 1-100 个商品发布')
  const results = []
  for (const id of ids) {
    try {
      const profile = await loadProfile(id)
      const result = await publishOne(profile)
      results.push({ id, ok: true, result })
    } catch (error) {
      await prisma.onlineProductProfile.update({ where: { id }, data: { publishState: 'FAILED', lastError: String(error.message || '发布失败').slice(0, 500) } }).catch(() => {})
      results.push({ id, ok: false, error: error.message || '发布失败' })
    }
  }
  res.json({ ok: results.every((row) => row.ok), results })
}))
