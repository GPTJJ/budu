import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { verifyPassword } from './auth.js'
import { hasDeveloperSensitiveRecordDelete } from '../shared/accountPermissions.js'

export const developerSafeDeleteRouter = Router()

const TYPES = Object.freeze({
  mailing: { delegate: 'mailingRecord', label: '门店邮寄订单' },
  invoice: { delegate: 'invoice', label: '开发票订单' },
  transfer: { delegate: 'transferRequest', label: '库存调拨单', include: { items: true } },
  purchase: { delegate: 'purchaseRequest', label: '采购申请', include: { items: true } },
  partnerSupply: { delegate: 'partnerSupplyOrder', label: '合作商供货单', include: { items: true, receipts: true } },
})
const REASONS = Object.freeze({ test: '测试数据', duplicate: '重复记录', input_error: '录入错误', other: '其他' })
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000
const LOCK_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res) } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[developer-safe-delete]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function requireDeveloper(user) {
  if (!hasDeveloperSensitiveRecordDelete(user)) throw bad('仅开发者可执行敏感记录删除或恢复', 403)
  if (!dbReady()) throw bad('数据库未配置', 503)
}

async function verifySensitivePassword(userId, password) {
  const now = new Date()
  const user = await prisma.user.findUnique({ where: { id: userId }, select: {
    secondPasswordHash: true, sensitiveFailedAttempts: true,
    sensitiveAttemptWindowStartedAt: true, sensitiveLockedUntil: true,
  } })
  if (!user?.secondPasswordHash) throw bad('尚未设置二级密码，请先在系统设置中设置', 409)
  if (user.sensitiveLockedUntil && user.sensitiveLockedUntil > now) throw bad('二级密码错误次数过多，请稍后再试', 429)
  if (verifyPassword(String(password || ''), user.secondPasswordHash)) {
    await prisma.user.update({ where: { id: userId }, data: {
      sensitiveFailedAttempts: 0, sensitiveAttemptWindowStartedAt: null, sensitiveLockedUntil: null,
    } })
    return
  }
  const inWindow = user.sensitiveAttemptWindowStartedAt && now.getTime() - user.sensitiveAttemptWindowStartedAt.getTime() < ATTEMPT_WINDOW_MS
  const failed = inWindow ? user.sensitiveFailedAttempts + 1 : 1
  const lockedUntil = failed >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCK_MS) : null
  await prisma.user.update({ where: { id: userId }, data: {
    sensitiveFailedAttempts: failed,
    sensitiveAttemptWindowStartedAt: inWindow ? user.sensitiveAttemptWindowStartedAt : now,
    sensitiveLockedUntil: lockedUntil,
  } })
  throw bad(lockedUntil ? '二级密码错误次数过多，请稍后再试' : `二级密码不正确（剩余 ${MAX_ATTEMPTS - failed} 次）`, lockedUntil ? 429 : 401)
}

function reasonFrom(body) {
  const code = String(body?.reasonCode || '')
  if (!REASONS[code]) throw bad('请选择删除原因')
  const detail = String(body?.reasonText || '').trim()
  if (code === 'other' && !detail) throw bad('请填写其他原因')
  if (detail.length > 200) throw bad('删除原因不能超过 200 个字符')
  return detail ? `${REASONS[code]}：${detail}` : REASONS[code]
}

function publicSummary(type, row) {
  const common = { id: row.id, type, typeLabel: TYPES[type].label, status: row.status || '', createdAt: row.createdAt, deletedAt: row.deletedAt, deletedBy: row.deletedBy, deleteReason: row.deleteReason }
  if (type === 'mailing') return { ...common, title: `${row.recipient} · ${row.method}`, subtitle: row.address }
  if (type === 'invoice') return { ...common, title: row.companyName || '个人发票', subtitle: `${row.storeKey} · ¥${(Number(row.amountCents) / 100).toFixed(2)}` }
  if (type === 'transfer') return { ...common, title: `${row.fromLocationName || row.fromStoreKey || '—'} → ${row.toLocationName || row.toStoreKey || '—'}`, subtitle: `${row.items?.length || 0} 项 · ${row.createdBy}` }
  if (type === 'purchase') return { ...common, title: `${row.storeKey} · ${row.supplier || '未指定供应商'}`, subtitle: `${row.items?.length || 0} 项 · ${row.createdBy}` }
  return { ...common, title: row.orderNo, subtitle: `${row.partnerNameSnapshot} · ${row.fromStoreNameSnapshot}` }
}

function detailFor(type, row) {
  const summary = publicSummary(type, row)
  if (type === 'transfer') return { ...summary, items: row.items.map((item) => ({ id: item.id, name: item.itemNameSnapshot, code: item.itemCodeSnapshot, quantity: item.quantity })) }
  if (type === 'purchase') return { ...summary, items: row.items.map((item) => ({ id: item.id, name: item.itemNameSnapshot, orderedQty: item.orderedQty, receivedQty: item.receivedQty })) }
  if (type === 'partnerSupply') return { ...summary, items: row.items.map((item) => ({ id: item.id, name: item.productNameSnapshot, code: item.productCodeSnapshot, quantity: item.quantity })), receiptCount: row.receipts.length }
  return summary
}

function highRisk(type, row) {
  if (type === 'mailing') return row.status === 'shipped'
  if (type === 'invoice') return row.status === 'done'
  if (type === 'transfer') return row.status === 'shipped'
  if (type === 'purchase') return row.status === 'received'
  return row.status === 'shipped' || (row.receipts || []).some((receipt) => receipt.status === 'active')
}

async function findRecord(type, id) {
  const config = TYPES[type]
  if (!config) throw bad('记录类型不正确')
  return prisma[config.delegate].findUnique({ where: { id }, ...(config.include ? { include: config.include } : {}) })
}

developerSafeDeleteRouter.post('/developer-sensitive-records/:type/:id/delete', wrap(async (req, res) => {
  requireDeveloper(req.user)
  const { type, id } = req.params
  const config = TYPES[type]
  if (!config) throw bad('记录类型不正确')
  const reason = reasonFrom(req.body)
  await verifySensitivePassword(req.user.id, req.body?.secondPassword)
  const existing = await findRecord(type, id)
  if (!existing) throw bad('记录不存在', 404)
  if (existing.deletedAt) throw bad('记录已删除', 409)
  const deletedAt = new Date()
  await prisma.$transaction(async (tx) => {
    const changed = await tx[config.delegate].updateMany({ where: { id, deletedAt: null }, data: { deletedAt, deletedBy: req.user.id, deleteReason: reason } })
    if (changed.count !== 1) throw bad('记录已被其他操作更新，请刷新后重试', 409)
    await tx.sensitiveRecordAudit.create({ data: {
      id: `sra-${crypto.randomUUID()}`, action: 'DELETE', recordType: type, recordId: id,
      actorUserId: req.user.id, actorUsername: req.user.username, reason,
    } })
  })
  res.json({ ok: true, highRisk: highRisk(type, existing) })
}))

developerSafeDeleteRouter.post('/developer-sensitive-records/:type/:id/restore', wrap(async (req, res) => {
  requireDeveloper(req.user)
  const { type, id } = req.params
  const config = TYPES[type]
  if (!config) throw bad('记录类型不正确')
  await verifySensitivePassword(req.user.id, req.body?.secondPassword)
  const existing = await findRecord(type, id)
  if (!existing) throw bad('记录不存在', 404)
  if (!existing.deletedAt) throw bad('记录未被删除', 409)
  await prisma.$transaction(async (tx) => {
    const changed = await tx[config.delegate].updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, deletedBy: '', deleteReason: '' } })
    if (changed.count !== 1) throw bad('记录已被其他操作更新，请刷新后重试', 409)
    await tx.sensitiveRecordAudit.create({ data: {
      id: `sra-${crypto.randomUUID()}`, action: 'RESTORE', recordType: type, recordId: id,
      actorUserId: req.user.id, actorUsername: req.user.username, reason: String(req.body?.reason || '').trim().slice(0, 200),
    } })
  })
  res.json({ ok: true, id })
}))

developerSafeDeleteRouter.get('/developer-sensitive-records', wrap(async (req, res) => {
  requireDeveloper(req.user)
  const requestedTypes = req.query.type && TYPES[req.query.type] ? [req.query.type] : Object.keys(TYPES)
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start || '')) ? new Date(`${req.query.start}T00:00:00.000Z`) : null
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end || '')) ? new Date(`${req.query.end}T23:59:59.999Z`) : null
  const deletedBy = String(req.query.deletedBy || '').trim()
  const reason = String(req.query.reason || '').trim()
  const rows = (await Promise.all(requestedTypes.map(async (type) => {
    const config = TYPES[type]
    const where = { deletedAt: { not: null } }
    if (start || end) where.deletedAt = { not: null, ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) }
    if (deletedBy) where.deletedBy = deletedBy
    if (reason) where.deleteReason = { contains: reason, mode: 'insensitive' }
    const found = await prisma[config.delegate].findMany({ where, ...(config.include ? { include: config.include } : {}), orderBy: { deletedAt: 'desc' }, take: 500 })
    return found.map((row) => publicSummary(type, row))
  }))).flat().sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)).slice(0, 500)
  res.json({ rows })
}))

developerSafeDeleteRouter.get('/developer-sensitive-records/:type/:id', wrap(async (req, res) => {
  requireDeveloper(req.user)
  const row = await findRecord(req.params.type, req.params.id)
  if (!row?.deletedAt) throw bad('已删除记录不存在', 404)
  const audits = await prisma.sensitiveRecordAudit.findMany({ where: { recordType: req.params.type, recordId: req.params.id }, orderBy: { createdAt: 'asc' } })
  res.json({ record: detailFor(req.params.type, row), audits })
}))
