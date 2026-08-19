// 通知中心 API：站内消息列表 / 未读数 / 已读 / 删除 / 签收 / 模板
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { ensureNotificationTemplates } from './notification-center.js'

export const notificationRouter = Router()

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('[notifications]', err)
    res.status(status).json({ error: err.message || '服务器错误' })
  }
}

function serialize(row) {
  return {
    id: row.id,
    templateKey: row.templateKey,
    title: row.title,
    content: row.content,
    priority: row.priority,
    status: row.status,
    ackStatus: row.ackStatus,
    ackAt: row.ackAt,
    ackBy: row.ackBy,
    target: row.target,
    refType: row.refType,
    refId: row.refId,
    readAt: row.readAt,
    createdAt: row.createdAt,
  }
}

/** 消息列表（分页；默认不含已删除；支持 status/unread 筛选） */
notificationRouter.get('/notifications', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const user = req.user
  if (user.role === 'public' || user.role === 'cashier') throw httpError('无权限', 403)
  const { status, unread, priority, type, limit = 50, cursor } = req.query
  const where = { username: user.username, status: { not: 'deleted' } }
  if (status && ['unread', 'read'].includes(String(status))) where.status = String(status)
  if (unread === '1') where.status = 'unread'
  if (priority && ['high', 'normal', 'low'].includes(String(priority))) where.priority = String(priority)
  if (type) where.refType = String(type)
  if (cursor) where.createdAt = { lt: new Date(String(cursor)) }
  const rows = await prisma.notification.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Number(limit) || 50, 200),
  })
  res.json({ ok: true, rows: rows.map(serialize), nextCursor: rows.length >= Number(limit) ? rows[rows.length - 1].createdAt.toISOString() : null })
}))

/** 未读数 */
notificationRouter.get('/notifications/unread-count', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user.role === 'public' || req.user.role === 'cashier') {
    return res.json({ ok: true, count: 0 })
  }
  const count = await prisma.notification.count({
    where: { username: req.user.username, status: 'unread' },
  })
  res.json({ ok: true, count })
}))

/** 标记已读（单条 / 全部） */
notificationRouter.post('/notifications/read', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const body = req.body || {}
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : []
  if (body.all === true) {
    await prisma.notification.updateMany({
      where: { username: req.user.username, status: 'unread' },
      data: { status: 'read', readAt: new Date() },
    })
  } else if (ids.length) {
    await prisma.notification.updateMany({
      where: { id: { in: ids }, username: req.user.username },
      data: { status: 'read', readAt: new Date() },
    })
  }
  res.json({ ok: true })
}))

/** 删除（软删） */
notificationRouter.delete('/notifications/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  await prisma.notification.updateMany({
    where: { id: req.params.id, username: req.user.username },
    data: { status: 'deleted', deletedAt: new Date() },
  })
  res.json({ ok: true })
}))

/** 签收（工资条等 ack 消息） */
notificationRouter.post('/notifications/:id/ack', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const row = await prisma.notification.findUnique({ where: { id: req.params.id } })
  if (!row || row.username !== req.user.username) throw httpError('消息不存在', 404)
  if (row.ackStatus === 'confirmed') {
    return res.json({ ok: true, row: serialize(row) })
  }
  const updated = await prisma.notification.update({
    where: { id: row.id },
    data: { ackStatus: 'confirmed', ackAt: new Date(), ackBy: req.user.username, status: 'read', readAt: new Date() },
  })
  res.json({ ok: true, row: serialize(updated) })
}))

/** 模板列表 */
notificationRouter.get('/notifications/templates', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  await ensureNotificationTemplates()
  const rows = await prisma.notificationTemplate.findMany({ where: { active: true }, orderBy: { key: 'asc' } })
  res.json({ ok: true, rows: rows.map((t) => ({ key: t.key, name: t.name, description: t.description, target: t.target, defaultPriority: t.defaultPriority })) })
}))
