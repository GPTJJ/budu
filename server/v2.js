import { Router } from 'express'
import { prisma, dbReady } from './pg.js'

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

function storeFilter(user) {
  if (user.role === 'developer' || user.role === 'public') return null
  return Array.isArray(user.storeKeys) && user.storeKeys.length > 0 ? { in: user.storeKeys } : { in: [] }
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
  res.json({ ok: true })
}))

// ---------- 采购 ----------
v2Router.post('/purchase-requests', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const { storeKey, items, supplier, expectedAt, note } = req.body || {}
  if (!canStore(req.user, storeKey)) throw bad('无权限', 403)
  const rows = itemRows(items)
  await ensureStore(storeKey)
  const created = await prisma.purchaseRequest.create({
    data: {
      id: `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      storeKey,
      supplier: String(supplier || '').trim().slice(0, 50),
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
  res.json({ rows: rows.map((r) => ({ storeKey: r.storeKey, itemId: r.itemId, name: r.item.name, unit: r.item.unit, quantity: r.quantity, updatedAt: r.updatedAt })) })
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
        update: { quantity, updatedAt: new Date() },
        create: { id: `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, storeKey, itemId: item.id, quantity },
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
  res.json({ ok: true })
}))

v2Router.get('/stock/ledger', wrap(async (req, res) => {
  if (!dbReady()) throw bad('数据库未配置', 503)
  const store = String(req.query.store || '')
  if (store && !canStore(req.user, store)) throw bad('无权限', 403)
  const where = { storeKey: whereStores(req.user, store || undefined) }
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
