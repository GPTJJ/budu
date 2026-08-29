import crypto from 'node:crypto'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, dbReady } from './pg.js'
import { notify } from './notification-center.js'
import { listUsers } from './user-store.js'
import { resolveStoreName } from './store-names.js'
import { isFixedStoreKey } from '../shared/storeDirectory.js'
import {
  MODULE_KEYS,
  canAccessPartnerSupplyStore,
  canConfirmPartnerSupply,
  canCreatePartnerSupply,
  canManagePartnerSupplyPartners,
  canOverridePartnerSupplyPrice,
  canRegisterPartnerReceipt,
  hasModuleAccess,
  isSuperUser,
} from '../shared/accountPermissions.js'

export const partnerSupplyRouter = Router()

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (error) {
    const status = error.status || (error.code === 'P2034' ? 409 : 500)
    if (status >= 500) console.error('[partner-supply]', error)
    res.status(status).json({ error: error.code === 'P2034' ? '数据已被其他操作更新，请刷新后重试' : error.message || '服务器错误' })
  }
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`
const actor = (user) => ({ id: String(user?.id || ''), name: String(user?.username || '') })

function requireDb() {
  if (!dbReady()) throw bad('数据库未配置', 503)
}

function requirePartnerModule(user) {
  if (!hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY)) throw bad('该功能尚未授权', 403)
}

function text(value, max, label, required = false) {
  const result = String(value ?? '').trim()
  if (required && !result) throw bad(`${label}不能为空`)
  if (result.length > max) throw bad(`${label}不能超过 ${max} 个字符`)
  return result
}

function discountBps(value, label = '合作折扣') {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > 10000) throw bad(`${label}必须在 0.01%-100% 之间`)
  return result
}

function dateOnly(value, label = '日期') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw bad(`${label}格式应为 YYYY-MM-DD`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw bad(`${label}不正确`)
  return date
}

function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function productCode(product) {
  return String(product.transferCode || product.sku || product.barcode || product.id)
}

function partnerData(body, user) {
  const defaultStoreKey = text(body?.defaultStoreKey, 60, '默认发货门店', true)
  if (!isFixedStoreKey(defaultStoreKey)) throw bad('默认发货门店不正确')
  const who = actor(user)
  return {
    name: text(body?.name, 80, '合作商名称', true),
    contactName: text(body?.contactName, 60, '联系人'),
    contactPhone: text(body?.contactPhone, 60, '联系方式'),
    defaultStoreKey,
    defaultDiscountBps: discountBps(body?.defaultDiscountBps),
    isActive: body?.isActive !== false,
    note: text(body?.note, 500, '备注'),
    updatedBy: who.name,
  }
}

function sumActiveReceipts(order) {
  return (order.receipts || []).filter((receipt) => receipt.status === 'active').reduce((sum, receipt) => sum + receipt.amountCents, 0n)
}

function paymentState(total, received) {
  if (received <= 0n) return 'unpaid'
  if (received >= total) return 'settled'
  return 'partial'
}

function orderPaymentState(order) {
  return order.status === 'withdrawn' ? 'void' : paymentState(order.totalAmountCents, sumActiveReceipts(order))
}

function serializePartner(partner) {
  return {
    id: partner.id,
    name: partner.name,
    contactName: partner.contactName,
    contactPhone: partner.contactPhone,
    defaultStoreKey: partner.defaultStoreKey || '',
    defaultStoreName: partner.defaultStore ? resolveStoreName(partner.defaultStore.key, partner.defaultStore.name) : '',
    defaultDiscountBps: partner.defaultDiscountBps,
    isActive: partner.isActive,
    note: partner.note,
    version: partner.version,
    orderCount: Number(partner._count?.supplyOrders || 0),
    createdAt: partner.createdAt,
    updatedAt: partner.updatedAt,
  }
}

function serializeReceipt(receipt) {
  return {
    id: receipt.id,
    amountCents: receipt.amountCents.toString(),
    receivedDate: receipt.receivedDate.toISOString().slice(0, 10),
    note: receipt.note,
    status: receipt.status,
    createdById: receipt.createdById,
    createdBy: receipt.createdBy,
    createdAt: receipt.createdAt,
    voidedById: receipt.voidedById,
    voidedBy: receipt.voidedBy,
    voidedAt: receipt.voidedAt,
    voidReason: receipt.voidReason,
  }
}

function serializeOrder(order) {
  const received = sumActiveReceipts(order)
  const outstanding = order.status !== 'withdrawn' && order.totalAmountCents > received ? order.totalAmountCents - received : 0n
  return {
    id: order.id,
    orderNo: order.orderNo,
    partnerId: order.partnerId,
    partnerName: order.partnerNameSnapshot,
    fromStoreKey: order.fromStoreKey,
    fromStoreName: order.fromStoreNameSnapshot,
    businessDate: order.businessDate.toISOString().slice(0, 10),
    status: order.status,
    defaultDiscountBps: order.defaultDiscountBpsSnapshot,
    effectiveDiscountBps: order.effectiveDiscountBps,
    totalAmountCents: order.totalAmountCents.toString(),
    receivedAmountCents: received.toString(),
    outstandingAmountCents: outstanding.toString(),
    paymentStatus: orderPaymentState(order),
    note: order.note,
    createdById: order.createdById,
    createdBy: order.createdBy,
    priceOverrideById: order.priceOverrideById,
    priceOverrideBy: order.priceOverrideBy,
    priceOverrideAt: order.priceOverrideAt,
    shippedById: order.shippedById,
    shippedBy: order.shippedBy,
    shippedAt: order.shippedAt,
    withdrawnById: order.withdrawnById,
    withdrawnBy: order.withdrawnBy,
    withdrawnAt: order.withdrawnAt,
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: (order.items || []).map((item) => ({
      id: item.id,
      productId: item.productId,
      productCode: item.productCodeSnapshot,
      productName: item.productNameSnapshot,
      productCategory: item.productCategoryNameSnapshot,
      retailPriceCents: item.retailPriceCentsSnapshot.toString(),
      discountBps: item.discountBpsSnapshot,
      partnerUnitPriceCents: item.partnerUnitPriceCents.toString(),
      quantity: item.quantity,
      subtotalCents: item.subtotalCents.toString(),
    })),
    receipts: (order.receipts || []).map(serializeReceipt),
  }
}

const orderInclude = {
  partner: true,
  fromStore: true,
  items: { orderBy: { id: 'asc' } },
  receipts: { orderBy: [{ receivedDate: 'asc' }, { createdAt: 'asc' }] },
}

function scopedOrderWhere(user, query = {}, includeBusinessDate = true) {
  const requestedStore = text(query.fromStoreKey, 60, '发货门店')
  if (requestedStore && !canAccessPartnerSupplyStore(user, requestedStore)) throw bad('无权查看该门店供货记录', 403)
  const where = {}
  if (query.partnerId) where.partnerId = text(query.partnerId, 120, '合作商')
  if (requestedStore) where.fromStoreKey = requestedStore
  else if (!isSuperUser(user)) where.fromStoreKey = { in: Array.isArray(user.storeKeys) ? user.storeKeys : [] }
  if (query.status && ['pending', 'shipped', 'withdrawn'].includes(query.status)) where.status = query.status
  if (includeBusinessDate) {
    const start = query.start ? dateOnly(query.start, '开始日期') : null
    const end = query.end ? dateOnly(query.end, '结束日期') : null
    if (start && end && start > end) throw bad('开始日期不能晚于结束日期')
    if (start || end) where.businessDate = { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) }
  }
  return where
}

function filterPaymentStatus(rows, status) {
  if (!['unpaid', 'partial', 'settled'].includes(status)) return rows
  return rows.filter((row) => orderPaymentState(row) === status)
}

async function partnerStoreRecipients(storeKey) {
  const users = await listUsers()
  return users.filter((user) => user.status !== 'disabled' && Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey) && hasModuleAccess(user, MODULE_KEYS.PARTNER_SUPPLY))
}

partnerSupplyRouter.get('/partners', wrap(async (req, res) => {
  requireDb()
  requirePartnerModule(req.user)
  const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined
  const rows = await prisma.partner.findMany({
    where: active === undefined ? {} : { isActive: active },
    include: { defaultStore: true, _count: { select: { supplyOrders: true } } },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    take: 500,
  })
  res.json({ rows: rows.map(serializePartner) })
}))

partnerSupplyRouter.post('/partners', wrap(async (req, res) => {
  requireDb()
  if (!canManagePartnerSupplyPartners(req.user)) throw bad('无权管理合作商', 403)
  const data = partnerData(req.body, req.user)
  const duplicate = await prisma.partner.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })
  if (duplicate) throw bad('合作商名称已存在', 409)
  const store = await prisma.store.findUnique({ where: { key: data.defaultStoreKey } })
  if (!store?.active) throw bad('默认发货门店不存在或已停用', 409)
  const who = actor(req.user)
  const row = await prisma.partner.create({
    data: { id: uid('partner'), ...data, createdBy: who.name },
    include: { defaultStore: true, _count: { select: { supplyOrders: true } } },
  })
  res.status(201).json({ ok: true, partner: serializePartner(row) })
}))

partnerSupplyRouter.put('/partners/:id', wrap(async (req, res) => {
  requireDb()
  if (!canManagePartnerSupplyPartners(req.user)) throw bad('无权管理合作商', 403)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw bad('合作商版本不正确，请刷新后重试')
  const data = partnerData(req.body, req.user)
  const duplicate = await prisma.partner.findFirst({ where: { id: { not: req.params.id }, name: { equals: data.name, mode: 'insensitive' } } })
  if (duplicate) throw bad('合作商名称已存在', 409)
  const store = await prisma.store.findUnique({ where: { key: data.defaultStoreKey } })
  if (!store?.active) throw bad('默认发货门店不存在或已停用', 409)
  const updated = await prisma.partner.updateMany({ where: { id: req.params.id, version }, data: { ...data, version: { increment: 1 } } })
  if (updated.count !== 1) throw bad('合作商已被其他人修改，请刷新后重试', 409)
  const row = await prisma.partner.findUnique({ where: { id: req.params.id }, include: { defaultStore: true, _count: { select: { supplyOrders: true } } } })
  res.json({ ok: true, partner: serializePartner(row) })
}))

partnerSupplyRouter.get('/partner-supply-products', wrap(async (req, res) => {
  requireDb()
  requirePartnerModule(req.user)
  const rows = await prisma.inventoryItem.findMany({
    where: { category: 'product', transferEnabled: true, isActive: true },
    include: { productCategory: true },
    orderBy: [{ transferSortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  res.json({ rows: rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: productCode(row),
    salePriceCents: row.salePriceCents?.toString() || '',
    categoryId: row.productCategoryId || '',
    category: row.productCategory ? { id: row.productCategory.id, name: row.productCategory.name, isActive: row.productCategory.isActive, sortOrder: row.productCategory.sortOrder } : null,
    enabled: row.transferEnabled && row.isActive,
  })) })
}))

partnerSupplyRouter.get('/partner-supply-orders', wrap(async (req, res) => {
  requireDb()
  requirePartnerModule(req.user)
  const rows = await prisma.partnerSupplyOrder.findMany({
    where: scopedOrderWhere(req.user, req.query),
    include: orderInclude,
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
    take: 1000,
  })
  res.json({ rows: filterPaymentStatus(rows, String(req.query.paymentStatus || '')).map(serializeOrder) })
}))

partnerSupplyRouter.post('/partner-supply-orders', wrap(async (req, res) => {
  requireDb()
  if (!canCreatePartnerSupply(req.user)) throw bad('无权创建合作商供货单', 403)
  const partnerId = text(req.body?.partnerId, 120, '合作商', true)
  const fromStoreKey = text(req.body?.fromStoreKey, 60, '发货门店', true)
  if (!canAccessPartnerSupplyStore(req.user, fromStoreKey)) throw bad('无权使用该发货门店', 403)
  const partner = await prisma.partner.findUnique({ where: { id: partnerId }, include: { defaultStore: true } })
  if (!partner?.isActive) throw bad('合作商已停用或不存在', 409)
  const store = await prisma.store.findUnique({ where: { key: fromStoreKey } })
  if (!store?.active || !isFixedStoreKey(fromStoreKey)) throw bad('发货门店不存在或已停用', 409)
  const effectiveDiscountBps = discountBps(req.body?.effectiveDiscountBps ?? partner.defaultDiscountBps)
  const priceOverridden = effectiveDiscountBps !== partner.defaultDiscountBps
  if (priceOverridden && !canOverridePartnerSupplyPrice(req.user)) throw bad('无权修改合作价格', 403)
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : []
  if (!rawItems.length || rawItems.length > 100) throw bad('请选择 1-100 种产品')
  const itemInputs = rawItems.map((item) => {
    const productId = text(item?.productId, 120, '产品', true)
    const quantity = Number(item?.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999999) throw bad('产品数量必须是 1-999999 的整数')
    return { productId, quantity }
  })
  if (new Set(itemInputs.map((item) => item.productId)).size !== itemInputs.length) throw bad('产品清单存在重复项')
  const products = await prisma.inventoryItem.findMany({ where: { id: { in: itemInputs.map((item) => item.productId) } }, include: { productCategory: true } })
  if (products.length !== itemInputs.length) throw bad('产品资料已变化，请刷新后重试', 409)
  const byId = new Map(products.map((product) => [product.id, product]))
  let totalAmountCents = 0n
  const orderId = uid('pso')
  const itemRows = itemInputs.map((input) => {
    const product = byId.get(input.productId)
    if (!product || product.category !== 'product' || !product.transferEnabled || !product.isActive) throw bad('产品已停用，请刷新后重试', 409)
    if (product.salePriceCents === null || product.salePriceCents <= 0n) throw bad(`产品「${product.name}」尚未设置有效零售价`, 409)
    const partnerUnitPriceCents = (product.salePriceCents * BigInt(effectiveDiscountBps) + 5000n) / 10000n
    if (partnerUnitPriceCents <= 0n) throw bad(`产品「${product.name}」合作价无效`, 409)
    const subtotalCents = partnerUnitPriceCents * BigInt(input.quantity)
    totalAmountCents += subtotalCents
    return {
      id: uid('psi'), orderId, productId: product.id,
      productCodeSnapshot: productCode(product), productNameSnapshot: product.name,
      productCategoryNameSnapshot: product.productCategory?.name || '',
      retailPriceCentsSnapshot: product.salePriceCents, discountBpsSnapshot: effectiveDiscountBps,
      partnerUnitPriceCents, quantity: input.quantity, subtotalCents,
    }
  })
  const who = actor(req.user)
  const businessDate = dateOnly(req.body?.businessDate || beijingToday(), '业务日期')
  const dateKey = businessDate.toISOString().slice(0, 10).replaceAll('-', '')
  const orderNo = `PS-${dateKey}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  const row = await prisma.partnerSupplyOrder.create({
    data: {
      id: orderId, orderNo, partnerId: partner.id, partnerNameSnapshot: partner.name,
      fromStoreKey, fromStoreNameSnapshot: resolveStoreName(store.key, store.name), businessDate,
      defaultDiscountBpsSnapshot: partner.defaultDiscountBps, effectiveDiscountBps, totalAmountCents,
      note: text(req.body?.note, 500, '备注'), createdById: who.id, createdBy: who.name,
      priceOverrideById: priceOverridden ? who.id : '', priceOverrideBy: priceOverridden ? who.name : '',
      priceOverrideAt: priceOverridden ? new Date() : null,
      items: { create: itemRows },
    },
    include: orderInclude,
  })
  const recipients = await partnerStoreRecipients(fromStoreKey)
  await Promise.all(recipients.map((user) => notify({
    username: user.username, templateKey: 'partner_supply_new',
    data: { partner: partner.name, store: resolveStoreName(store.key, store.name), count: itemRows.length, submitter: who.name },
    target: 'partner-supply', refType: 'partner-supply-order', refId: row.id,
  })))
  res.status(201).json({ ok: true, order: serializeOrder(row) })
}))

partnerSupplyRouter.post('/partner-supply-orders/:id/ship', wrap(async (req, res) => {
  requireDb()
  const existing = await prisma.partnerSupplyOrder.findUnique({ where: { id: req.params.id } })
  if (!existing) throw bad('供货单不存在', 404)
  if (!canConfirmPartnerSupply(req.user, existing.fromStoreKey)) throw bad('无权确认该门店发货', 403)
  if (existing.status !== 'pending') throw bad('只有待备货供货单可以确认发货', 409)
  const version = Number(req.body?.version)
  const who = actor(req.user)
  const updated = await prisma.partnerSupplyOrder.updateMany({
    where: { id: existing.id, status: 'pending', version },
    data: { status: 'shipped', shippedById: who.id, shippedBy: who.name, shippedAt: new Date(), version: { increment: 1 } },
  })
  if (updated.count !== 1) throw bad('供货单已被其他人更新，请刷新后重试', 409)
  const row = await prisma.partnerSupplyOrder.findUnique({ where: { id: existing.id }, include: orderInclude })
  if (row.createdBy && row.createdBy !== who.name) await notify({
    username: row.createdBy, templateKey: 'partner_supply_shipped',
    data: { partner: row.partnerNameSnapshot, store: row.fromStoreNameSnapshot, operator: who.name },
    target: 'partner-supply', refType: 'partner-supply-order', refId: row.id,
  })
  res.json({ ok: true, order: serializeOrder(row) })
}))

partnerSupplyRouter.post('/partner-supply-orders/:id/withdraw', wrap(async (req, res) => {
  requireDb()
  const existing = await prisma.partnerSupplyOrder.findUnique({ where: { id: req.params.id }, include: { receipts: true } })
  if (!existing) throw bad('供货单不存在', 404)
  const who = actor(req.user)
  if (existing.createdById !== who.id && existing.createdBy !== who.name && !isSuperUser(req.user)) throw bad('无权撤回该供货单', 403)
  if (existing.status !== 'pending') throw bad('只有待备货供货单可以撤回', 409)
  if (sumActiveReceipts(existing) > 0n) throw bad('已有有效收款记录，不能直接撤回', 409)
  const version = Number(req.body?.version)
  const updated = await prisma.partnerSupplyOrder.updateMany({
    where: { id: existing.id, status: 'pending', version },
    data: { status: 'withdrawn', withdrawnById: who.id, withdrawnBy: who.name, withdrawnAt: new Date(), version: { increment: 1 } },
  })
  if (updated.count !== 1) throw bad('供货单已被其他人更新，请刷新后重试', 409)
  const row = await prisma.partnerSupplyOrder.findUnique({ where: { id: existing.id }, include: orderInclude })
  res.json({ ok: true, order: serializeOrder(row) })
}))

partnerSupplyRouter.post('/partner-supply-orders/:id/receipts', wrap(async (req, res) => {
  requireDb()
  if (!canRegisterPartnerReceipt(req.user)) throw bad('无权登记合作商收款', 403)
  let amountCents
  try { amountCents = BigInt(String(req.body?.amountCents || '')) } catch { throw bad('收款金额不正确') }
  if (amountCents <= 0n) throw bad('收款金额必须大于 0')
  const receivedDate = dateOnly(req.body?.receivedDate || beijingToday(), '收款日期')
  const note = text(req.body?.note, 300, '收款备注')
  const who = actor(req.user)
  const receipt = await prisma.$transaction(async (tx) => {
    const order = await tx.partnerSupplyOrder.findUnique({ where: { id: req.params.id }, include: { receipts: true } })
    if (!order) throw bad('供货单不存在', 404)
    if (order.status === 'withdrawn') throw bad('已撤回供货单不能登记收款', 409)
    const received = sumActiveReceipts(order)
    if (received + amountCents > order.totalAmountCents) throw bad('累计收款不能超过应收金额', 409)
    return tx.partnerReceipt.create({ data: {
      id: uid('prc'), orderId: order.id, amountCents, receivedDate, note,
      createdById: who.id, createdBy: who.name,
    } })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  const row = await prisma.partnerSupplyOrder.findUnique({ where: { id: req.params.id }, include: orderInclude })
  res.status(201).json({ ok: true, receipt: serializeReceipt(receipt), order: serializeOrder(row) })
}))

partnerSupplyRouter.post('/partner-receipts/:id/void', wrap(async (req, res) => {
  requireDb()
  if (!canRegisterPartnerReceipt(req.user)) throw bad('无权作废合作商收款', 403)
  const reason = text(req.body?.reason, 300, '作废原因', true)
  const who = actor(req.user)
  const updated = await prisma.partnerReceipt.updateMany({
    where: { id: req.params.id, status: 'active' },
    data: { status: 'voided', voidedById: who.id, voidedBy: who.name, voidedAt: new Date(), voidReason: reason },
  })
  if (updated.count !== 1) throw bad('收款记录不存在或已作废', 409)
  const receipt = await prisma.partnerReceipt.findUnique({ where: { id: req.params.id } })
  res.json({ ok: true, receipt: serializeReceipt(receipt) })
}))

partnerSupplyRouter.get('/partner-supply-report', wrap(async (req, res) => {
  requireDb()
  requirePartnerModule(req.user)
  const orderWhere = scopedOrderWhere(req.user, req.query, true)
  const receiptOrderWhere = scopedOrderWhere(req.user, req.query, false)
  const start = req.query.start ? dateOnly(req.query.start, '开始日期') : null
  const end = req.query.end ? dateOnly(req.query.end, '结束日期') : null
  if (start && end && start > end) throw bad('开始日期不能晚于结束日期')
  const [rawOrders, rawReceipts] = await Promise.all([
    prisma.partnerSupplyOrder.findMany({ where: orderWhere, include: orderInclude, orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }], take: 5000 }),
    prisma.partnerReceipt.findMany({
      where: {
        status: 'active',
        ...(start || end ? { receivedDate: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
        order: receiptOrderWhere,
      },
      include: { order: { include: { receipts: true } } }, orderBy: [{ receivedDate: 'asc' }, { createdAt: 'asc' }], take: 10000,
    }),
  ])
  const orders = filterPaymentStatus(rawOrders, String(req.query.paymentStatus || ''))
  const allowedOrderIds = new Set(filterPaymentStatus(rawReceipts.map((receipt) => receipt.order), String(req.query.paymentStatus || '')).map((order) => order.id))
  const receipts = rawReceipts.filter((receipt) => !req.query.paymentStatus || allowedOrderIds.has(receipt.orderId))
  const summary = new Map()
  const ensure = (partnerId, partnerName) => {
    if (!summary.has(partnerId)) summary.set(partnerId, { partnerId, partnerName, orderCount: 0, supplyAmountCents: 0n, receivedAmountCents: 0n, outstandingAmountCents: 0n })
    return summary.get(partnerId)
  }
  for (const order of orders) {
    if (order.status === 'withdrawn') continue
    const entry = ensure(order.partnerId, order.partnerNameSnapshot)
    entry.orderCount += 1
    entry.supplyAmountCents += order.totalAmountCents
    entry.outstandingAmountCents += order.totalAmountCents - sumActiveReceipts(order)
  }
  for (const receipt of receipts) ensure(receipt.order.partnerId, receipt.order.partnerNameSnapshot).receivedAmountCents += receipt.amountCents
  res.json({
    summary: [...summary.values()].sort((a, b) => a.partnerName.localeCompare(b.partnerName, 'zh-CN')).map((row) => ({
      ...row,
      supplyAmountCents: row.supplyAmountCents.toString(), receivedAmountCents: row.receivedAmountCents.toString(), outstandingAmountCents: row.outstandingAmountCents.toString(),
    })),
    orders: orders.map(serializeOrder),
    receipts: receipts.map((receipt) => ({ ...serializeReceipt(receipt), orderId: receipt.orderId, orderNo: receipt.order.orderNo, partnerId: receipt.order.partnerId, partnerName: receipt.order.partnerNameSnapshot })),
  })
}))
