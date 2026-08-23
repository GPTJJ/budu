// 门店排班（Data Authority DA-3：PostgreSQL 唯一读写权威；KV schedules 仅迁移源/只读存档）
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { isSuperUser } from '../shared/accountPermissions.js'

export const scheduleRouter = Router()

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('[schedule]', err)
    res.status(status).json({ error: err.message || '服务器错误' })
  }
}

function canStore(user, storeKey) {
  if (isSuperUser(user)) return true
  if (user.role === 'cashier' || user.role === 'public') return false
  const keys = Array.isArray(user.storeKeys) ? user.storeKeys : []
  return keys.includes(storeKey)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function normalizeShifts(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw httpError('班次格式不正确')
  if (raw.length > 50) throw httpError('单日班次过多（最多 50 个）')
  const seen = new Set()
  return raw.map((s, i) => {
    const staff = String((s && s.staff) || '').trim().slice(0, 30)
    if (!staff) throw httpError(`第 ${i + 1} 个班次缺少员工姓名`)
    if (seen.has(staff)) throw httpError(`「${staff}」当日重复排班`)
    seen.add(staff)
    return {
      staff,
      time: String((s && s.time) || '').trim().slice(0, 20),
      note: String((s && s.note) || '').trim().slice(0, 100),
    }
  })
}

/** 读取某周排班（按周返回全部门店；store 可选过滤） */
scheduleRouter.get('/schedules', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const weekStart = String(req.query.weekStart || '')
  const store = String(req.query.store || '')
  if (!DATE_RE.test(weekStart)) throw httpError('周起始日期格式不正确')
  if (store && !canStore(req.user, store)) throw httpError('无权限', 403)
  const where = { weekStart }
  if (store) where.storeKey = store
  else if (!isSuperUser(req.user) && req.user.role !== 'manager') {
    // 员工仅可查看绑定门店
    const keys = Array.isArray(req.user.storeKeys) ? req.user.storeKeys : []
    where.storeKey = { in: keys }
  }
  const rows = await prisma.schedule.findMany({ where, orderBy: [{ storeKey: 'asc' }, { date: 'asc' }] })
  res.json({
    ok: true,
    rows: rows.map((r) => ({ id: r.id, weekStart: r.weekStart, storeKey: r.storeKey, date: r.date, shifts: r.shifts, updatedAt: r.updatedAt })),
  })
}))

/** 保存某门店某周排班（整周替换：缺失日期视为清空） */
scheduleRouter.put('/schedules', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user.role === 'cashier' || req.user.role === 'public') throw httpError('无权限', 403)
  const weekStart = String((req.body || {}).weekStart || '')
  const storeKey = String((req.body || {}).storeKey || '')
  const days = (req.body || {}).days && typeof (req.body || {}).days === 'object' ? (req.body || {}).days : {}
  if (!DATE_RE.test(weekStart)) throw httpError('周起始日期格式不正确')
  if (!storeKey || storeKey.length > 30) throw httpError('门店不正确')
  if (!canStore(req.user, storeKey)) throw httpError('无权限', 403)
  if (Object.keys(days).length > 7) throw httpError('一周最多 7 天')
  // 校验日期必须在本周内（weekStart ~ weekStart+6）
  const ws = new Date(`${weekStart}T00:00:00Z`)
  const payloads = []
  for (const [date, raw] of Object.entries(days)) {
    if (!DATE_RE.test(date)) throw httpError(`日期格式不正确：${date}`)
    const d = new Date(`${date}T00:00:00Z`)
    const diff = (d - ws) / 86400000
    if (diff < 0 || diff > 6) throw httpError(`日期不在本周范围内：${date}`)
    payloads.push({ date, shifts: normalizeShifts(raw) })
  }
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.schedule.deleteMany({ where: { weekStart, storeKey } })
    for (const p of payloads) {
      if (p.shifts.length === 0) continue
      await tx.schedule.create({
        data: {
          id: `sc-${crypto.randomUUID()}`,
          weekStart,
          storeKey,
          date: p.date,
          shifts: p.shifts,
          updatedAt: now,
        },
      })
    }
  })
  res.json({ ok: true, count: payloads.filter((p) => p.shifts.length > 0).length })
}))
