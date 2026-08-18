// 工资条：开发者发放 → 员工查看签收
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'

export const payrollNoticeRouter = Router()

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('[payroll-notice]', err)
    res.status(status).json({ error: err.message || '服务器错误' })
  }
}

function serialize(row) {
  return {
    id: row.id,
    periodType: row.periodType,
    periodKey: row.periodKey,
    employeeName: row.employeeName,
    storeKey: row.storeKey,
    targetUsername: row.targetUsername,
    snapshot: row.snapshot,
    totalCents: row.totalCents.toString(),
    status: row.status,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

/** 员工本人（绑定员工或 username 直配）可见自己，店长可见本店，开发者全量 */
function noticeWhere(user, query = {}) {
  const where = {}
  if (user.role === 'developer') {
    // 全量
  } else if (user.role === 'manager') {
    const stores = Array.isArray(user.storeKeys) ? user.storeKeys : []
    where.storeKey = { in: stores.length ? stores : ['__none__'] }
  } else {
    // staff：本人（按绑定员工 storeKey::name 或账号名匹配）
    where.OR = []
    if (user.staffKey) where.OR.push({ storeKey: user.staffKey.split('::')[0] || '__none__', employeeName: user.staffKey.split('::')[1] || '__none__' })
    where.OR.push({ targetUsername: user.username })
  }
  if (query.periodType) where.periodType = String(query.periodType)
  if (query.periodKey) where.periodKey = String(query.periodKey)
  if (query.status) where.status = String(query.status)
  return where
}

payrollNoticeRouter.get('/payroll-notices', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const where = noticeWhere(req.user, req.query)
  const rows = await prisma.payrollNotice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({ ok: true, rows: rows.map(serialize) })
}))

payrollNoticeRouter.post('/payroll-notices', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user.role !== 'developer') throw httpError('仅开发者可发放工资条', 403)
  const { periodType, periodKey, rows } = req.body || {}
  if (!['month', 'week'].includes(String(periodType || ''))) throw httpError('发放周期类型不正确')
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(String(periodKey || ''))) throw httpError('发放周期不正确')
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) throw httpError('请至少选择 1 名员工（最多 200 名）')

  const seen = new Set()
  const payloads = []
  for (const row of rows) {
    const employeeName = String(row?.employeeName || '').trim().slice(0, 50)
    const storeKey = String(row?.storeKey || '').trim().slice(0, 30)
    const targetUsername = String(row?.targetUsername || '').trim().slice(0, 30)
    const snapshot = row?.snapshot
    const totalCents = Number(row?.totalCents)
    if (!employeeName || !storeKey) throw httpError('员工信息不完整')
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.days) || !snapshot.summary) {
      throw httpError(`「${employeeName}」工资条数据不完整`)
    }
    if (!Number.isInteger(totalCents) || totalCents < 0) throw httpError(`「${employeeName}」工资金额不正确`)
    const dupKey = `${storeKey}::${employeeName}::${periodType}::${periodKey}`
    if (seen.has(dupKey)) throw httpError(`「${employeeName}」重复选择`)
    seen.add(dupKey)
    payloads.push({ employeeName, storeKey, targetUsername, snapshot, totalCents })
  }

  // 同员工同周期重复发放 → 409
  const existing = await prisma.payrollNotice.findMany({
    where: { periodType, periodKey },
    select: { id: true, employeeName: true, storeKey: true },
  })
  const existed = new Set(existing.map((r) => `${r.storeKey}::${r.employeeName}`))
  const dup = payloads.filter((r) => existed.has(`${r.storeKey}::${r.employeeName}`))
  if (dup.length) {
    return res.status(409).json({ error: `「${dup.map((r) => r.employeeName).join('、')}」该周期工资条已发放` })
  }

  const created = []
  for (const r of payloads) {
    const row = await prisma.payrollNotice.create({
      data: {
        id: `pn-${crypto.randomUUID()}`,
        periodType: String(periodType),
        periodKey: String(periodKey),
        employeeName: r.employeeName,
        storeKey: r.storeKey,
        targetUsername: r.targetUsername,
        snapshot: r.snapshot,
        totalCents: BigInt(r.totalCents),
        status: 'pending',
        createdBy: req.user.username,
      },
    })
    created.push(row)
  }
  res.json({ ok: true, count: created.length, rows: created.map(serialize) })
}))

payrollNoticeRouter.post('/payroll-notices/:id/confirm', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user.role === 'public' || req.user.role === 'cashier') throw httpError('无权限', 403)
  const row = await prisma.payrollNotice.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('工资条不存在', 404)
  const isOwner =
    row.targetUsername === req.user.username ||
    (req.user.role === 'staff' && row.storeKey === (req.user.staffKey || '').split('::')[0] && row.employeeName === (req.user.staffKey || '').split('::')[1]) ||
    req.user.role === 'developer' ||
    req.user.role === 'manager'
  if (!isOwner) throw httpError('无权签收该工资条', 403)
  if (row.status === 'confirmed') {
    return res.json({ ok: true, row: serialize(row) })
  }
  const updated = await prisma.payrollNotice.update({
    where: { id: row.id },
    data: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: req.user.username },
  })
  res.json({ ok: true, row: serialize(updated) })
}))
