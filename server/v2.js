import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { sendWechatMarkdown } from './wechat-alert.js'
import { FIXED_OPTION_NAMES } from './fixedOptions.js'
import { CHANGELOG } from './changelog.js'
import { meituanConfig, meituanReady } from './meituan/config.js'
import { runMeituanSync, isMeituanSyncing } from './meituan/sync.js'
import { mockMeituanDay } from './meituan/client.js'

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

function canStore(user, storeKey) {
  if (!user || user.role === 'public') return false
  if (user.role === 'developer') return true
  return Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey)
}

function isManager(user) {
  return Boolean(user && ['developer', 'manager'].includes(user.role))
}

function whereStores(user, storeKeyParam) {
  if (storeKeyParam) return storeKeyParam
  if (user.role === 'developer' || user.role === 'public') return undefined
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
  return prisma.store.upsert({
    where: { key: storeKey },
    update: {},
    create: { key: storeKey, name: name || storeKey },
  })
}

async function upsertItem(name, category = 'product') {
  const n = String(name || '').trim()
  if (!n || n.length > 50) throw bad('货品名称不正确')
  return prisma.inventoryItem.upsert({
    where: { name: n },
    update: {},
    create: { id: `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: n, category },
  })
}

function itemRows(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) throw bad('请至少添加一种货品（最多 50 种）')
  return items.map((it) => {
    const name = String(it.name || it.productName || '').trim()
    const quantity = Number(it.quantity)
    const note = it.note === undefined || it.note === null ? '' : String(it.note).trim().slice(0, 100)
    if (!name || name.length > 50) throw bad('货品名称不正确')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999999) throw bad('数量应为 1-999999 的整数')
    return { name, quantity, note }
  })
}

function serializeTransfer(r) {
  return {
    id: r.id,
    type: 'transfer',
    storeKey: r.toStoreKey,
    fromStoreKey: r.fromStoreKey,
    status: r.status,
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    items: r.items.map((it) => ({
      id: it.id,
      itemId: it.itemId,
      category: it.item.category || 'product',
      productName: it.item.name,
      quantity: it.quantity,
      note: it.note,
    })),
  }
}

function serializePurchase(r) {
  return {
    id: r.id,
    type: 'purchase',
    storeKey: r.storeKey,
    status: r.status,
    supplier: r.supplier,
    expectedAt: r.expectedAt,
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    items: r.items.map((it) => ({
      id: it.id,
      itemId: it.itemId,
      category: it.item.category || 'product',
      productName: it.item.name,
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
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

function storeFilter(user) {
  if (user.role === 'developer' || user.role === 'public') return null
  return Array.isArray(user.storeKeys) && user.storeKeys.length > 0 ? { in: user.storeKeys } : { in: [] }
}

function canWrite(user) {
  return Boolean(user && ['developer', 'manager'].includes(user.role))
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
      await sendWechatMarkdown(
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
      version: r.version,
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt,
    })),
  })
}))

v2Router.put('/daily-entries', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, date, incCents, ord, staffNames, version } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  const d = dateOnly(date)
  const cents = Number(incCents)
  const orderCount = Number(ord)
  if (!Number.isInteger(cents) || cents < 0 || cents > 999999999999) throw bad('营业收入不正确（单位：分）')
  if (!Number.isInteger(orderCount) || orderCount < 0 || orderCount > 999999) throw bad('订单数不正确')
  const names = Array.isArray(staffNames) ? staffNames.slice(0, 50).map((s) => String(s).trim().slice(0, 30)) : []
  await ensureStore(storeKey)
  const composite = { storeKey, date: d }
  const existing = await prisma.dailyEntry.findUnique({ where: { storeKey_date: composite } })
  if (existing && version != null && existing.version !== Number(version)) {
    return res.status(409).json({
      error: '数据已被他人修改，已加载最新数据',
      latest: {
        id: existing.id,
        storeKey: existing.storeKey,
        date: isoDate(existing.date),
        incCents: existing.incCents.toString(),
        ord: existing.ord,
        staffNames: existing.staffNames,
        version: existing.version,
      },
    })
  }
  const base = { incCents: BigInt(cents), ord: orderCount, staffNames: names, updatedBy: req.user.username }
  const saved = await prisma.dailyEntry.upsert({
    where: { storeKey_date: composite },
    update: { ...base, version: { increment: 1 }, updatedAt: new Date() },
    create: { id: `de-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey, date: d, ...base, version: existing ? existing.version + 1 : 1 },
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
      version: saved.version,
    },
  })
}))

v2Router.delete('/daily-entries', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, date } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  if (req.user.role === 'public') throw bad('无权限', 403)
  const d = dateOnly(date)
  const result = await prisma.dailyEntry.deleteMany({ where: { storeKey, date: d } })
  res.json({ ok: true, deleted: result.count })
}))

// ---------- 调货 ----------
v2Router.post('/transfer-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { fromStoreKey, toStoreKey, items, note } = req.body || {}
  if (!canStore(req.user, fromStoreKey)) throw bad('无权限', 403)
  if (!fromStoreKey || !toStoreKey || fromStoreKey === toStoreKey) throw bad('调出/调入门店不正确')
  const rows = itemRows(items)
  await ensureStore(fromStoreKey)
  await ensureStore(toStoreKey)
  const created = await prisma.transferRequest.create({
    data: {
      id: `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fromStoreKey,
      toStoreKey,
      note: String(note || '').trim().slice(0, 200),
      createdBy: req.user.username,
      items: {
        create: await Promise.all(
          rows.map(async (row) => {
            const item = await upsertItem(row.name)
            return { id: `ti-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, itemId: item.id, quantity: row.quantity, note: row.note }
          }),
        ),
      },
    },
    include: { items: { include: { item: true } } },
  })
  sendWechatMarkdown(
    '新调货申请',
    `**${created.fromStoreKey}** → **${created.toStoreKey}**\n货品 **${created.items.length}** 种 · 提交人 **${req.user.username}**\n请调出门店店长尽快审核发货。`,
  ).catch(() => {})
  res.json({ ok: true, request: created })
}))

v2Router.get('/transfer-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const sf = storeFilter(req.user)
  const where = {}
  if (sf) where.OR = [{ fromStoreKey: sf }, { toStoreKey: sf }]
  if (req.query.status) where.status = String(req.query.status)
  const rows = await prisma.transferRequest.findMany({
    where,
    include: { items: { include: { item: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({ rows: rows.map(serializeTransfer) })
}))

v2Router.delete('/transfer-requests/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await prisma.transferRequest.findUnique({ where: { id: req.params.id } })
  if (!t) throw bad('申请不存在', 404)
  if (req.user.role !== 'developer' && t.createdBy !== req.user.username) throw bad('无权限', 403)
  if (t.status !== 'pending') throw bad('仅待审核申请可删除')
  await prisma.transferRequest.delete({ where: { id: t.id } })
  res.json({ ok: true })
}))

async function getTransfer(id) {
  return prisma.transferRequest.findUnique({ where: { id }, include: { items: { include: { item: true } } } })
}

v2Router.post('/transfer-requests/:id/ship', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await getTransfer(req.params.id)
  if (!t) throw bad('申请不存在', 404)
  if (!isManager(req.user) || !canStore(req.user, t.fromStoreKey)) throw bad('无权限', 403)
  if (t.status !== 'pending') throw bad('当前状态不可发货')
  const updated = await prisma.transferRequest.update({ where: { id: t.id }, data: { status: 'in_transit', updatedAt: new Date() } })
  sendWechatMarkdown(
    '调货已发货',
    `**${t.fromStoreKey}** → **${t.toStoreKey}**\n货品 **${t.items.length}** 种 · 操作人 **${req.user.username}**\n请调入门店店长留意收货。`,
  ).catch(() => {})
  res.json({ ok: true, request: updated })
}))

v2Router.post('/transfer-requests/:id/reject', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await getTransfer(req.params.id)
  if (!t) throw bad('申请不存在', 404)
  if (!isManager(req.user) || !canStore(req.user, t.fromStoreKey)) throw bad('无权限', 403)
  if (t.status !== 'pending') throw bad('当前状态不可驳回')
  const updated = await prisma.transferRequest.update({ where: { id: t.id }, data: { status: 'rejected', updatedAt: new Date() } })
  res.json({ ok: true, request: updated })
}))

v2Router.post('/transfer-requests/:id/receive', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const t = await getTransfer(req.params.id)
  if (!t) throw bad('申请不存在', 404)
  if (!isManager(req.user) || !canStore(req.user, t.toStoreKey)) throw bad('无权限', 403)
  if (t.status !== 'in_transit') throw bad('当前状态不可收货')
  const operator = req.user.username
  await prisma.$transaction(async (tx) => {
    for (const row of t.items) {
      const outKey = { storeKey: t.fromStoreKey, itemId: row.itemId }
      const inKey = { storeKey: t.toStoreKey, itemId: row.itemId }
      const out = await tx.stockBalance.findUnique({ where: { storeKey_itemId: outKey } })
      const outQty = out ? out.quantity : 0
      if (outQty < row.quantity) {
        const e = new Error(`「${row.item.name}」调出门店库存不足（当前 ${outQty}）`)
        e.status = 400
        throw e
      }
      await tx.stockBalance.update({
        where: { storeKey_itemId: outKey },
        data: { quantity: outQty - row.quantity, updatedAt: new Date() },
      })
      const inRow = await tx.stockBalance.findUnique({ where: { storeKey_itemId: inKey } })
      const inQty = inRow ? inRow.quantity : 0
      await tx.stockBalance.upsert({
        where: { storeKey_itemId: inKey },
        update: { quantity: inQty + row.quantity, updatedAt: new Date() },
        create: { id: `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey: t.toStoreKey, itemId: row.itemId, quantity: row.quantity },
      })
      await tx.stockLedger.create({ id: `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey: t.fromStoreKey, itemId: row.itemId, change: -row.quantity, balance: outQty - row.quantity, type: 'transfer_out', refId: t.id, operator })
      await tx.stockLedger.create({ id: `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey: t.toStoreKey, itemId: row.itemId, change: row.quantity, balance: inQty + row.quantity, type: 'transfer_in', refId: t.id, operator })
    }
    await tx.transferRequest.update({ where: { id: t.id }, data: { status: 'completed', updatedAt: new Date() } })
  })
  maybeAlertLowStock(t.fromStoreKey).catch(() => {})
  maybeAlertLowStock(t.toStoreKey).catch(() => {})
  sendWechatMarkdown(
    '调货已收货',
    `**${t.fromStoreKey}** → **${t.toStoreKey}**\n货品 **${t.items.length}** 种 · 确认人 **${operator}**\n库存已自动增减并写入流水。`,
  ).catch(() => {})
  res.json({ ok: true })
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
            const item = await upsertItem(row.name)
            return { id: `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, itemId: item.id, orderedQty: row.quantity, note: row.note }
          }),
        ),
      },
    },
    include: { items: { include: { item: true } } },
  })
  sendWechatMarkdown(
    '新采购申请',
    `门店 **${created.storeKey}**\n货品 **${created.items.length}** 种${created.supplier ? ` · 供应商 **${created.supplier}**` : ''}\n提交人 **${req.user.username}**\n请尽快安排采购收货。`,
  ).catch(() => {})
  res.json({ ok: true, request: created })
}))

v2Router.get('/purchase-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const sf = storeFilter(req.user)
  const where = sf ? { storeKey: sf } : {}
  if (req.query.status) where.status = String(req.query.status)
  const rows = await prisma.purchaseRequest.findMany({
    where,
    include: { items: { include: { item: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({ rows: rows.map(serializePurchase) })
}))

v2Router.delete('/purchase-requests/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const p = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } })
  if (!p) throw bad('申请不存在', 404)
  if (req.user.role !== 'developer' && p.createdBy !== req.user.username) throw bad('无权限', 403)
  if (p.status !== 'pending') throw bad('仅待处理申请可删除')
  await prisma.purchaseRequest.delete({ where: { id: p.id } })
  res.json({ ok: true })
}))

v2Router.post('/purchase-requests/:id/receive', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const p = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id }, include: { items: { include: { item: true } } } })
  if (!p) throw bad('申请不存在', 404)
  if (!isManager(req.user) || !canStore(req.user, p.storeKey)) throw bad('无权限', 403)
  if (p.status !== 'pending') throw bad('当前状态不可收货')
  const received = (req.body && req.body.items) || []
  const receivedMap = new Map(received.map((r) => [String(r.itemId || r.id || ''), Number(r.receivedQty)]))
  const operator = req.user.username
  await prisma.$transaction(async (tx) => {
    for (const row of p.items) {
      const qty = Number.isInteger(receivedMap.get(row.itemId)) ? receivedMap.get(row.itemId) : row.orderedQty
      if (qty < 0 || qty > 999999) throw bad('实收数量不正确')
      const bal = await tx.stockBalance.findUnique({ where: { storeKey_itemId: { storeKey: p.storeKey, itemId: row.itemId } } })
      const cur = bal ? bal.quantity : 0
      await tx.stockBalance.upsert({
        where: { storeKey_itemId: { storeKey: p.storeKey, itemId: row.itemId } },
        update: { quantity: cur + qty, updatedAt: new Date() },
        create: { id: `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey: p.storeKey, itemId: row.itemId, quantity: qty },
      })
      await tx.stockLedger.create({ id: `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey: p.storeKey, itemId: row.itemId, change: qty, balance: cur + qty, type: 'purchase_in', refId: p.id, operator })
      await tx.purchaseItem.update({ where: { id: row.id }, data: { receivedQty: qty } })
    }
    await tx.purchaseRequest.update({ where: { id: p.id }, data: { status: 'received', updatedAt: new Date() } })
  })
  maybeAlertLowStock(p.storeKey).catch(() => {})
  sendWechatMarkdown(
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

// 员工名单镜像：KV 员工（人员管理）→ PostgreSQL Staff 表（开发者/店长可写）
v2Router.put('/staff', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const list = Array.isArray(req.body && req.body.staff) ? req.body.staff : []
  if (list.length > 2000) throw bad('员工数量过多')
  const allowed = req.user.role === 'developer' ? null : req.user.storeKeys || []
  await prisma.$transaction(async (tx) => {
    await tx.staff.deleteMany({ where: allowed ? { storeKey: { in: allowed } } : {} })
    for (const s of list) {
      const name = String(s.name || '').trim()
      const storeKey = String(s.storeKey || '').trim()
      if (!name || name.length > 30 || !storeKey || storeKey.length > 30) throw bad('员工数据不正确')
      if (allowed && !allowed.includes(storeKey)) throw bad('无权限', 403)
      await tx.store.upsert({ where: { key: storeKey }, update: {}, create: { key: storeKey, name: storeKey } })
      const id = `st-${storeKey}-${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
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
v2Router.post('/alerts/test', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user.role !== 'developer') throw bad('无权限', 403)
  const ok = await sendWechatMarkdown('BUDU 告警测试', '这是一条测试消息，企微告警通道正常 ✅')
  res.json({ ok, configured: Boolean(process.env.WECHAT_WORK_WEBHOOK_URL) })
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
  if (!canWrite(req.user)) throw bad('无权限', 403)
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
  if (req.user.role !== 'developer' && row.createdBy !== req.user.username) throw bad('无权限', 403)
  await prisma.expense.delete({ where: { id: row.id } })
  res.json({ ok: true })
}))

v2Router.get('/profit', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  res.json(await computeProfit(req.user, String(req.query.month || ''), String(req.query.store || '')))
}))

v2Router.get('/export/profit', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
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
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const q = String(req.query.q || '').trim()
  const rows = await prisma.invoiceCompany.findMany({
    where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
    orderBy: { updatedAt: 'desc' },
    take: 50,
  })
  res.json({ rows: rows.map((r) => ({ id: r.id, name: r.name, taxNo: r.taxNo })) })
}))

v2Router.delete('/invoices/companies/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user?.role !== 'developer') throw bad('无权限', 403)
  await prisma.invoiceCompany.delete({ where: { id: req.params.id } }).catch(() => {})
  res.json({ ok: true })
}))

v2Router.get('/invoices', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const month = String(req.query.month || '')
  const where = { storeKey: whereStores(req.user, store || undefined) }
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    where.createdAt = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) }
  }
  const rows = await prisma.invoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: 1000 })
  res.json({ rows: rows.map(serializeInvoice) })
}))

v2Router.post('/invoices', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
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
      createdBy: req.user.username,
    },
  })
  res.json({ ok: true, invoice: serializeInvoice(row) })
}))

v2Router.delete('/invoices/:id', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (!canWrite(req.user)) throw bad('无权限', 403)
  const row = await prisma.invoice.findUnique({ where: { id: req.params.id } })
  if (!row) throw bad('发票记录不存在', 404)
  if (!canStore(req.user, row.storeKey)) throw bad('无权限', 403)
  if (req.user.role !== 'developer' && row.createdBy !== req.user.username) throw bad('无权限', 403)
  await prisma.invoice.delete({ where: { id: row.id } })
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

// ---------- M4：美团收银数据 ----------
function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null
  const [y, m] = String(month).split('-').map(Number)
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) }
}

v2Router.get('/daily-sales', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const where = { storeKey: whereStores(req.user, store || undefined) }
  const range = monthRange(req.query.month)
  if (range) where.date = range
  const rows = await prisma.dailySales.findMany({ where, orderBy: [{ date: 'desc' }, { storeKey: 'asc' }], take: 2000 })
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      storeKey: r.storeKey,
      date: isoDate(r.date),
      incCents: r.incCents.toString(),
      ord: r.ord,
      refundCents: r.refundCents.toString(),
      channels: r.channels,
      source: r.source,
      updatedAt: r.updatedAt,
    })),
  })
}))

v2Router.get('/dish-daily', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const where = { storeKey: whereStores(req.user, store || undefined) }
  const range = monthRange(req.query.month)
  if (range) where.date = range
  const rows = await prisma.dishDaily.findMany({ where, orderBy: [{ date: 'desc' }, { dishName: 'asc' }], take: 5000 })
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      storeKey: r.storeKey,
      date: isoDate(r.date),
      dishName: r.dishName,
      productName: r.productName,
      sales: r.sales,
      amountCents: r.amountCents.toString(),
    })),
  })
}))

v2Router.get('/meituan/status', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const cfg = meituanConfig()
  const mappings = await prisma.meituanStoreMapping.findMany({ orderBy: { createdAt: 'asc' } })
  const logs = await prisma.meituanSyncLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 })
  if (req.user.role !== 'developer') {
    return res.json({
      enabled: cfg.enabled,
      configured: meituanReady(cfg),
      mock: !meituanReady(cfg),
      mappingCount: mappings.length,
      logsCount: logs.length,
    })
  }
  res.json({
    enabled: cfg.enabled,
    configured: meituanReady(cfg),
    appId: cfg.appId,
    mock: !meituanReady(cfg),
    mappings: mappings.map((m) => ({ meituanStoreId: m.meituanStoreId, storeKey: m.storeKey, enabled: m.enabled })),
    logs: logs.map((l) => ({
      id: l.id,
      meituanStoreId: l.meituanStoreId,
      storeKey: l.storeKey,
      day: l.day,
      status: l.status,
      message: l.message,
      durationMs: l.durationMs,
      createdAt: l.createdAt,
    })),
  })
}))

v2Router.put('/meituan/mappings', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user.role !== 'developer') throw bad('无权限', 403)
  const list = Array.isArray(req.body && req.body.mappings) ? req.body.mappings : []
  if (list.length > 100) throw bad('映射数量过多')
  const seen = new Set()
  for (const m of list) {
    const id = String(m.meituanStoreId || '').trim()
    const storeKey = String(m.storeKey || '').trim()
    if (!id || id.length > 60 || seen.has(id)) throw bad('美团店铺ID不正确或重复')
    if (!storeKey || storeKey.length > 30) throw bad('门店不正确')
    seen.add(id)
    await prisma.store.upsert({ where: { key: storeKey }, update: {}, create: { key: storeKey, name: storeKey } })
  }
  for (const m of list) {
    await prisma.meituanStoreMapping.upsert({
      where: { meituanStoreId: String(m.meituanStoreId).trim() },
      update: { storeKey: String(m.storeKey).trim(), enabled: m.enabled !== false },
      create: {
        id: uid('mm'),
        meituanStoreId: String(m.meituanStoreId).trim(),
        storeKey: String(m.storeKey).trim(),
        enabled: m.enabled !== false,
      },
    })
  }
  res.json({ ok: true })
}))

v2Router.post('/meituan/sync-now', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user.role !== 'developer') throw bad('无权限', 403)
  if (isMeituanSyncing()) throw bad('同步进行中，请稍后再试')
  const cfg = meituanConfig()
  if (!meituanReady(cfg)) {
    const first = await prisma.meituanStoreMapping.findFirst()
    const today = new Date().toISOString().slice(0, 10)
    return res.json({
      ok: true,
      mock: true,
      message: '模拟模式：未配置美团凭证，未拉取/写入真实数据',
      sample: mockMeituanDay(first ? first.storeKey : 'tongying', today),
    })
  }
  res.json(await runMeituanSync())
}))

v2Router.get('/meituan/dish-unmapped', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user.role !== 'developer') throw bad('无权限', 403)
  const groups = await prisma.dishDaily.groupBy({
    by: ['dishName'],
    where: { productName: '' },
    _sum: { sales: true },
    _count: { _all: true },
    orderBy: { dishName: 'asc' },
  })
  res.json({
    rows: groups.map((g) => ({ dishName: g.dishName, sales: g._sum.sales || 0, days: g._count._all })),
  })
}))

v2Router.put('/meituan/dish-mappings', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  if (req.user.role !== 'developer') throw bad('无权限', 403)
  const list = Array.isArray(req.body && req.body.mappings) ? req.body.mappings : []
  for (const m of list) {
    const dishName = String(m.dishName || '').trim()
    const productName = String(m.productName || '').trim()
    if (!dishName || dishName.length > 50 || !productName || productName.length > 50) throw bad('映射内容不正确')
    await prisma.dishMapping.upsert({
      where: { dishName },
      update: { productName },
      create: { id: uid('dm'), dishName, productName },
    })
    await prisma.dishDaily.updateMany({ where: { dishName }, data: { productName } })
  }
  res.json({ ok: true })
}))
