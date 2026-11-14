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
import { enumerateOnlineSkus } from './online-catalog-coverage.js'
import { withDisplayMedia, withDisplayMediaOne, resolveTempUrls } from './online-catalog-media.js'
import { uploadCatalogImage } from './online-catalog-upload.js'

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

/** 枚举某个组合商品的全部可售 SKU（与结算侧同一套规则） */
export function comboSkus(mpId, combo) {
  const flavors = (combo?.flavorIds || []).map((id) => ({ id, status: 'on', combo: null }))
  const rows = enumerateOnlineSkus([{ id: mpId, status: 'on', combo }, ...flavors])
  return rows.filter((row) => row.productId === mpId).map((row) => row.skuId)
}

export const COMBO_MAX_SKUS = 500

/**
 * 组合商品每次保存都重建 SKU 映射：新增组合全部可用，被删掉的口味组合则停用。
 * 结算侧（online-checkout）按 externalSkuId 精确查映射，缺一条就 CATALOG_MAPPING_REQUIRED。
 */
export async function syncComboPolicies(tx, { mpId, combo, productId, enabled, userId }) {
  const skuIds = comboSkus(mpId, combo)
  if (!skuIds.length) throw httpError('该组合配置没有任何可售搭配，请检查口味与口味数')
  if (skuIds.length > COMBO_MAX_SKUS) throw httpError(`组合搭配超过 ${COMBO_MAX_SKUS} 种，请减少口味或口味数`)
  const base = { namespace: ONLINE_CATALOG_NAMESPACE, externalProductId: mpId }
  await tx.onlineProductPolicy.createMany({
    data: skuIds.map((externalSkuId) => ({
      id: `opp-${crypto.randomUUID()}`,
      ...base,
      externalSkuId,
      productId,
      enabled,
      updatedById: userId,
    })),
    skipDuplicates: true,
  })
  await tx.onlineProductPolicy.updateMany({
    where: { ...base, externalSkuId: { in: skuIds } },
    data: { productId, enabled, updatedById: userId },
  })
  await tx.onlineProductPolicy.updateMany({
    where: { ...base, externalSkuId: { notIn: skuIds } },
    data: { enabled: false, updatedById: userId },
  })
  return skuIds.length
}

export const COMBO_MAX_SLOTS = 12
export const COMBO_MAX_FLAVORS = 24

/**
 * 校验并归一化组合配置。槽位/口味范围由管理页维护；unitPriceCent 永远由线上价派生，
 * 不接受前端传入（避免和 priceCents 打架）。
 */
export function normalizeComboInput(value, { priceCents = null, mpId = '' } = {}) {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw httpError('组合配置格式不正确')
  const slots = integer(value.slots, '每盒口味数', { min: 1, max: COMBO_MAX_SLOTS })
  if (typeof value.repeat !== 'boolean') throw httpError('组合配置缺少「可否重复选」')
  if (!Array.isArray(value.flavorIds)) throw httpError('请选择可选口味')
  const flavorIds = [...new Set(value.flavorIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
  if (!flavorIds.length) throw httpError('组合商品至少要有 1 个可选口味')
  if (flavorIds.length > COMBO_MAX_FLAVORS) throw httpError(`可选口味最多 ${COMBO_MAX_FLAVORS} 个`)
  if (mpId && flavorIds.includes(mpId)) throw httpError('组合商品不能把自己选为口味')
  if (!value.repeat && slots > flavorIds.length) {
    throw httpError('不允许重复选口味时，每盒口味数不能超过可选口味数量')
  }
  const unitPriceCent = priceCents === null || priceCents === undefined ? null : Number(priceCents)
  return { slots, repeat: value.repeat, flavorIds, ...(unitPriceCent === null ? {} : { unitPriceCent }) }
}

/** 口味必须是已存在的线上商品，且处于上架状态；否则小程序端会枚举不出组合 */
export async function assertComboFlavors(client, combo, selfMpId) {
  if (!combo) return
  const ids = combo.flavorIds.filter((id) => id !== selfMpId)
  if (!ids.length) throw httpError('请至少选择 1 个口味商品')
  const rows = await client.onlineProductProfile.findMany({ where: { mpId: { in: ids } }, select: { mpId: true, status: true, combo: true } })
  const found = new Map(rows.map((row) => [row.mpId, row]))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw httpError(`口味商品不存在：${missing.join('、')}`)
  const nested = ids.filter((id) => found.get(id)?.combo)
  if (nested.length) throw httpError(`口味不能是组合商品：${nested.join('、')}`)
  const offline = ids.filter((id) => found.get(id)?.status !== 'ON')
  if (offline.length) throw httpError(`口味商品未上架：${offline.join('、')}`)
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
  // 组合商品一旦建成，直接清空会让小程序端失去口味选择器；要停售请改用下架
  if (body.combo === null && existing?.combo) throw httpError('组合商品不能直接取消组合，请改用下架')
  return {
    title: text(body.title !== undefined ? body.title : existing?.title || item?.name || '', 50, '线上标题', status === 'ON'),
    subtitle: text(body.subtitle !== undefined ? body.subtitle : existing?.subtitle || '', 80, '副标题'),
    spec: text(body.spec !== undefined ? body.spec : existing?.spec || item?.spec || '', 60, '规格'),
    unit: text(body.unit !== undefined ? body.unit : existing?.unit || item?.unit || '份', 20, '单位'),
    priceCents,
    shelfLife: text(body.shelfLife !== undefined ? body.shelfLife : existing?.shelfLife || '', 40, '保质期'),
    storage: text(body.storage !== undefined ? body.storage : existing?.storage || '', 40, '保存方式'),
    media: normalizeMedia(body.media !== undefined ? body.media : existing?.media || {}),
    combo: body.combo !== undefined
      ? normalizeComboInput(body.combo, {
        priceCents: priceCents ?? existing?.combo?.unitPriceCent ?? null,
        mpId: String(body.mpId ?? existing?.mpId ?? '').trim(),
      })
      : (existing?.combo ?? null),
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
    combo: profile.combo || null,
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

/**
 * 发布前阻断：组合商品的口味必须全部「在架」。
 * - DB 侧：口味档案存在、status=ON、本身不是组合；
 * - 线上侧：CloudBase 文档存在且 status=on（否则小程序端根本选不到该口味）。
 */
export async function assertComboOnShelf(profile, { docs = null, client = prisma, readCatalog = null } = {}) {
  if (!profile?.combo) return
  await assertComboFlavors(client, profile.combo, profile.mpId)
  const catalog = docs || (readCatalog ? await readCatalog() : [])
  const byId = new Map((catalog || []).map((doc) => [doc.id, doc]))
  const offline = []
  for (const id of profile.combo.flavorIds) {
    if (id === profile.mpId) continue
    const doc = byId.get(id)
    if (!doc || doc.status !== 'on') offline.push(`${id}${doc?.name ? `（${doc.name}）` : ''}`)
  }
  if (offline.length) {
    throw httpError(`发布前检查未通过：口味商品未在架 ${offline.join('、')}，请先上架后再发布`, 409)
  }
}

async function publishOne(profile, { catalogDocs = null } = {}) {
  const publisher = await getOnlineCatalogPublisher()
  const category = profile.category
  if (!category) throw httpError('请先选择线上分类', 409)
  if (!category.isActive) throw httpError('分类已停用，不能发布', 409)
  if (!profile.inventoryItem || profile.inventoryItem.isActive !== true) throw httpError('对应 OS 商品未启用，不能发布', 409)
  await assertComboOnShelf(profile, { docs: catalogDocs, readCatalog: () => publisher.readAllProducts() })

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

/**
 * 导入时定位 OS 商品：优先用已有的 SKU 映射反查（权威），再退回名称精确匹配。
 * 线上名与 OS 名经常不完全一致（如「Balls-礼盒」vs「Balls 自选四款礼盒」），
 * 只靠名称会漏收编。
 */
export async function findImportItem(client, doc) {
  const policy = await client.onlineProductPolicy.findFirst({
    where: { namespace: ONLINE_CATALOG_NAMESPACE, externalProductId: doc.id, enabled: true },
  })
  if (policy?.productId) {
    const byPolicy = await client.inventoryItem.findUnique({ where: { id: policy.productId } })
    if (byPolicy) return byPolicy
  }
  return client.inventoryItem.findFirst({ where: { name: String(doc.name || '').trim(), category: 'product' } })
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

// 图片先入云存储，档案里只存 cloud:// 文件 ID（不再把 base64 写进库）
onlineCatalogRouter.post('/online-catalog/uploads', wrap(async (req, res) => {
  requireCatalogManager(req.user)
  const { fileId, cloudPath, size } = await uploadCatalogImage(req.body && req.body.data)
  const lookup = await resolveTempUrls([fileId])
  res.status(201).json({ ok: true, fileId, cloudPath, size, url: lookup[fileId] || '' })
}))

// 概览（只读）：商品结构 + 近 7 日与今日成交 + 待处理售后/发货
onlineCatalogRouter.get('/online-catalog/overview', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireCatalogManager(req.user)
  const now = new Date()
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  // 净成交：已支付且未整单退款
  const settledWhere = (from) => ({ paidAt: { gte: from }, status: { not: 'REFUNDED' } })

  const [productTotal, productOn, productDraft, productFailed, last7, today, paidTotal, shipped, refundPending, refundTotal] = await Promise.all([
    prisma.onlineProductProfile.count(),
    prisma.onlineProductProfile.count({ where: { status: 'ON' } }),
    prisma.onlineProductProfile.count({ where: { status: 'DRAFT' } }),
    prisma.onlineProductProfile.count({ where: { publishState: 'FAILED' } }),
    prisma.onlineSettlement.aggregate({ where: settledWhere(since), _count: { _all: true }, _sum: { totalCents: true } }),
    prisma.onlineSettlement.aggregate({ where: settledWhere(todayStart), _count: { _all: true }, _sum: { totalCents: true } }),
    prisma.onlineSettlement.count({ where: { paidAt: { not: null } } }),
    prisma.onlineFulfillmentAuthorization.count(),
    prisma.onlineRefund.count({ where: { status: 'PENDING' } }),
    prisma.onlineRefund.count(),
  ])

  res.json({
    ok: true,
    generatedAt: now.toISOString(),
    products: { total: productTotal, on: productOn, draft: productDraft, failed: productFailed },
    orders: {
      last7: last7._count._all,
      last7Cents: Number(last7._sum.totalCents || 0),
      today: today._count._all,
      todayCents: Number(today._sum.totalCents || 0),
    },
    fulfillment: { paid: paidTotal, shipped, pending: Math.max(0, paidTotal - shipped) },
    refunds: { pending: refundPending, total: refundTotal },
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
      combo: body.combo,
      mpId,
      sortOrder: body.sortOrder,
      status: body.status,
    }, { item })
    if (data.combo) await assertComboFlavors(prisma, data.combo, mpId)
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
    if (data.combo) {
      await syncComboPolicies(tx, {
        mpId,
        combo: data.combo,
        productId: item.id,
        enabled: profile.status === 'ON',
        userId: req.user.id,
      })
    } else {
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
    }
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
  if (data.combo) await assertComboFlavors(prisma, data.combo, existing.mpId)
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
    if (data.combo) {
      await syncComboPolicies(tx, {
        mpId: existing.mpId,
        combo: data.combo,
        productId: existing.inventoryItemId,
        enabled: profile.status === 'ON',
        userId: req.user.id,
      })
    }
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
      const existing = await prisma.onlineProductProfile.findUnique({ where: { mpId: doc.id } })
      if (existing) {
        report.skipped.push({ mpId: doc.id, reason: 'ALREADY_MANAGED' })
        continue
      }
      const item = await findImportItem(prisma, doc)
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
            combo: doc.combo && typeof doc.combo === 'object' ? doc.combo : null,
            sortOrder: Number.isInteger(doc.sortOrder) ? doc.sortOrder : 0,
            status: doc.status === 'on' ? 'ON' : 'OFF',
            publishState: 'PUBLISHED',
            publishedVersion: 1,
            publishedAt: new Date(),
          },
        })
        // 组合商品的 SKU 是按口味组合逐条映射的（onlineSkuId(mpId, flavors)），
        // 这里不能建「无口味」那条，否则会污染结算映射。
        if (!doc.combo) {
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
        }
      })
      report.created.push({ mpId: doc.id, name: doc.name || '', inventoryItemId: item.id, category: category.name })
      if (doc.combo) report.combo.push({ mpId: doc.id, name: doc.name || '', slots: doc.combo.slots ?? null })
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
  // 批量发布时目录只读一次，避免每个商品都拉全量文档
  let catalogDocs = null
  try {
    const publisher = await getOnlineCatalogPublisher()
    catalogDocs = await publisher.readAllProducts()
  } catch {
    catalogDocs = null
  }
  const results = []
  for (const id of ids) {
    try {
      const profile = await loadProfile(id)
      const result = await publishOne(profile, { catalogDocs })
      results.push({ id, ok: true, result })
    } catch (error) {
      await prisma.onlineProductProfile.update({ where: { id }, data: { publishState: 'FAILED', lastError: String(error.message || '发布失败').slice(0, 500) } }).catch(() => {})
      results.push({ id, ok: false, error: error.message || '发布失败' })
    }
  }
  res.json({ ok: results.every((row) => row.ok), results })
}))
