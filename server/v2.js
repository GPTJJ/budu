import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { sendWechatMarkdown, wecomWebhookUrl } from './wechat-alert.js'
import { broadcast, notify } from './notification-center.js'
import { listUsers } from './user-store.js'
import { deliverTransferRequestNotification } from './transfer-notification.js'
import { EMPTY_TRANSFER_DELIVERY_SUMMARY, loadTransferDeliverySummaries } from './transfer-delivery-recipients.js'
import { ocrConfigured, extractInvoiceFromBase64, generalOcrText } from './ocr.js'
import { correlateOcrRequest } from './ocr-integrity.js'
import { FIXED_OPTION_NAMES } from './fixedOptions.js'
import { CHANGELOG } from './changelog.js'
import { normalizeItemCategory } from './productCategories.js'
import { resolveStoreName } from './store-names.js'
import { FIXED_STORE_KEYS, isFixedStoreKey } from '../shared/storeDirectory.js'
import {
  DAILY_ENTRY_CAPABILITIES,
  canAccessTransferStore,
  canManageAccounts,
  canManageTransferStore,
  hasDailyEntryCapability,
  hasModuleAccess,
  hasInventoryTransferAll,
  isSuperUser,
  MODULE_KEYS,
} from '../shared/accountPermissions.js'

export const v2Router = Router()

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('[v2]', err)
    res.status(status).json({ error: err.message || '服务器错误' })
  }
}

const bad = (msg, status = 400) => {
  const e = new Error(msg)
  e.status = status
  return e
}

const internalFailure = (publicMessage, cause) => {
  const error = new Error(publicMessage, { cause })
  error.status = 500
  error.publicMessage = publicMessage
  return error
}

function canStore(user, storeKey) {
  if (!user || user.role === 'public') return false
  if (isSuperUser(user)) return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey)
}

function isManager(user) {
  return Boolean(user && (isSuperUser(user) || user.role === 'manager'))
}

function canInvoice(user) {
  return Boolean(user && user.role !== 'public')
}

function canMailing(user) {
  return Boolean(user && user.role !== 'public')
}

function whereStores(user, storeKeyParam) {
  if (storeKeyParam) return storeKeyParam
  if (isSuperUser(user) || user.role === 'public') return undefined
  return { in: Array.isArray(user.storeKeys) ? user.storeKeys : [] }
}

function dateOnly(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) throw bad('日期格式应为 YYYY-MM-DD')
  return new Date(`${s}T00:00:00.000Z`)
}

function isoDate(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
}

async function ensureStore(storeKey, name) {
  const key = String(storeKey || '').trim()
  if (!isFixedStoreKey(key)) throw bad('门店不存在或已停用')
  const known = resolveStoreName(key) || name
  return prisma.store.upsert({
    where: { key },
    update: { name: known, active: true },
    create: { key, name: known, active: true },
  })
}

export async function upsertItem(name, category = 'product') {
  const n = String(name || '').trim()
  if (!n || n.length > 50) throw bad('货品名称不正确')
  const norm = normalizeItemCategory(n, category)
  const existing = await prisma.inventoryItem.findUnique({ where: { name: n } })
  if (existing) {
    // 历史错误修复：固定物料被存成 product 时自动纠正为 material；其他手动品类保留
    if (existing.category === 'product' && norm === 'material') {
      return prisma.inventoryItem.update({ where: { id: existing.id }, data: { category: 'material' } })
    }
    return existing
  }
  return prisma.inventoryItem.create({
    data: { id: `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: n, category: norm },
  })
}

export function itemRows(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) throw bad('请至少添加一种货品（最多 50 种）')
  const rows = items.map((it) => {
    const itemId = String(it.itemId || '').trim()
    const name = String(it.name || it.productName || '').trim()
    const note = it.note === undefined || it.note === null ? '' : String(it.note).trim().slice(0, 100)
    const category = normalizeItemCategory(name, it.category)
    if (!name || name.length > 50) throw bad('货品名称不正确')
    const usesUnitQuantities = Object.prototype.hasOwnProperty.call(it, 'boxQuantity') || Object.prototype.hasOwnProperty.call(it, 'pieceQuantity')
    if (usesUnitQuantities) {
      const boxQuantity = Number(it.boxQuantity || 0)
      const pieceQuantity = Number(it.pieceQuantity || 0)
      if (!Number.isInteger(boxQuantity) || boxQuantity < 0 || boxQuantity > 999999) throw bad('箱数应为 0-999999 的整数')
      if (!Number.isInteger(pieceQuantity) || pieceQuantity < 0 || pieceQuantity > 999999) throw bad('散颗数应为 0-999999 的整数')
      if (boxQuantity === 0 && pieceQuantity === 0) throw bad('箱数和散颗数不能同时为 0')
      return { itemId, name, quantity: null, boxQuantity, pieceQuantity, usesUnitQuantities, note, category }
    }
    const quantity = Number(it.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999999) throw bad('数量应为 1-999999 的整数')
    return { itemId, name, quantity, boxQuantity: 0, pieceQuantity: 0, usesUnitQuantities, note, category }
  })
  const seen = new Set()
  for (const row of rows) {
    const identity = row.itemId || `${row.category}:${row.name}`
    if (seen.has(identity)) throw bad('同一货品只能填写一次')
    seen.add(identity)
  }
  return rows
}

async function findActiveTransferItem(row) {
  const existing = await prisma.inventoryItem.findUnique({
    where: row.itemId ? { id: row.itemId } : { name: row.name },
    include: { productCategory: true },
  })
  if (!existing || !existing.transferEnabled || existing.category !== row.category) {
    throw bad('货品已停用或不存在，请刷新后重试', 409)
  }
  return existing
}

function inventoryItemCode(item) {
  return String(item?.transferCode || item?.sku || item?.barcode || item?.id || '')
}

function transferItemBase(row, item) {
  return {
    itemId: item.id,
    note: row.note,
    itemNameSnapshot: item.name,
    itemCodeSnapshot: inventoryItemCode(item),
    categorySnapshot: row.category,
    productCategoryNameSnapshot: row.category === 'product' ? item.productCategory?.name || '' : '',
  }
}

function transferItemCreates(row, item) {
  const packagingConfigured = item.transferBoxEnabled || item.transferPieceEnabled
  if (!row.usesUnitQuantities) {
    if (packagingConfigured) throw bad(`「${item.name}」请按箱/颗填写调拨数量`, 409)
    return [{ ...transferItemBase(row, item), quantity: row.quantity, quantityUnit: 'legacy', unitWeightGramsSnapshot: null }]
  }
  if (!packagingConfigured) throw bad(`「${item.name}」未配置箱/颗调拨规格`, 409)
  if (row.boxQuantity > 0 && (!item.transferBoxEnabled || !item.transferBoxWeightGrams)) throw bad(`「${item.name}」不允许整箱调拨`, 409)
  if (row.pieceQuantity > 0 && (!item.transferPieceEnabled || !item.transferPieceWeightGrams)) throw bad(`「${item.name}」不允许散颗调拨`, 409)
  return [
    row.boxQuantity > 0 && { ...transferItemBase(row, item), quantity: row.boxQuantity, quantityUnit: 'box', unitWeightGramsSnapshot: item.transferBoxWeightGrams },
    row.pieceQuantity > 0 && { ...transferItemBase(row, item), quantity: row.pieceQuantity, quantityUnit: 'piece', unitWeightGramsSnapshot: item.transferPieceWeightGrams },
  ].filter(Boolean)
}

function serializeTransferItems(items) {
  const result = []
  const packaged = new Map()
  for (const it of items) {
    const category = it.categorySnapshot || normalizeItemCategory(it.item.name, it.item.category)
    const base = {
      id: it.id,
      itemId: it.itemId,
      category,
      productName: it.itemNameSnapshot || it.item.name,
      itemCode: it.itemCodeSnapshot || '',
      productCategory: it.productCategoryNameSnapshot || '',
      note: it.note,
    }
    if (!['box', 'piece'].includes(it.quantityUnit)) {
      result.push({
        ...base,
        quantity: it.quantity,
        shippedQuantity: it.shippedQuantity,
        shipmentRecorded: it.shippedQuantity !== null,
      })
      continue
    }
    let row = packaged.get(it.itemId)
    if (!row) {
      row = {
        ...base,
        quantity: null,
        boxQuantity: 0,
        pieceQuantity: 0,
        shippedBoxQuantity: 0,
        shippedPieceQuantity: 0,
        shipmentRecorded: true,
        boxWeightGrams: null,
        pieceWeightGrams: null,
        estimatedWeightGrams: 0,
      }
      packaged.set(it.itemId, row)
      result.push(row)
    }
    row.shipmentRecorded = row.shipmentRecorded && it.shippedQuantity !== null
    if (it.quantityUnit === 'box') {
      row.boxQuantity += it.quantity
      if (it.shippedQuantity !== null) row.shippedBoxQuantity += it.shippedQuantity
      row.boxWeightGrams = it.unitWeightGramsSnapshot
    } else {
      row.pieceQuantity += it.quantity
      if (it.shippedQuantity !== null) row.shippedPieceQuantity += it.shippedQuantity
      row.pieceWeightGrams = it.unitWeightGramsSnapshot
    }
    row.estimatedWeightGrams += it.quantity * Number(it.unitWeightGramsSnapshot || 0)
  }
  return result
}

function serializeTransfer(r) {
  const items = serializeTransferItems(r.items)
  return {
    id: r.id,
    type: 'transfer',
    storeKey: r.toStoreKey,
    fromStoreKey: r.fromStoreKey,
    storeName: r.toStore ? resolveStoreName(r.toStore.key, r.toStore.name) : r.toLocationName || '',
    fromStoreName: r.fromStore ? resolveStoreName(r.fromStore.key, r.fromStore.name) : r.fromLocationName || '',
    status: r.status,
    note: r.note,
    createdBy: r.createdBy,
    shippedBy: r.shippedBy || '',
    shippedAt: r.shippedAt || null,
    withdrawnBy: r.withdrawnBy || '',
    withdrawnAt: r.withdrawnAt || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    shipmentRecorded: items.length > 0 && items.every((item) => item.shipmentRecorded),
    items,
  }
}

function parseShippedQuantity(value, label, requested) {
  if (value === undefined || value === null || value === '') throw bad(`${label}不能为空`)
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > requested) {
    throw bad(`${label}应为 0-${requested} 的整数`)
  }
  return quantity
}

function transferShipmentUpdates(inputItems, storedItems) {
  if (!Array.isArray(inputItems) || inputItems.length === 0) throw bad('请逐项核对实际发货数量')
  const storedByItem = new Map()
  for (const row of storedItems) {
    const group = storedByItem.get(row.itemId) || []
    group.push(row)
    storedByItem.set(row.itemId, group)
  }
  if (inputItems.length !== storedByItem.size) throw bad('实际发货明细必须与原申请完全一致')

  const inputByItem = new Map()
  for (const input of inputItems) {
    const itemId = String(input?.itemId || '').trim()
    if (!itemId || !storedByItem.has(itemId)) throw bad('实际发货明细包含未申请货品')
    if (inputByItem.has(itemId)) throw bad('同一货品只能核对一次')
    inputByItem.set(itemId, input)
  }

  const updates = []
  let totalShipped = 0
  for (const [itemId, rows] of storedByItem) {
    const input = inputByItem.get(itemId)
    if (!input) throw bad('实际发货明细缺少原申请货品')
    const packaged = rows.some((row) => ['box', 'piece'].includes(row.quantityUnit))
    if (packaged && rows.some((row) => !['box', 'piece'].includes(row.quantityUnit))) throw bad('调拨单位事实冲突', 409)
    if (!packaged) {
      if (Object.prototype.hasOwnProperty.call(input, 'shippedBoxQuantity') || Object.prototype.hasOwnProperty.call(input, 'shippedPieceQuantity')) {
        throw bad('普通件数货品不得提交箱/颗实发数量')
      }
      const requested = rows.reduce((sum, row) => sum + row.quantity, 0)
      const shipped = parseShippedQuantity(input.shippedQuantity, '实发数量', requested)
      if (rows.length !== 1) throw bad('历史调拨单位事实不唯一', 409)
      updates.push({ id: rows[0].id, shippedQuantity: shipped })
      totalShipped += shipped
      continue
    }

    if (Object.prototype.hasOwnProperty.call(input, 'shippedQuantity')) throw bad('箱/颗货品不得提交普通件数')
    const requestedBox = rows.filter((row) => row.quantityUnit === 'box').reduce((sum, row) => sum + row.quantity, 0)
    const requestedPiece = rows.filter((row) => row.quantityUnit === 'piece').reduce((sum, row) => sum + row.quantity, 0)
    const shippedBox = parseShippedQuantity(input.shippedBoxQuantity, '实发箱数', requestedBox)
    const shippedPiece = parseShippedQuantity(input.shippedPieceQuantity, '实发颗数', requestedPiece)
    for (const row of rows) {
      updates.push({ id: row.id, shippedQuantity: row.quantityUnit === 'box' ? shippedBox : shippedPiece })
    }
    totalShipped += shippedBox + shippedPiece
  }
  if (totalShipped <= 0) throw bad('没有实际发货商品')
  return updates
}

function serializePurchase(r) {
  return {
    id: r.id,
    type: 'purchase',
    storeKey: r.storeKey,
    storeName: r.store ? resolveStoreName(r.store.key, r.store.name) : '',
    status: r.status,
    supplier: r.supplierRef?.name || r.supplier,
    expectedAt: r.expectedAt,
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    items: r.items.map((it) => ({
      id: it.id,
      itemId: it.itemId,
      category: normalizeItemCategory(it.item.name, it.item.category),
      productName: it.itemNameSnapshot || it.item.name,
      unit: it.item.unit || '',
      quantity: it.orderedQty,
      receivedQty: it.receivedQty,
      note: it.note,
    })),
  }
}

function serializeInvoice(r) {
  return {
    id: r.id,
    storeKey: r.storeKey,
    titleType: r.titleType,
    companyName: r.companyName,
    taxNo: r.taxNo,
    amountCents: r.amountCents.toString(),
    category: r.category,
    email: r.email,
    note: r.note,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

function serializeMailingRecord(r) {
  return {
    id: r.id,
    method: r.method,
    postage: r.postage,
    fee: r.fee,
    storeKey: r.storeKey || '',
    shippingTier: r.shippingTier || '',
    shippingAmountCents: r.shippingAmountCents,
    shippingPaymentMode: r.shippingPaymentMode || '',
    shippingPaymentConfirmedAt: r.shippingPaymentConfirmedAt,
    shippingPaymentConfirmedBy: r.shippingPaymentConfirmedBy || '',
    address: r.address,
    recipient: r.recipient,
    phone: r.phone,
    remark: r.remark,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    shippedAt: r.shippedAt,
  }
}

function serializeBigBonus(r) {
  return {
    id: r.id,
    employeeId: r.employeeId || '',
    staffKey: r.staffKey,
    staffName: r.staffName,
    storeKey: r.storeKey,
    date: isoDate(r.date),
    amountCents: r.amountCents.toString(),
    bonusCents: r.bonusCents.toString(),
    receipt: r.receipt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

function serializeDailyPayAdjustment(r) {
  return {
    id: r.id,
    employeeId: r.employeeId || '',
    staffName: r.staffName,
    date: isoDate(r.date),
    autoPayCentsSnapshot: r.autoPayCentsSnapshot.toString(),
    adjustedPayCents: r.adjustedPayCents.toString(),
    reason: r.reason,
    active: r.active,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  }
}

function dailyPayAdjustmentAuditValue(r) {
  if (!r) return null
  return {
    autoPayCentsSnapshot: r.autoPayCentsSnapshot.toString(),
    adjustedPayCents: r.adjustedPayCents.toString(),
    reason: r.reason,
    active: r.active,
    version: r.version,
  }
}

function selfEmployeeId(user) {
  return user?.role === 'staff' ? String(user.employeeId || '').trim() : ''
}

async function scopeDailyPayAdjustments(rows, user) {
  if (isSuperUser(user)) return rows
  if (!user || user.role === 'public') return []
  if (user.role === 'staff') {
    const ownId = selfEmployeeId(user)
    return ownId ? rows.filter((row) => String(row.employeeId || '').trim() === ownId) : []
  }
  const allowedStores = new Set(Array.isArray(user.storeKeys) ? user.storeKeys : [])
  if (allowedStores.size === 0 || rows.length === 0) return []

  const dates = [...new Map(rows.map((row) => [isoDate(row.date), row.date])).values()]
  const entries = await prisma.dailyEntry.findMany({
    where: { date: { in: dates } },
    select: { storeKey: true, date: true, staffNames: true },
  })
  return rows.filter((row) => {
    const date = isoDate(row.date)
    const duties = entries.filter(
      (entry) => isoDate(entry.date) === date && Array.isArray(entry.staffNames) && entry.staffNames.includes(row.staffName),
    )
    return duties.length > 0 && duties.every((entry) => allowedStores.has(entry.storeKey))
  })
}

function storeFilter(user) {
  if (isSuperUser(user) || user.role === 'public') return null
  return Array.isArray(user.storeKeys) && user.storeKeys.length > 0 ? { in: user.storeKeys } : { in: [] }
}

function canWrite(user) {
  return Boolean(user && (isSuperUser(user) || user.role === 'manager'))
}

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

async function maybeAlertLowStock(storeKey) {
  try {
    const day = new Date().toISOString().slice(0, 10)
    const rows = await prisma.stockBalance.findMany({
      where: { storeKey, minQty: { gt: 0 } },
      include: { item: true },
    })
    for (const r of rows.filter((x) => x.quantity <= x.minQty)) {
      const exists = await prisma.alertLog.findUnique({
        where: { storeKey_itemId_day: { storeKey: r.storeKey, itemId: r.itemId, day } },
      })
      if (exists) continue
      await prisma.alertLog.create({
        data: { id: uid('al'), storeKey: r.storeKey, itemId: r.itemId, day },
      })
      await broadcast(
        '库存预警',
        `门店 **${r.storeKey}** 的「${r.item.name}」当前库存 **${r.quantity}**，已低于安全库存 **${r.minQty}**`,
      )
    }
  } catch (e) {
    console.error('[alert]', e.message)
  }
}

async function computeProfit(user, month, store) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('月份格式应为 YYYY-MM')
  if (store && !canStore(user, store)) throw bad('无权限', 403)
  const sf = storeFilter(user)
  const [y, m] = month.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))
  const where = { date: { gte: start, lt: end } }
  if (store) where.storeKey = store
  else if (sf) where.storeKey = sf
  const entries = await prisma.dailyEntry.findMany({ where })
  const expenses = await prisma.expense.findMany({ where })
  const dayMap = new Map()
  const monthMap = new Map()
  for (const e of entries) {
    const d = isoDate(e.date)
    const k = `${e.storeKey}|${d}`
    const item = dayMap.get(k) || { storeKey: e.storeKey, date: d, incCents: 0n, expenseCents: 0n }
    item.incCents += e.incCents
    dayMap.set(k, item)
    const mm = monthMap.get(e.storeKey) || { storeKey: e.storeKey, incCents: 0n, expenseCents: 0n }
    mm.incCents += e.incCents
    monthMap.set(e.storeKey, mm)
  }
  for (const e of expenses) {
    const d = isoDate(e.date)
    const k = `${e.storeKey}|${d}`
    const item = dayMap.get(k) || { storeKey: e.storeKey, date: d, incCents: 0n, expenseCents: 0n }
    item.expenseCents += e.amountCents
    dayMap.set(k, item)
    const mm = monthMap.get(e.storeKey) || { storeKey: e.storeKey, incCents: 0n, expenseCents: 0n }
    mm.expenseCents += e.amountCents
    monthMap.set(e.storeKey, mm)
  }
  const toNum = (v) => v.toString()
  const rows = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.storeKey.localeCompare(b.storeKey))
    .map((r) => ({
      storeKey: r.storeKey,
      date: r.date,
      incCents: toNum(r.incCents),
      expenseCents: toNum(r.expenseCents),
      profitCents: toNum(r.incCents - r.expenseCents),
    }))
  const monthly = [...monthMap.values()]
    .map((r) => ({
      storeKey: r.storeKey,
      incCents: toNum(r.incCents),
      expenseCents: toNum(r.expenseCents),
      profitCents: toNum(r.incCents - r.expenseCents),
    }))
    .sort((a, b) => Number(b.profitCents) - Number(a.profitCents))
  return { month, rows, monthly }
}

// ---------- 业绩录入（金额按分，版本乐观锁） ----------
v2Router.get('/daily-entries', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  const month = String(req.query.month || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const where = { storeKey: whereStores(req.user, store || undefined) }
  if (/^\d{4}-\d{2}$/.test(month)) {
    const start = new Date(`${month}-01T00:00:00.000Z`)
    const [y, m] = month.split('-').map(Number)
    const end = new Date(Date.UTC(y, m, 1))
    where.date = { gte: start, lt: end }
  }
  const rows = await prisma.dailyEntry.findMany({
    where,
    orderBy: [{ date: 'desc' }, { storeKey: 'asc' }],
  })
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      storeKey: r.storeKey,
      date: isoDate(r.date),
      incCents: r.incCents.toString(),
      ord: r.ord,
      staffNames: r.staffNames,
      status: r.status,
      version: r.version,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt,
    })),
  })
}))

v2Router.put('/daily-entries', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, date, incCents, ord, staffNames, version } = req.body || {}
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.EDIT)) throw bad('无权限', 403)
  const store = await prisma.store.findUnique({ where: { key: storeKey } })
  const effDate = store?.salesDataSourceEffectiveDate ? store.salesDataSourceEffectiveDate.toISOString().slice(0, 10) : ''
  const source = store?.salesDataSource === 'manual' || (effDate && date && String(date).slice(0, 10) < effDate)
    ? 'manual'
    : (store?.salesDataSource || 'manual')
  if (source === 'pos') throw bad('该门店已接入 POS，营业数据自动同步，不可人工修改', 403)
  if (source === 'hybrid' && !isSuperUser(req.user) && req.user.role !== 'manager') {
    throw bad('混合模式门店的营业数据由 POS 同步，员工不可直接修改', 403)
  }
  const d = dateOnly(date)
  const cents = Number(incCents)
  const orderCount = Number(ord)
  if (!Number.isInteger(cents) || cents < 0 || cents > 999999999999) throw bad('营业收入不正确（单位：分）')
  if (!Number.isInteger(orderCount) || orderCount < 0 || orderCount > 999999) throw bad('订单数不正确')
  const names = Array.isArray(staffNames) ? staffNames.slice(0, 50).map((s) => String(s).trim().slice(0, 30)) : []
  await ensureStore(storeKey)
  const composite = { storeKey, date: d }
  const existing = await prisma.dailyEntry.findUnique({ where: { storeKey_date: composite } })
  if (existing?.status === 'confirmed') throw bad('日报已确认，请通过受控历史修正流程处理', 409)
  if (existing && (version == null || existing.version !== Number(version))) {
    return res.status(409).json({
      error: '数据已被他人修改，已加载最新数据',
      latest: {
        id: existing.id,
        storeKey: existing.storeKey,
        date: isoDate(existing.date),
        incCents: existing.incCents.toString(),
        ord: existing.ord,
        staffNames: existing.staffNames,
        status: existing.status,
        version: existing.version,
      },
    })
  }
  const base = { incCents: BigInt(cents), ord: orderCount, staffNames: names, updatedBy: req.user.username }
  const saved = await prisma.$transaction(async (tx) => {
    const row = await tx.dailyEntry.upsert({
      where: { storeKey_date: composite },
      update: { ...base, version: { increment: 1 }, updatedAt: new Date() },
      create: { id: `de-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey, date: d, ...base, version: existing ? existing.version + 1 : 1 },
    })
    if (existing && (existing.incCents !== BigInt(cents) || existing.ord !== orderCount || JSON.stringify(existing.staffNames) !== JSON.stringify(names))) {
      await tx.dailyEntryAuditLog.create({
        data: {
          id: `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          storeId: storeKey,
          date: d,
          module: 'sales_manual',
          fieldName: 'incCents_ord_staffNames',
          beforeValue: { incCents: existing.incCents.toString(), ord: existing.ord, staffNames: existing.staffNames },
          afterValue: { incCents: String(cents), ord: orderCount, staffNames: names },
          reason: '人工营业数据保存',
          operatorId: req.user.id,
          operatorName: req.user.username,
        },
      })
    }
    return row
  })
  res.json({
    ok: true,
    row: {
      id: saved.id,
      storeKey: saved.storeKey,
      date: isoDate(saved.date),
      incCents: saved.incCents.toString(),
      ord: saved.ord,
      staffNames: saved.staffNames,
      status: saved.status,
      version: saved.version,
    },
  })
}))

v2Router.delete('/daily-entries', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, date } = req.body || {}
  if (!canStore(req.user, storeKey) || !hasDailyEntryCapability(req.user, DAILY_ENTRY_CAPABILITIES.EDIT)) throw bad('无权限', 403)
  const d = dateOnly(date)
  const existing = await prisma.dailyEntry.findUnique({ where: { storeKey_date: { storeKey, date: d } } })
  if (existing?.status === 'confirmed') throw bad('已确认每日录入是工资与经营历史事实，禁止硬删除', 409)
  const result = await prisma.dailyEntry.deleteMany({ where: { storeKey, date: d, status: 'draft' } })
  res.json({ ok: true, deleted: result.count })
}))

// ---------- 门店调拨 ----------
function transferMasterData(body, category) {
  const name = String(body?.name || '').trim()
  if (!name || name.length > 50) throw bad(`${category === 'product' ? '产品' : '物料'}名称不正确`)
  const sortOrder = Number(body?.sortOrder ?? 0)
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) throw bad('排序必须是 0-999999 的整数')
  const code = category === 'product' ? String(body?.code || '').trim() : ''
  if (category === 'product' && (!code || code.length > 40)) throw bad('产品编号不能为空且不能超过 40 个字符')
  const productCategoryId = category === 'product' ? String(body?.productCategoryId || '').trim() || null : null
  return { name, code: code || null, enabled: body?.enabled !== false, sortOrder, productCategoryId }
}

function serializeTransferMasterItem(item) {
  return {
    id: item.id,
    category: item.category,
    name: item.name,
    sku: item.sku || '',
    code: item.transferCode || '',
    enabled: item.transferEnabled,
    sortOrder: item.transferSortOrder,
    transferBoxEnabled: item.transferBoxEnabled,
    transferBoxWeightGrams: item.transferBoxWeightGrams,
    transferPieceEnabled: item.transferPieceEnabled,
    transferPieceWeightGrams: item.transferPieceWeightGrams,
    productCategoryId: item.productCategoryId || '',
    productCategory: item.productCategory ? {
      id: item.productCategory.id,
      name: item.productCategory.name,
      isActive: item.productCategory.isActive,
      sortOrder: item.productCategory.sortOrder,
    } : null,
    version: item.version,
    used: Boolean(item._count?.transferItems || item._count?.purchaseItems),
  }
}

function requireTransferMasterManager(user) {
  if (!canWrite(user) || !hasModuleAccess(user, MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT)) throw bad('无权限', 403)
}

function requireProductCategoryManager(user) {
  if (!canWrite(user) || !hasModuleAccess(user, MODULE_KEYS.PRODUCT_CENTER)) throw bad('无权限', 403)
}

function serializeProductCategory(category) {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    version: category.version,
    productCount: Number(category._count?.products || 0),
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  }
}

function productCategoryData(body) {
  const name = String(body?.name || '').trim()
  const sortOrder = Number(body?.sortOrder ?? 0)
  if (!name || name.length > 30) throw bad('分类名称不能为空且不能超过 30 个字符')
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) throw bad('排序必须是 0-999999 的整数')
  return { name, sortOrder, isActive: body?.isActive !== false }
}

async function requireAssignableProductCategory(productCategoryId, currentCategoryId = '') {
  if (!productCategoryId) return null
  const category = await prisma.productCategory.findUnique({ where: { id: productCategoryId } })
  if (!category) throw bad('产品分类不存在', 404)
  if (!category.isActive && category.id !== currentCategoryId) throw bad('已停用分类不能接收产品', 409)
  return category
}

v2Router.get('/product-categories', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined
  const rows = await prisma.productCategory.findMany({
    where: active === undefined ? {} : { isActive: active },
    include: { _count: { select: { products: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 500,
  })
  res.json({ rows: rows.map(serializeProductCategory) })
}))

v2Router.post('/product-categories', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  requireProductCategoryManager(req.user)
  const data = productCategoryData(req.body)
  const duplicate = await prisma.productCategory.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })
  if (duplicate) throw bad('分类名称已存在', 409)
  const category = await prisma.productCategory.create({
    data: { id: uid('pc'), ...data },
    include: { _count: { select: { products: true } } },
  })
  res.status(201).json({ ok: true, category: serializeProductCategory(category) })
}))

v2Router.put('/product-categories/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  requireProductCategoryManager(req.user)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw bad('分类版本不正确，请刷新后重试')
  const data = productCategoryData(req.body)
  const duplicate = await prisma.productCategory.findFirst({
    where: { id: { not: req.params.id }, name: { equals: data.name, mode: 'insensitive' } },
  })
  if (duplicate) throw bad('分类名称已存在', 409)
  const updated = await prisma.productCategory.updateMany({
    where: { id: req.params.id, version },
    data: { ...data, version: { increment: 1 } },
  })
  if (updated.count !== 1) throw bad('分类已被其他人修改，请刷新后重试', 409)
  const category = await prisma.productCategory.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { products: true } } },
  })
  res.json({ ok: true, category: serializeProductCategory(category) })
}))

v2Router.get('/transfer-master-items', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const category = String(req.query.category || '').trim()
  if (category && !['product', 'material'].includes(category)) throw bad('货品类型不正确')
  const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined
  const rows = await prisma.inventoryItem.findMany({
    where: {
      category: category || { in: ['product', 'material'] },
      ...(active === undefined ? {} : { transferEnabled: active }),
    },
    include: { productCategory: true, _count: { select: { transferItems: true, purchaseItems: true } } },
    orderBy: [{ category: 'asc' }, { transferSortOrder: 'asc' }, { name: 'asc' }],
    take: 1000,
  })
  res.json({ rows: rows.map(serializeTransferMasterItem) })
}))

v2Router.post('/transfer-master-items', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const category = String(req.body?.category || '').trim()
  if (!['product', 'material'].includes(category)) throw bad('货品类型不正确')
  if (category === 'product') requireProductCategoryManager(req.user)
  else requireTransferMasterManager(req.user)
  const data = transferMasterData(req.body, category)
  await requireAssignableProductCategory(data.productCategoryId)
  const duplicate = await prisma.inventoryItem.findFirst({
    where: { OR: [
      { name: data.name },
      ...(data.code ? [{ transferCode: data.code }] : []),
    ] },
  })
  if (duplicate) throw bad(duplicate.name === data.name ? '名称已存在，请编辑现有资料' : '产品编号已存在', 409)
  const row = await prisma.inventoryItem.create({
    data: {
      id: uid('it'),
      name: data.name,
      category,
      transferCode: data.code,
      transferEnabled: data.enabled,
      transferSortOrder: data.sortOrder,
      productCategoryId: data.productCategoryId,
    },
    include: { productCategory: true, _count: { select: { transferItems: true, purchaseItems: true } } },
  })
  res.status(201).json({ ok: true, item: serializeTransferMasterItem(row) })
}))

v2Router.put('/transfer-master-items/bulk-category', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  requireProductCategoryManager(req.user)
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (!ids.length || ids.length > 500) throw bad('请选择 1-500 个产品')
  const productCategoryId = String(req.body?.productCategoryId || '').trim() || null
  await requireAssignableProductCategory(productCategoryId)
  const products = await prisma.inventoryItem.findMany({ where: { id: { in: ids }, category: 'product' }, select: { id: true } })
  if (products.length !== ids.length) throw bad('批量归类中包含不存在或非产品资料', 409)
  await prisma.inventoryItem.updateMany({
    where: { id: { in: ids }, category: 'product' },
    data: { productCategoryId, version: { increment: 1 } },
  })
  res.json({ ok: true, updated: ids.length })
}))

v2Router.put('/transfer-master-items/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } })
  if (!existing || !['product', 'material'].includes(existing.category)) throw bad('产品或物料不存在', 404)
  if (existing.category === 'product') requireProductCategoryManager(req.user)
  else requireTransferMasterManager(req.user)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw bad('资料版本不正确，请刷新后重试')
  const data = transferMasterData(req.body, existing.category)
  await requireAssignableProductCategory(data.productCategoryId, existing.productCategoryId || '')
  const duplicate = await prisma.inventoryItem.findFirst({
    where: {
      id: { not: existing.id },
      OR: [
        { name: data.name },
        ...(data.code ? [{ transferCode: data.code }] : []),
      ],
    },
  })
  if (duplicate) throw bad(duplicate.name === data.name ? '名称已存在' : '产品编号已存在', 409)

  const row = await prisma.$transaction(async (tx) => {
    if (existing.name !== data.name) {
      await tx.transferItem.updateMany({ where: { itemId: existing.id, itemNameSnapshot: '' }, data: { itemNameSnapshot: existing.name } })
      await tx.purchaseItem.updateMany({ where: { itemId: existing.id, itemNameSnapshot: '' }, data: { itemNameSnapshot: existing.name } })
    }
    const updated = await tx.inventoryItem.updateMany({
      where: { id: existing.id, version },
      data: {
        name: data.name,
        transferCode: data.code,
        transferEnabled: data.enabled,
        transferSortOrder: data.sortOrder,
        productCategoryId: data.productCategoryId,
        version: { increment: 1 },
      },
    })
    if (updated.count !== 1) throw bad('资料已被其他人修改，请刷新后重试', 409)
    return tx.inventoryItem.findUnique({
      where: { id: existing.id },
      include: { productCategory: true, _count: { select: { transferItems: true, purchaseItems: true } } },
    })
  })
  res.json({ ok: true, item: serializeTransferMasterItem(row) })
}))

v2Router.post('/transfer-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { items, note } = req.body || {}
  const fromStoreKey = String((req.body || {}).fromStoreKey || '').trim()
  const toStoreKey = String((req.body || {}).toStoreKey || (req.body || {}).storeKey || '').trim()
  if (req.user?.role === 'public') throw bad('无权限', 403)
  if (!isFixedStoreKey(fromStoreKey)) throw bad('请选择调出门店')
  if (!isFixedStoreKey(toStoreKey)) throw bad('请选择调入门店')
  if (fromStoreKey === toStoreKey) throw bad('调出门店不能与调入门店相同')
  if (!hasInventoryTransferAll(req.user) && !canAccessTransferStore(req.user, toStoreKey)) throw bad('无权为所选调入门店创建调拨', 403)
  const rows = itemRows(items)
  await ensureStore(fromStoreKey)
  await ensureStore(toStoreKey)
  const createItems = []
  for (const row of rows) {
    const item = await findActiveTransferItem(row)
    for (const data of transferItemCreates(row, item)) {
      createItems.push({ id: uid('ti'), ...data })
    }
  }
  const created = await prisma.transferRequest.create({
    data: {
      id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fromStoreKey,
      toStoreKey,
      fromLocationName: '',
      toLocationName: '',
      note: String(note || '').trim().slice(0, 200),
      createdBy: req.user.username,
      items: {
        create: createItems,
      },
    },
    include: { items: { include: { item: true } }, fromStore: true, toStore: true },
  })
  const serialized = serializeTransfer(created)
  const notificationResult = await deliverTransferRequestNotification({ transfer: serialized }).catch((error) => ({
    ok: false,
    status: 'failed',
    reason: String(error?.message || 'transfer notification failed').slice(0, 200),
  }))
  if (!notificationResult.ok) {
    console.error('[transfer-notification]', created.id, notificationResult.status, notificationResult.reason || '')
  }
  res.json({ ok: true, request: serialized })
}))

v2Router.get('/transfer-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user?.role === 'public') throw bad('无权限', 403)
  const sf = hasInventoryTransferAll(req.user) ? null : storeFilter(req.user)
  const where = { deletedAt: null }
  if (sf) where.OR = [{ fromStoreKey: sf }, { toStoreKey: sf }, { createdBy: req.user.username }]
  if (req.query.status) where.status = String(req.query.status)
  const rows = await prisma.transferRequest.findMany({
    where,
    include: { items: { include: { item: true } }, fromStore: true, toStore: true },
    orderBy: { createdAt: 'desc' },
  })
  const deliveryByTransfer = await loadTransferDeliverySummaries(prisma, rows.map((row) => row.id))
  res.json({
    rows: rows.map((row) => ({
      ...serializeTransfer(row),
      deliveryRecipients: deliveryByTransfer.get(row.id) || EMPTY_TRANSFER_DELIVERY_SUMMARY,
    })),
  })
}))

v2Router.delete('/transfer-requests/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await prisma.transferRequest.findUnique({ where: { id: req.params.id } })
  if (!t) throw bad('调拨不存在', 404)
  if (t.deletedAt) throw bad('已删除调拨不可继续操作', 409)
  const transferAdmin = hasInventoryTransferAll(req.user)
  if (!transferAdmin && t.createdBy !== req.user.username) throw bad('无权限', 403)
  if (t.status !== 'pending') throw bad('仅待备货调拨可撤回')
  const updated = await prisma.transferRequest.update({
    where: { id: t.id },
    data: { status: 'canceled', withdrawnBy: req.user.username, withdrawnAt: new Date(), updatedAt: new Date() },
    include: { items: { include: { item: true } }, fromStore: true, toStore: true },
  })
  res.json({ ok: true, request: serializeTransfer(updated) })
}))

async function getTransfer(id) {
  return prisma.transferRequest.findFirst({
    where: { id, deletedAt: null },
    include: { items: { include: { item: true } }, fromStore: true, toStore: true },
  })
}

v2Router.post('/transfer-requests/:id/ship', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await getTransfer(req.params.id)
  if (!t) throw bad('调拨不存在', 404)
  if (!canManageTransferStore(req.user, t.fromStoreKey)) throw bad('无权限', 403)
  if (t.status !== 'pending') throw bad('当前状态不可发货')
  const shipmentUpdates = transferShipmentUpdates(req.body?.items, t.items)
  const shippedAt = new Date()
  const final = await prisma.$transaction(async (tx) => {
    const claimed = await tx.transferRequest.updateMany({
      where: { id: t.id, status: 'pending', deletedAt: null },
      data: { status: 'shipped', shippedBy: req.user.username, shippedAt, updatedAt: shippedAt },
    })
    if (claimed.count !== 1) throw bad('当前状态不可发货', 409)
    for (const update of shipmentUpdates) {
      const saved = await tx.transferItem.updateMany({
        where: { id: update.id, requestId: t.id, shippedQuantity: null },
        data: { shippedQuantity: update.shippedQuantity },
      })
      if (saved.count !== 1) throw bad('实际发货数量已被记录，请刷新后重试', 409)
    }
    return tx.transferRequest.findUnique({
      where: { id: t.id },
      include: { items: { include: { item: true } }, fromStore: true, toStore: true },
    })
  })
  const serialized = serializeTransfer(final)
  await notify({
    username: t.createdBy,
    templateKey: 'transfer_shipped',
    data: { fromStore: resolveStoreName(t.fromStoreKey), toStore: resolveStoreName(t.toStoreKey), count: serialized.items.length, operator: req.user.username },
    title: `调拨已发货：${resolveStoreName(t.fromStoreKey)} → ${resolveStoreName(t.toStoreKey)}`,
    content: `${serialized.items.length} 种货品 · 发货人 ${req.user.username}`,
    target: 'inventory-transfer',
    refType: 'transfer',
    refId: t.id,
  })
  res.json({ ok: true, request: serialized })
}))

v2Router.post('/transfer-requests/:id/reject', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await getTransfer(req.params.id)
  if (!t) throw bad('申请不存在', 404)
  if (!canManageTransferStore(req.user, t.fromStoreKey)) throw bad('无权限', 403)
  if (t.status !== 'pending') throw bad('当前状态不可驳回')
  const updated = await prisma.transferRequest.update({
    where: { id: t.id },
    data: { status: 'rejected', updatedAt: new Date() },
    include: { items: { include: { item: true } }, fromStore: true, toStore: true },
  })
  res.json({ ok: true, request: serializeTransfer(updated) })
}))

v2Router.post('/transfer-requests/:id/receive', wrap(async (req, res) => {
  throw bad('门店调拨 2.0 不需要确认收货', 410)
}))

// ---------- 采购 ----------
v2Router.post('/purchase-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, items, supplier, supplierId, expectedAt, note } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  const rows = itemRows(items)
  if (supplierId) {
    const s = await prisma.supplier.findUnique({ where: { id: supplierId } })
    if (!s) throw bad('供应商不存在')
  }
  await ensureStore(storeKey)
  const created = await prisma.purchaseRequest.create({
    data: {
      id: `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      storeKey,
      supplier: String(supplier || '').trim().slice(0, 50),
      supplierId: supplierId || null,
      expectedAt: expectedAt ? new Date(expectedAt) : null,
      note: String(note || '').trim().slice(0, 200),
      createdBy: req.user.username,
      items: {
        create: await Promise.all(
          rows.map(async (row) => {
            const item = await upsertItem(row.name, row.category)
            return { id: `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, itemId: item.id, orderedQty: row.quantity, note: row.note, itemNameSnapshot: item.name }
          }),
        ),
      },
    },
    include: { items: { include: { item: true } }, store: true, supplierRef: true },
  })
  broadcast(
    '新采购申请',
    `门店 **${created.storeKey}**\n货品 **${created.items.length}** 种${created.supplierRef?.name || created.supplier ? ` · 供应商 **${created.supplierRef?.name || created.supplier}**` : ''}\n提交人 **${req.user.username}**\n请尽快安排采购收货。`,
  ).catch(() => {})
  res.json({ ok: true, request: serializePurchase(created) })
}))

v2Router.get('/purchase-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const sf = storeFilter(req.user)
  const where = { deletedAt: null, ...(sf ? { storeKey: sf } : {}) }
  if (req.query.status) where.status = String(req.query.status)
  const rows = await prisma.purchaseRequest.findMany({
    where,
    include: { items: { include: { item: true } }, store: true, supplierRef: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({ rows: rows.map(serializePurchase) })
}))

v2Router.delete('/purchase-requests/:id', wrap(async (req, res) => {
  throw bad('该删除入口已停用，请由开发者通过安全删除操作', 410)
}))

v2Router.post('/purchase-requests/:id/receive', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const p = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { items: { include: { item: true } } } })
  if (!p) throw bad('申请不存在', 404)
  if (p.deletedAt) throw bad('已删除采购申请不可继续操作', 409)
  if (!isManager(req.user) || !canStore(req.user, p.storeKey)) throw bad('无权限', 403)
  if (p.status === 'received') throw bad('该采购单已入库', 409)
  if (p.status !== 'pending') throw bad('采购单状态异常，无法收货', 409)
  const received = (req.body && req.body.items) || []
  const receivedMap = new Map(received.map((r) => [String(r.itemId || r.id || ''), Number(r.receivedQty)]))
  const operator = req.user.username
  try {
    await prisma.$transaction(async (tx) => {
      // The conditional state transition is the idempotency claim. It is part
      // of the same transaction, so a later stock or ledger failure restores
      // the purchase to pending and permits an intentional retry.
      const claimed = await tx.purchaseRequest.updateMany({
        where: { id: p.id, status: 'pending', deletedAt: null },
        data: { status: 'received', updatedAt: new Date() },
      })
      if (claimed.count !== 1) throw bad('该采购单已入库或状态已变化', 409)

      for (const row of p.items) {
        const qty = Number.isInteger(receivedMap.get(row.itemId)) ? receivedMap.get(row.itemId) : row.orderedQty
        if (qty < 0 || qty > 999999) throw bad('实收数量不正确')
        const balance = await tx.stockBalance.upsert({
          where: { storeKey_itemId: { storeKey: p.storeKey, itemId: row.itemId } },
          update: { quantity: { increment: qty }, updatedAt: new Date() },
          create: { id: uid('sb'), storeKey: p.storeKey, itemId: row.itemId, quantity: qty },
        })
        await tx.stockLedger.create({
          data: {
            id: uid('sl'),
            storeKey: p.storeKey,
            itemId: row.itemId,
            change: qty,
            balance: balance.quantity,
            type: 'purchase_in',
            refId: p.id,
            operator,
          },
        })
        await tx.purchaseItem.update({ where: { id: row.id }, data: { receivedQty: qty } })
      }
    })
  } catch (error) {
    if (error?.status && error.status < 500) throw error
    throw internalFailure('收货入库失败，库存未发生变化，请稍后重试。', error)
  }
  maybeAlertLowStock(p.storeKey).catch(() => {})
  broadcast(
    '采购已入库',
    `门店 **${p.storeKey}**\n货品 **${p.items.length}** 种已按实收数量入库 · 操作人 **${operator}**`,
  ).catch(() => {})
  res.json({ ok: true })
}))

// ---------- 库存与流水 ----------
v2Router.get('/stock', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const rows = await prisma.stockBalance.findMany({
    where: { storeKey: whereStores(req.user, store || undefined) },
    include: { item: true },
    orderBy: { item: { name: 'asc' } },
  })
  res.json({ rows: rows.map((r) => ({ storeKey: r.storeKey, itemId: r.itemId, name: r.item.name, unit: r.item.unit, quantity: r.quantity, minQty: r.minQty, updatedAt: r.updatedAt })) })
}))

v2Router.post('/stock/adjust', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, items } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  if (!isManager(req.user)) throw bad('仅店长/开发者可调整库存', 403)
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) throw bad('货品明细不正确')
  await ensureStore(storeKey)
  const operator = req.user.username
  await prisma.$transaction(async (tx) => {
    for (const it of items) {
      const quantity = Number(it.quantity)
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99999999) throw bad('盘点数量应为非负整数')
      const nextMin = it.minQty === undefined || it.minQty === null || it.minQty === ''
        ? undefined
        : Math.max(0, Math.min(999999, Number(it.minQty) || 0))
      const item = it.itemId
        ? await tx.inventoryItem.findUnique({ where: { id: it.itemId } })
        : await tx.inventoryItem.upsert({
            where: { name: String(it.name || '').trim() },
            update: {},
            create: { id: `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: String(it.name || '').trim() },
          })
      if (!item) throw bad('货品不存在')
      const bal = await tx.stockBalance.findUnique({ where: { storeKey_itemId: { storeKey, itemId: item.id } } })
      const cur = bal ? bal.quantity : 0
      await tx.stockBalance.upsert({
        where: { storeKey_itemId: { storeKey, itemId: item.id } },
        update: { quantity, ...(nextMin !== undefined ? { minQty: nextMin } : {}), updatedAt: new Date() },
        create: { id: `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey, itemId: item.id, quantity, minQty: nextMin ?? 0 },
      })
      await tx.stockLedger.create({
        id: `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        storeKey,
        itemId: item.id,
        change: quantity - cur,
        balance: quantity,
        type: 'adjust',
        refId: 'manual',
        operator,
      })
    }
  })
  maybeAlertLowStock(storeKey).catch(() => {})
  res.json({ ok: true })
}))

v2Router.get('/stock/ledger', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const where = { storeKey: whereStores(req.user, store || undefined) }
  if (req.query.type) where.type = String(req.query.type)
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : null
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : null
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
  const rows = await prisma.stockLedger.findMany({
    where,
    include: { item: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      storeKey: r.storeKey,
      itemId: r.itemId,
      name: r.item.name,
      change: r.change,
      balance: r.balance,
      type: r.type,
      refId: r.refId,
      note: r.note,
      operator: r.operator,
      createdAt: r.createdAt,
    })),
  })
}))

// ---------- M3-1：货品档案 / 供应商 / 报损 / 缺货预警 ----------
v2Router.get('/items', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  // 开发者访问时自动为固定选项建档（幂等）
  if (canWrite(req.user)) {
    for (const name of FIXED_OPTION_NAMES) {
      await prisma.inventoryItem.upsert({
        where: { name },
        update: {},
        create: { id: uid('it'), name },
      })
    }
  }
  const q = String(req.query.q || '').trim()
  const rows = await prisma.inventoryItem.findMany({
    where: q ? { name: { contains: q, mode: 'insensitive' } } : undefined,
    orderBy: { name: 'asc' },
    take: 500,
  })
  res.json({ rows: rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, spec: r.spec, barcode: r.barcode, category: r.category, image: r.image || '' })) })
}))

v2Router.post('/items', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { name, unit, spec, barcode, category, image } = req.body || {}
  const n = String(name || '').trim()
  if (!n || n.length > 50) throw bad('货品名称不正确')
  const exists = await prisma.inventoryItem.findUnique({ where: { name: n } })
  if (exists) throw bad('货品已存在', 409)
  const row = await prisma.inventoryItem.create({
    data: {
      id: uid('it'),
      name: n,
      unit: String(unit || '').trim().slice(0, 20),
      spec: String(spec || '').trim().slice(0, 50),
      barcode: String(barcode || '').trim().slice(0, 50),
      category: ['product', 'material', 'other'].includes(category) ? category : 'product',
      image: String(image || '').slice(0, 600000),
    },
  })
  res.json({ ok: true, item: row })
}))

v2Router.put('/items/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { name, unit, spec, barcode, category, image } = req.body || {}
  const n = String(name || '').trim()
  if (!n || n.length > 50) throw bad('货品名称不正确')
  const dup = await prisma.inventoryItem.findFirst({ where: { name: n, id: { not: req.params.id } } })
  if (dup) throw bad('货品名称已存在', 409)
  const row = await prisma.inventoryItem.update({
    where: { id: req.params.id },
    data: {
      name: n,
      unit: String(unit || '').trim().slice(0, 20),
      spec: String(spec || '').trim().slice(0, 50),
      barcode: String(barcode || '').trim().slice(0, 50),
      category: ['product', 'material', 'other'].includes(category) ? category : 'product',
      image: String(image || '').slice(0, 600000),
    },
  })
  res.json({ ok: true, item: row })
}))

v2Router.get('/suppliers', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const rows = await prisma.supplier.findMany({ orderBy: { name: 'asc' }, take: 500 })
  res.json({ rows })
}))

v2Router.post('/suppliers', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { name, phone, contact, note } = req.body || {}
  const n = String(name || '').trim()
  if (!n || n.length > 50) throw bad('供应商名称不正确')
  const exists = await prisma.supplier.findUnique({ where: { name: n } })
  if (exists) throw bad('供应商已存在', 409)
  const row = await prisma.supplier.create({
    data: {
      id: uid('sp'),
      name: n,
      phone: String(phone || '').trim().slice(0, 30),
      contact: String(contact || '').trim().slice(0, 30),
      note: String(note || '').trim().slice(0, 200),
    },
  })
  res.json({ ok: true, supplier: row })
}))

v2Router.put('/suppliers/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { name, phone, contact, note } = req.body || {}
  const n = String(name || '').trim()
  if (!n || n.length > 50) throw bad('供应商名称不正确')
  const row = await prisma.supplier.update({
    where: { id: req.params.id },
    data: {
      name: n,
      phone: String(phone || '').trim().slice(0, 30),
      contact: String(contact || '').trim().slice(0, 30),
      note: String(note || '').trim().slice(0, 200),
    },
  })
  res.json({ ok: true, supplier: row })
}))

v2Router.post('/stock/waste', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, items } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  if (!isManager(req.user)) throw bad('仅店长/开发者可报损', 403)
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) throw bad('货品明细不正确')
  await ensureStore(storeKey)
  const operator = req.user.username
  const records = []
  await prisma.$transaction(async (tx) => {
    for (const it of items) {
      const quantity = Number(it.quantity)
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999999) throw bad('报损数量应为正整数')
      const reason = String(it.reason || '').trim().slice(0, 100)
      const item = it.itemId
        ? await tx.inventoryItem.findUnique({ where: { id: it.itemId } })
        : await tx.inventoryItem.upsert({
            where: { name: String(it.name || '').trim() },
            update: {},
            create: { id: uid('it'), name: String(it.name || '').trim() },
          })
      if (!item) throw bad('货品不存在')
      const bal = await tx.stockBalance.findUnique({ where: { storeKey_itemId: { storeKey, itemId: item.id } } })
      const cur = bal ? bal.quantity : 0
      if (cur < quantity) {
        const e = new Error(`「${item.name}」库存不足（当前 ${cur}）`)
        e.status = 400
        throw e
      }
      await tx.stockBalance.update({
        where: { storeKey_itemId: { storeKey, itemId: item.id } },
        data: { quantity: cur - quantity, updatedAt: new Date() },
      })
      await tx.stockLedger.create({ id: uid('sl'), storeKey, itemId: item.id, change: -quantity, balance: cur - quantity, type: 'waste', refId: `waste-${Date.now().toString(36)}`, operator })
      const wr = await tx.wasteRecord.create({ data: { id: uid('wr'), storeKey, itemId: item.id, quantity, reason, operator } })
      records.push({ id: wr.id, storeKey, itemId: item.id, name: item.name, quantity, reason, operator })
    }
  })
  maybeAlertLowStock(storeKey).catch(() => {})
  res.json({ ok: true, records })
}))

v2Router.get('/stock/alerts', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const rows = await prisma.stockBalance.findMany({
    where: { storeKey: whereStores(req.user, store || undefined), minQty: { gt: 0 } },
    include: { item: true },
    orderBy: { storeKey: 'asc' },
  })
  res.json({
    rows: rows.filter((r) => r.quantity <= r.minQty).map((r) => ({
      storeKey: r.storeKey,
      itemId: r.itemId,
      name: r.item.name,
      quantity: r.quantity,
      minQty: r.minQty,
    })),
  })
}))

v2Router.get('/waste-records', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const rows = await prisma.wasteRecord.findMany({
    where: { storeKey: whereStores(req.user, store || undefined) },
    include: { item: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  res.json({ rows: rows.map((r) => ({ id: r.id, storeKey: r.storeKey, itemId: r.itemId, name: r.item.name, quantity: r.quantity, reason: r.reason, operator: r.operator, createdAt: r.createdAt })) })
}))

// Data Authority DA-2.3：门店目录权威 = PostgreSQL（KV stores / 静态 BASE_STORES 为种子/镜像）
v2Router.get('/stores', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user.role === 'public' || req.user.role === 'cashier') throw bad('无权限', 403)
  const rows = await prisma.store.findMany({ where: { active: true, key: { in: FIXED_STORE_KEYS } }, orderBy: [{ key: 'asc' }] })
  res.json({ ok: true, rows: rows.map((r) => ({ key: r.key, name: r.name, district: r.district || '' })) })
}))

/** 门店目录固定为四店，不接受运行时创建。 */
v2Router.post('/stores', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('仅开发者可管理门店', 403)
  throw bad('门店目录固定为通盈、官舍、朝外、西单，禁止新增', 403)
}))

/** 固定门店不可通过业务 API 删除。 */
v2Router.delete('/stores/:key', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('仅开发者可管理门店', 403)
  throw bad('固定门店不可删除', 403)
}))

// 员工名单镜像：KV 员工（人员管理）→ PostgreSQL Staff 表（开发者/店长可写）
v2Router.put('/staff', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const list = Array.isArray(req.body && req.body.staff) ? req.body.staff : []
  if (list.length > 2000) throw bad('员工数量过多')
  const allowed = isSuperUser(req.user) ? null : req.user.storeKeys || []
  await prisma.$transaction(async (tx) => {
    await tx.staff.deleteMany({ where: allowed ? { storeKey: { in: allowed } } : {} })
    for (const s of list) {
      const name = String(s.name || '').trim()
      const storeKey = String(s.storeKey || '').trim()
      if (!name || name.length > 30 || !storeKey || storeKey.length > 30) throw bad('员工数据不正确')
      if (!isFixedStoreKey(storeKey)) throw bad('员工所属门店不在固定门店目录')
      if (allowed && !allowed.includes(storeKey)) throw bad('无权限', 403)
      await tx.store.upsert({
        where: { key: storeKey },
        update: { name: resolveStoreName(storeKey), active: true },
        create: { key: storeKey, name: resolveStoreName(storeKey), active: true },
      })
      // id 必须唯一：中文名用 codepoint 编码（与前端 StoreEntryPage.staffIdFor 同规则），
      // 避免同门店同字数员工（如 叶芷辰/李飞燕）替换成下划线后互相覆盖
      const encoded = [...String(name)].map((ch) => ch.codePointAt(0).toString(36)).join('')
      const id = `st-${storeKey}-${encoded.slice(0, 64)}`
      await tx.staff.upsert({
        where: { id },
        update: { name, type: s.type || 'fulltime', salary: Number(s.salary) || 0 },
        create: { id, name, type: s.type || 'fulltime', storeKey, salary: Number(s.salary) || 0 },
      })
    }
  })
  res.json({ ok: true, count: list.length })
}))

// ---------- M3-2：企微告警测试 ----------
v2Router.get('/alerts/status', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('无权限', 403)
  // 仅投影是否配置，绝不返回 webhook、环境变量名或任何凭据。
  res.json({ ok: true, configured: Boolean(wecomWebhookUrl()) })
}))

v2Router.post('/alerts/test', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('无权限', 403)
  const ok = await sendWechatMarkdown('BUDU 告警测试', '这是一条测试消息，企微告警通道正常 ✅')
  res.json({ ok, configured: Boolean(wecomWebhookUrl()) })
}))

let weatherCache = { at: 0, data: null }

v2Router.get('/weather', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const now = Date.now()
  if (weatherCache.data && now - weatherCache.at < 30 * 60 * 1000) {
    return res.json(weatherCache.data)
  }
  const city = process.env.WEATHER_CITY || '北京'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, {
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json()
    const c = j.current_condition && j.current_condition[0]
    if (!c) throw new Error('no weather data')
    const data = {
      ok: true,
      city,
      temp: c.temp_C,
      text:
        (c.lang_zh && c.lang_zh[0] && c.lang_zh[0].value) ||
        (c.weatherDesc && c.weatherDesc[0] && c.weatherDesc[0].value) ||
        '',
      humidity: c.humidity,
      wind: c.windspeedKmph,
      updatedAt: new Date().toISOString(),
    }
    weatherCache = { at: now, data }
    res.json(data)
  } catch (e) {
    res.json({ ok: false, error: '天气服务暂不可用' })
  }
}))

v2Router.get('/changelog', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  res.json({ rows: CHANGELOG.slice(0, 5) })
}))

// ---------- M3-3：财务（费用/利润/导出） ----------
v2Router.get('/expenses', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const month = String(req.query.month || '')
  const where = { storeKey: whereStores(req.user, store || undefined) }
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    where.date = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) }
  }
  const rows = await prisma.expense.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000 })
  res.json({ rows: rows.map((r) => ({ id: r.id, storeKey: r.storeKey, date: isoDate(r.date), category: r.category, amountCents: r.amountCents.toString(), note: r.note, createdBy: r.createdBy })) })
}))

v2Router.post('/expenses', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { storeKey, date, category, amountCents, note } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  const cents = Number(amountCents)
  if (!Number.isInteger(cents) || cents < 0 || cents > 999999999999) throw bad('金额不正确（单位：分）')
  await ensureStore(storeKey)
  const row = await prisma.expense.create({
    data: {
      id: uid('ex'),
      storeKey,
      date: dateOnly(date),
      category: String(category || '其他').trim().slice(0, 20),
      amountCents: BigInt(cents),
      note: String(note || '').trim().slice(0, 200),
      createdBy: req.user.username,
    },
  })
  res.json({ ok: true, expense: { id: row.id, storeKey: row.storeKey, date: isoDate(row.date), category: row.category, amountCents: row.amountCents.toString(), note: row.note, createdBy: row.createdBy } })
}))

v2Router.delete('/expenses/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const row = await prisma.expense.findUnique({ where: { id: req.params.id } })
  if (!row) throw bad('费用不存在', 404)
  if (!isSuperUser(req.user) && row.createdBy !== req.user.username) throw bad('无权限', 403)
  await prisma.expense.delete({ where: { id: row.id } })
  res.json({ ok: true })
}))

v2Router.get('/profit', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  res.json(await computeProfit(req.user, String(req.query.month || ''), String(req.query.store || '')))
}))

v2Router.get('/export/profit', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const data = await computeProfit(req.user, String(req.query.month || ''), String(req.query.store || ''))
  const header = '门店,日期,营业收入(元),费用(元),利润(元)'
  const lines = (data.rows || []).map((r) => `${r.storeKey},${r.date},${(Number(r.incCents) / 100).toFixed(2)},${(Number(r.expenseCents) / 100).toFixed(2)},${(Number(r.profitCents) / 100).toFixed(2)}`)
  const csv = `\uFEFF${[header, ...lines].join('\n')}`
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="profit-${data.month || 'all'}.csv"`)
  res.send(csv)
}))

// ---------- 发票开具 ----------
v2Router.get('/invoices/companies', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const q = String(req.query.q || '').trim()
  const rows = await prisma.invoiceCompany.findMany({
    where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
    orderBy: { updatedAt: 'desc' },
    take: 50,
  })
  res.json({ rows: rows.map((r) => ({ id: r.id, name: r.name, taxNo: r.taxNo })) })
}))

v2Router.get('/invoices/ocr-status', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  res.json({ ok: true, configured: ocrConfigured() })
}))

v2Router.post('/invoices/ocr', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const { imageBase64 } = req.body || {}
  const result = await extractInvoiceFromBase64(String(imageBase64 || ''))
  res.json({ ok: true, extracted: result.extracted })
}))

/** 通用图片文字识别（门店邮寄等场景）：返回纯文本，前端再做智能拆分 */
v2Router.post('/ocr/general', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!req.user || req.user.role === 'cashier' || req.user.role === 'public') throw bad('无权限', 403)
  const { imageBase64 } = req.body || {}
  const correlation = correlateOcrRequest(req.body)
  const result = await generalOcrText(String(imageBase64 || ''))
  res.json({ ok: true, text: result.text, ...correlation })
}))

v2Router.delete('/invoices/companies/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('无权限', 403)
  await prisma.invoiceCompany.delete({ where: { id: req.params.id } }).catch(() => {})
  res.json({ ok: true })
}))

v2Router.get('/invoices', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const month = String(req.query.month || '')
  const status = String(req.query.status || '')
  const date = String(req.query.date || '')
  const where = { storeKey: whereStores(req.user, store || undefined), deletedAt: null }
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    where.createdAt = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = new Date(`${date}T00:00:00.000Z`)
    where.createdAt = { gte: d, lt: new Date(d.getTime() + 86400000) }
  }
  if (status === 'pending' || status === 'done') where.status = status
  const rows = await prisma.invoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: 1000 })
  res.json({ rows: rows.map(serializeInvoice) })
}))

v2Router.post('/invoices', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const { storeKey, titleType, companyName, taxNo, amountCents, category, email, note } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  const type = titleType === 'personal' ? 'personal' : 'company'
  const name = type === 'company' ? String(companyName || '').trim() : ''
  const no = type === 'company' ? String(taxNo || '').trim().slice(0, 50) : ''
  if (type === 'company') {
    if (!name || name.length > 100) throw bad('请填写公司名称')
    // 学习公司税号字典，下次输入公司名自动匹配
    await prisma.invoiceCompany.upsert({
      where: { name },
      update: { taxNo: no || undefined, updatedAt: new Date() },
      create: { id: uid('ic'), name, taxNo: no },
    })
  }
  const cents = Number(amountCents)
  if (!Number.isInteger(cents) || cents <= 0 || cents > 999999999999) throw bad('金额不正确（单位：分）')
  const mail = String(email || '').trim().slice(0, 120)
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw bad('邮箱格式不正确')
  await ensureStore(storeKey)
  const row = await prisma.invoice.create({
    data: {
      id: uid('inv'),
      storeKey,
      titleType: type,
      companyName: name,
      taxNo: no,
      amountCents: BigInt(cents),
      category: String(category || '其他').trim().slice(0, 30),
      email: mail,
      note: String(note || '').trim().slice(0, 200),
      status: 'pending',
      createdBy: req.user.username,
    },
  })
  broadcast(
    '新发票申请',
    `门店 **${storeKey}**\n抬头 **${type === 'company' ? name : '个人'}**\n金额 **¥${(cents / 100).toFixed(2)}** · 品类 **${String(category || '其他').trim()}**\n提交人 **${req.user.username}**\n请尽快开票。`,
  ).catch(() => {})
  res.json({ ok: true, invoice: serializeInvoice(row) })
}))

v2Router.post('/invoices/:id/status', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const status = String((req.body || {}).status || '')
  if (status !== 'pending' && status !== 'done') throw bad('状态不正确')
  const row = await prisma.invoice.findUnique({ where: { id: req.params.id } })
  if (!row) throw bad('发票记录不存在', 404)
  if (row.deletedAt) throw bad('已删除发票不可继续操作', 409)
  if (!canStore(req.user, row.storeKey)) throw bad('无权限', 403)
  const updated = await prisma.invoice.update({ where: { id: row.id }, data: { status } })
  res.json({ ok: true, invoice: serializeInvoice(updated) })
}))

v2Router.delete('/invoices/:id', wrap(async (req, res) => {
  throw bad('该删除入口已停用，请由开发者通过安全删除操作', 410)
}))

// ---------- 门店邮寄发件记录 ----------
v2Router.get('/mailing-records', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canMailing(req.user)) throw bad('无权限', 403)
  const status = String(req.query.status || '')
  const from = String(req.query.from || '')
  const to = String(req.query.to || '')
  const where = { deletedAt: null }
  if (status === 'pending' || status === 'shipped') where.status = status
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) || /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.createdAt = {}
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) where.createdAt.gte = new Date(`${from}T00:00:00.000Z`)
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) where.createdAt.lt = new Date(`${to}T00:00:00.000Z`)
    if (where.createdAt.lt) where.createdAt.lt = new Date(where.createdAt.lt.getTime() + 86400000)
  }
  const rows = await prisma.mailingRecord.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2000 })
  res.json({ rows: rows.map(serializeMailingRecord) })
}))

v2Router.post('/mailing-records', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canMailing(req.user)) throw bad('无权限', 403)
  const { method, postage, fee, address, recipient, phone, remark } = req.body || {}
  const m = String(method || '').trim()
  const p = String(postage || '').trim()
  if (m !== '顺丰邮寄' && m !== '同城闪送') throw bad('邮寄方式不正确')
  if (p !== '包邮' && p !== '不包邮') throw bad('运费选项不正确')
  const f = String(fee || '').trim()
  if (f && f !== '标准件18¥' && f !== '生鲜航运30¥') throw bad('运费选项不正确')
  const addr = String(address || '').trim()
  const name = String(recipient || '').trim()
  const tel = String(phone || '').trim()
  if (!addr || !name || !tel) throw bad('请填写收件地址、收件人、联系方式')
  if (addr.length > 200 || name.length > 50 || tel.length > 30) throw bad('收件信息长度不正确')
  const row = await prisma.mailingRecord.create({
    data: {
      id: uid('mlr'),
      method: m,
      postage: p,
      fee: f || null,
      address: addr,
      recipient: name,
      phone: tel,
      remark: String(remark || '').trim().slice(0, 200),
      status: 'pending',
      createdBy: req.user.username,
    },
  })
  broadcast(
    '新门店邮寄',
    `方式 **${m}**${f ? ` · 运费 **${f}**` : ''}\n收件人 **${name}**\n地址 ${addr}\n提交人 **${req.user.username}**\n请尽快安排发货。`,
  ).catch(() => {})
  res.json({ ok: true, record: serializeMailingRecord(row) })
}))

v2Router.post('/mailing-records/:id/ship', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canMailing(req.user)) throw bad('无权限', 403)
  const row = await prisma.mailingRecord.findUnique({ where: { id: req.params.id } })
  if (!row) throw bad('发件记录不存在', 404)
  if (row.deletedAt) throw bad('已删除邮寄记录不可继续操作', 409)
  if (row.status !== 'pending') throw bad('该记录已发货', 409)
  const updated = await prisma.mailingRecord.update({
    where: { id: row.id },
    data: { status: 'shipped', shippedAt: new Date() },
  })
  res.json({ ok: true, record: serializeMailingRecord(updated) })
}))

// ---------- 大单奖 ----------
v2Router.get('/big-bonuses', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const store = String(req.query.store || '')
  const staffKey = String(req.query.staffKey || '')
  const month = String(req.query.month || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const where = { storeKey: whereStores(req.user, store || undefined) }
  if (req.user.role === 'staff') {
    const ownId = selfEmployeeId(req.user)
    if (!ownId) return res.json({ rows: [] })
    where.employeeId = ownId
  } else if (staffKey) {
    where.staffKey = staffKey
  }
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    where.date = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) }
  }
  const rows = await prisma.bigOrderBonus.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 })
  res.json({ rows: rows.map(serializeBigBonus) })
}))

v2Router.post('/big-bonuses', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const { staffName, storeKey, amountCents, receipt, date, employeeId } = req.body || {}
  const name = String(staffName || '').trim()
  if (!name || name.length > 30) throw bad('员工姓名不正确')
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  // Gate 10：稳定员工身份（新 UI 必须携带实际 Employee.id；绝不按姓名/门店推导）
  const stableEmployeeId = employeeId == null ? null : String(employeeId).trim()
  if (req.user.role === 'staff') {
    const ownId = selfEmployeeId(req.user)
    if (!ownId || stableEmployeeId !== ownId) throw bad('只能为本人登记大单奖', 403)
  }
  if (stableEmployeeId) {
    if (stableEmployeeId.length > 100) throw bad('员工 ID 不正确')
    const emp = await prisma.employee.findUnique({ where: { id: stableEmployeeId }, select: { id: true } })
    if (!emp) throw bad('员工不存在', 400)
  }
  const cents = Number(amountCents)
  if (!Number.isInteger(cents) || cents <= 0 || cents > 999999999999) throw bad('订单金额不正确（单位：分）')
  const receiptStr = String(receipt || '').trim()
  if (receiptStr && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(receiptStr)) throw bad('小票图片格式不正确')
  if (receiptStr.length > 10 * 1024 * 1024) throw bad('小票图片过大（最大约 7MB）')
  const bonusCents = Math.round(cents * 0.05)
  await ensureStore(storeKey)
  const bonusDate = date ? dateOnly(date) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')
  const row = await prisma.bigOrderBonus.create({
    data: {
      id: uid('bb'),
      ...(stableEmployeeId ? { employeeId: stableEmployeeId } : {}),
      staffKey: `${storeKey}::${name}`,
      staffName: name,
      storeKey,
      date: bonusDate,
      amountCents: BigInt(cents),
      bonusCents: BigInt(bonusCents),
      receipt: receiptStr.slice(0, 10 * 1024 * 1024),
      createdBy: req.user.username,
    },
  })
  res.json({ ok: true, bonus: serializeBigBonus(row) })
}))

v2Router.delete('/big-bonuses/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canInvoice(req.user)) throw bad('无权限', 403)
  const row = await prisma.bigOrderBonus.findUnique({ where: { id: req.params.id } })
  if (!row) throw bad('大单奖记录不存在', 404)
  if (req.user.role === 'staff' && (!selfEmployeeId(req.user) || row.employeeId !== selfEmployeeId(req.user))) throw bad('无权限', 403)
  if (!canStore(req.user, row.storeKey)) throw bad('无权限', 403)
  if (!isSuperUser(req.user) && row.createdBy !== req.user.username) throw bad('无权限', 403)
  await prisma.bigOrderBonus.delete({ where: { id: row.id } })
  res.json({ ok: true })
}))

// ---------- 每日薪资人工调整（仅开发者可写） ----------
v2Router.get('/daily-pay-adjustments', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!req.user || req.user.role === 'public') throw bad('无权限', 403)
  const month = String(req.query.month || '')
  const staffName = String(req.query.staffName || '').trim()
  const where = { active: true }
  if (staffName) where.staffName = staffName.slice(0, 50)
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [year, monthNumber] = month.split('-').map(Number)
    where.date = {
      gte: new Date(Date.UTC(year, monthNumber - 1, 1)),
      lt: new Date(Date.UTC(year, monthNumber, 1)),
    }
  }
  const rows = await prisma.dailyPayAdjustment.findMany({
    where,
    orderBy: [{ date: 'desc' }, { staffName: 'asc' }],
    take: 2000,
  })
  const scoped = await scopeDailyPayAdjustments(rows, req.user)
  res.json({ rows: scoped.map(serializeDailyPayAdjustment) })
}))

v2Router.put('/daily-pay-adjustments', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('仅最高业务权限账号可调整每日薪资', 403)
  const { staffName, date, autoPayCentsSnapshot, adjustedPayCents, reason, version, employeeId } = req.body || {}
  const name = String(staffName || '').trim()
  if (!name || name.length > 50) throw bad('员工姓名不正确')
  const d = dateOnly(date)
  const autoCents = Number(autoPayCentsSnapshot)
  const adjustedCents = Number(adjustedPayCents)
  if (!Number.isInteger(autoCents) || autoCents < 0 || autoCents > 999999999) {
    throw bad('自动工资金额不正确（单位：分）')
  }
  if (!Number.isInteger(adjustedCents) || adjustedCents < 0 || adjustedCents > 999999999) {
    throw bad('调整后工资金额不正确（单位：分）')
  }
  const reasonText = String(reason || '').trim()
  if (!reasonText || reasonText.length > 200) throw bad('请填写 1-200 字的调整原因')

  // Gate 9：稳定员工身份（新 UI 必须携带实际 Employee.id；绝不按姓名/门店推导）
  const stableEmployeeId = employeeId == null ? null : String(employeeId).trim()
  if (stableEmployeeId) {
    if (stableEmployeeId.length > 100) throw bad('员工 ID 不正确')
    const emp = await prisma.employee.findUnique({ where: { id: stableEmployeeId }, select: { id: true } })
    if (!emp) throw bad('员工不存在', 400)
  }

  const duties = await prisma.dailyEntry.findMany({ where: { date: d }, select: { staffNames: true } })
  const hasDuty = duties.some((entry) => Array.isArray(entry.staffNames) && entry.staffNames.includes(name))
  if (!hasDuty && !canManageAccounts(req.user)) {
    throw bad('该员工当天没有可识别的值班记录，无法调整工资', 409)
  }
  if (!hasDuty && autoCents !== 0) throw bad('无值班记录时自动工资必须为 0', 409)

  // 稳定行以 (employeeId, date) 为变更身份；legacy 行（无 employeeId）沿用 (staffName, date)
  const stableKey = stableEmployeeId ? { employeeId: stableEmployeeId, date: d } : null
  const legacyKey = { staffName: name, date: d }
  const existing = stableKey
    ? await prisma.dailyPayAdjustment.findUnique({ where: { employeeId_date: stableKey } })
    : await prisma.dailyPayAdjustment.findUnique({ where: { staffName_date: legacyKey } })
  if (existing && version != null && existing.version !== Number(version)) {
    return res.status(409).json({
      error: '该工资调整已被其他开发者修改，请刷新后重试',
      latest: serializeDailyPayAdjustment(existing),
    })
  }
  // Gate 9 §11：既有 legacy 行（employeeId=NULL）不得仅凭姓名/日期自动归属到新稳定行；
  // 若 legacy 唯一约束挡住稳定行创建 → 受控冲突，历史解析留待后续 Gate。
  if (!existing && stableEmployeeId) {
    const legacyBlocker = await prisma.dailyPayAdjustment.findUnique({ where: { staffName_date: legacyKey } })
    if (legacyBlocker) {
      throw bad('该姓名当天已存在历史工资调整（未绑定员工），无法创建稳定调整；请联系开发者处理', 409)
    }
  }
  const base = {
    ...(stableEmployeeId ? { employeeId: stableEmployeeId } : {}),
    autoPayCentsSnapshot: BigInt(autoCents),
    adjustedPayCents: BigInt(adjustedCents),
    reason: reasonText,
    active: true,
    updatedBy: req.user.username,
  }
  let saved
  try {
    saved = await prisma.$transaction(async (tx) => {
      let row
      if (existing) {
        const updated = await tx.dailyPayAdjustment.updateMany({
          where: { id: existing.id, version: existing.version },
          data: { ...base, version: { increment: 1 } },
        })
        if (updated.count !== 1) throw bad('该工资调整已被其他开发者修改，请刷新后重试', 409)
        row = await tx.dailyPayAdjustment.findUnique({ where: { id: existing.id } })
      } else {
        row = await tx.dailyPayAdjustment.create({
          data: {
            id: uid('dpa'),
            ...(stableEmployeeId ? { employeeId: stableEmployeeId } : {}),
            staffName: name,
            date: d,
            ...base,
            createdBy: req.user.username,
          },
        })
      }
      await tx.dailyPayAdjustmentAuditLog.create({
        data: {
          id: uid('dpa-audit'),
          adjustmentId: row.id,
          staffName: row.staffName,
          date: row.date,
          action: existing ? 'updated' : 'created',
          beforeValue: existing ? dailyPayAdjustmentAuditValue(existing) : undefined,
          afterValue: dailyPayAdjustmentAuditValue(row),
          operatorName: req.user.username,
        },
      })
      return row
    })
  } catch (err) {
    if (err?.code === 'P2002') throw bad('该员工当天已有工资调整，请刷新后重试', 409)
    throw err
  }
  res.json({ ok: true, adjustment: serializeDailyPayAdjustment(saved) })
}))

v2Router.delete('/daily-pay-adjustments/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw bad('仅最高业务权限账号可恢复自动工资', 403)
  const existing = await prisma.dailyPayAdjustment.findUnique({ where: { id: req.params.id } })
  if (!existing) throw bad('工资调整记录不存在', 404)
  const version = req.body?.version
  if (version == null || existing.version !== Number(version)) {
    return res.status(409).json({
      error: '该工资调整已被其他开发者修改，请刷新后重试',
      latest: serializeDailyPayAdjustment(existing),
    })
  }
  if (existing.active) {
    await prisma.$transaction(async (tx) => {
      const restoredResult = await tx.dailyPayAdjustment.updateMany({
        where: { id: existing.id, version: existing.version, active: true },
        data: { active: false, updatedBy: req.user.username, version: { increment: 1 } },
      })
      if (restoredResult.count !== 1) throw bad('该工资调整已被其他开发者修改，请刷新后重试', 409)
      const restored = await tx.dailyPayAdjustment.findUnique({ where: { id: existing.id } })
      await tx.dailyPayAdjustmentAuditLog.create({
        data: {
          id: uid('dpa-audit'),
          adjustmentId: existing.id,
          staffName: existing.staffName,
          date: existing.date,
          action: 'restored_auto',
          beforeValue: dailyPayAdjustmentAuditValue(existing),
          afterValue: dailyPayAdjustmentAuditValue(restored),
          operatorName: req.user.username,
        },
      })
    })
  }
  res.json({ ok: true })
}))

// ---------- M3-3：会员 ----------
v2Router.get('/members', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const q = String(req.query.q || '').trim()
  const rows = await prisma.member.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({ rows: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, birthday: r.birthday ? isoDate(r.birthday) : null, level: r.level, points: r.points, createdAt: r.createdAt })) })
}))

v2Router.get('/members/birthdays', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const month = String(req.query.month || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const mm = Number(month.split('-')[1])
  const all = await prisma.member.findMany({ where: { birthday: { not: null } }, take: 2000 })
  res.json({ rows: all.filter((m) => m.birthday && m.birthday.getUTCMonth() + 1 === mm).map((r) => ({ id: r.id, name: r.name, phone: r.phone, birthday: isoDate(r.birthday), level: r.level, points: r.points })) })
}))

v2Router.post('/members', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { name, phone, birthday } = req.body || {}
  const n = String(name || '').trim()
  const p = String(phone || '').trim()
  if (!n || n.length > 30) throw bad('会员姓名不正确')
  if (!/^1\d{10}$/.test(p)) throw bad('手机号应为 11 位')
  const exists = await prisma.member.findUnique({ where: { phone: p } })
  if (exists) throw bad('该手机号已建档', 409)
  const row = await prisma.member.create({
    data: { id: uid('mb'), name: n, phone: p, birthday: birthday ? dateOnly(birthday) : null },
  })
  res.json({ ok: true, member: { id: row.id, name: row.name, phone: row.phone, birthday: row.birthday ? isoDate(row.birthday) : null, level: row.level, points: row.points } })
}))

v2Router.put('/members/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { name, birthday, level } = req.body || {}
  const row = await prisma.member.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name: String(name).trim().slice(0, 30) } : {}),
      ...(birthday !== undefined ? { birthday: birthday ? dateOnly(birthday) : null } : {}),
      ...(level !== undefined ? { level: Math.max(0, Math.min(9, Number(level) || 0)) } : {}),
    },
  })
  res.json({ ok: true, member: { id: row.id, name: row.name, phone: row.phone, birthday: row.birthday ? isoDate(row.birthday) : null, level: row.level, points: row.points } })
}))

v2Router.get('/members/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const row = await prisma.member.findUnique({ where: { id: req.params.id }, include: { consumptions: { orderBy: { date: 'desc' }, take: 200 } } })
  if (!row) throw bad('会员不存在', 404)
  res.json({
    member: { id: row.id, name: row.name, phone: row.phone, birthday: row.birthday ? isoDate(row.birthday) : null, level: row.level, points: row.points },
    consumptions: row.consumptions.map((c) => ({ id: c.id, storeKey: c.storeKey, date: isoDate(c.date), amountCents: c.amountCents.toString(), note: c.note, createdAt: c.createdAt })),
  })
}))

v2Router.post('/members/:id/consumptions', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const { storeKey, date, amountCents, note } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  const cents = Number(amountCents)
  if (!Number.isInteger(cents) || cents < 0 || cents > 999999999999) throw bad('金额不正确（单位：分）')
  await ensureStore(storeKey)
  const member = await prisma.member.findUnique({ where: { id: req.params.id } })
  if (!member) throw bad('会员不存在', 404)
  const points = Math.floor(cents / 100)
  const row = await prisma.$transaction(async (tx) => {
    const c = await tx.memberConsumption.create({
      data: { id: uid('mc'), memberId: member.id, storeKey, date: dateOnly(date), amountCents: BigInt(cents), note: String(note || '').trim().slice(0, 200) },
    })
    await tx.member.update({ where: { id: member.id }, data: { points: member.points + points } })
    return c
  })
  res.json({ ok: true, points: member.points + points, consumption: { id: row.id, storeKey: row.storeKey, date: isoDate(row.date), amountCents: row.amountCents.toString(), note: row.note } })
}))
