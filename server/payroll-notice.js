// 工资条：开发者发放 → 员工查看签收
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { isSuperUser } from '../shared/accountPermissions.js'
import { notify } from './notification-center.js'

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
    employeeId: row.employeeId || '',
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
    recalledAt: row.recalledAt,
    recalledBy: row.recalledBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

/** 周期文案（通知用）：'2026-08' → 2026年8月；周/自定义 → '2026-08-10 ~ 2026-08-16' */
function periodText(row) {
  return row.periodType === 'week' || row.periodType === 'custom'
    ? String(row.periodKey).replace('~', ' ~ ')
    : `${row.periodKey.slice(0, 4)}年${Number(row.periodKey.slice(5, 7))}月`
}

/** 查看范围：开发者全量；staff 按 Employee.id 本人；店长保留既有本人兼容范围。 */
function noticeWhere(user, query = {}) {
  const where = {}
  if (isSuperUser(user)) {
    // 开发者/管理员/财务全量
  } else if (user.role === 'staff') {
    // 普通员工 fail closed：只认认证账号的稳定 Employee.id，不回退 staffKey/name/username。
    where.employeeId = String(user.employeeId || '').trim() || '__unbound__'
  } else {
    // 店长等既有非 self-only 角色保持原产品范围。
    where.OR = []
    if (user.staffKey) where.OR.push({ storeKey: user.staffKey.split('::')[0] || '__none__', employeeName: user.staffKey.split('::')[1] || '__none__' })
    where.OR.push({ targetUsername: user.username })
  }
  if (query.periodType) where.periodType = String(query.periodType)
  if (query.periodKey) where.periodKey = String(query.periodKey)
  if (query.status) where.status = String(query.status)
  if (query.employeeName) where.employeeName = String(query.employeeName).trim().slice(0, 50)
  return where
}

payrollNoticeRouter.get('/payroll-notices', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const where = noticeWhere(req.user, req.query)
  // 已删除的工资条不再展示（撤回的仍可见，便于追溯）
  where.status = req.query.status ? String(req.query.status) : { not: 'deleted' }
  const rows = await prisma.payrollNotice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  res.json({ ok: true, rows: rows.map(serialize) })
}))

payrollNoticeRouter.post('/payroll-notices', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw httpError('仅开发者/管理员/财务可发放工资条', 403)
  const { periodType, periodKey, rows } = req.body || {}
  const ptype = String(periodType || '')
  if (!['month', 'week', 'custom'].includes(ptype)) throw httpError('发放周期类型不正确')
  const periodRe = ptype === 'custom' ? /^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}(-\d{2})?$/
  if (!periodRe.test(String(periodKey || ''))) throw httpError('发放周期不正确')
  if (ptype === 'custom') {
    const [st, en] = String(periodKey).split('~')
    if (st > en) throw httpError('周期开始不能晚于周期结束')
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) throw httpError('请至少选择 1 名员工（最多 200 名）')

  const seen = new Set()
  const payloads = []
  for (const row of rows) {
    const employeeName = String(row?.employeeName || '').trim().slice(0, 50)
    const storeKey = String(row?.storeKey || '').trim().slice(0, 30)
    const employeeId = row?.employeeId == null ? null : String(row.employeeId).trim()
    const snapshot = row?.snapshot
    const totalCents = Number(row?.totalCents)
    if (!employeeName || !storeKey) throw httpError('员工信息不完整')
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.days) || !snapshot.summary) {
      throw httpError(`「${employeeName}」工资条数据不完整`)
    }
    if (!Number.isInteger(totalCents) || totalCents < 0) throw httpError(`「${employeeName}」工资金额不正确`)
    // Gate 18：稳定发放必须携带 Employee.id 主体；payload 内按 employeeId 判重
    if (!employeeId) throw httpError(`「${employeeName}」缺少稳定员工 ID，无法发放`)
    if (employeeId.length > 100) throw httpError('员工 ID 不正确')
    const dupKey = `${employeeId}::${ptype}::${periodKey}`
    if (seen.has(dupKey)) throw httpError(`「${employeeName}」重复选择`)
    seen.add(dupKey)
    payloads.push({ employeeId, employeeName, storeKey, snapshot, totalCents })
  }

  // Gate 18：主体存在性 + 收件人解析（唯一 User.employeeId 匹配，fail closed，绝不按姓名/staffKey 兜底）
  const empIds = [...new Set(payloads.map((r) => r.employeeId))]
  const employees = await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true } })
  const empById = new Map(employees.map((e) => [e.id, e]))
  const users = await prisma.user.findMany({
    where: { employeeId: { in: empIds }, status: 'active' },
    select: { username: true, employeeId: true, status: true },
  })
  const usersByEmpId = new Map()
  for (const u of users) {
    if (!u.employeeId) continue
    const list = usersByEmpId.get(u.employeeId) || []
    list.push(u)
    usersByEmpId.set(u.employeeId, list)
  }
  const resolved = []
  for (const r of payloads) {
    const emp = empById.get(r.employeeId)
    if (!emp) throw httpError('员工不存在', 400)
    const candidates = usersByEmpId.get(r.employeeId) || []
    if (candidates.length === 0) {
      throw httpError(`「${r.employeeName}」未绑定可接收工资条的账号`, 409)
    }
    if (candidates.length > 1) {
      throw httpError(`「${r.employeeName}」存在多个绑定账号，无法确定收件人，请联系开发者处理`, 409)
    }
    resolved.push({ ...r, targetUsername: candidates[0].username })
  }

  // 同员工同周期重复发放 → 409（已撤回/已删除的工资条不占用周期，可重新发放修正）
  const existing = await prisma.payrollNotice.findMany({
    where: { periodType: ptype, periodKey, status: { notIn: ['recalled', 'deleted'] } },
    select: { id: true, employeeId: true, employeeName: true, storeKey: true },
  })
  const stableExisted = new Set(existing.filter((r) => r.employeeId).map((r) => r.employeeId))
  const dup = resolved.filter((r) => stableExisted.has(r.employeeId))
  if (dup.length) {
    return res.status(409).json({ error: `「${dup.map((r) => r.employeeName).join('、')}」该周期工资条已发放` })
  }

  const created = []
  for (const r of resolved) {
    const row = await prisma.payrollNotice.create({
      data: {
        id: `pn-${crypto.randomUUID()}`,
        periodType: ptype,
        periodKey: String(periodKey),
        employeeId: r.employeeId,
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
  // 通知中心：发放工资条 → 员工站内消息 + 微信提醒（待签收）
  for (const r of created) {
    const period = periodText(r)
    const total = (Number(r.totalCents) / 100).toFixed(2)
    if (r.targetUsername) {
      notify({
        username: r.targetUsername,
        templateKey: 'payroll_pending',
        data: { employeeName: r.employeeName, period, amount: total },
        priority: 'high',
        target: 'staff-payroll',
        refType: 'payroll',
        refId: r.id,
        ack: true,
      }).catch(() => {})
    }
  }
  res.json({ ok: true, count: created.length, rows: created.map(serialize) })
}))

payrollNoticeRouter.post('/payroll-notices/:id/confirm', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user.role === 'public' || req.user.role === 'cashier') throw httpError('无权限', 403)
  const row = await prisma.payrollNotice.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('工资条不存在', 404)
  // staff 仅按稳定 Employee.id 签收；店长保留既有本人兼容路径；最高业务权限可代签。
  const staffOwns = req.user.role === 'staff' && Boolean(req.user.employeeId) && row.employeeId === req.user.employeeId
  const managerOwns = req.user.role === 'manager' && (
    row.targetUsername === req.user.username ||
    (row.storeKey === (req.user.staffKey || '').split('::')[0] && row.employeeName === (req.user.staffKey || '').split('::')[1])
  )
  const isOwner =
    staffOwns ||
    managerOwns ||
    isSuperUser(req.user)
  if (!isOwner) throw httpError('无权签收该工资条', 403)
  if (row.status === 'recalled' || row.status === 'deleted') {
    throw httpError(row.status === 'recalled' ? '该工资条已被撤回，无法签收' : '该工资条已被删除', 400)
  }
  if (row.status === 'confirmed') {
    return res.json({ ok: true, row: serialize(row) })
  }
  const updated = await prisma.payrollNotice.update({
    where: { id: row.id },
    data: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: req.user.username },
  })
  // 通知中心：签收留痕通知发放人（开发者/管理员/财务）
  const period = periodText(row)
  if (row.createdBy) {
    notify({
      username: row.createdBy,
      templateKey: 'payroll_confirmed',
      data: {
        employeeName: row.employeeName,
        period,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
      },
      target: 'staff-payroll',
      refType: 'payroll',
      refId: row.id,
    }).catch(() => {})
  }
  res.json({ ok: true, row: serialize(updated) })
}))

/** 撤回工资条：仅开发者/管理员/财务；已签收的不可撤回（避免签收留痕被抹掉） */
payrollNoticeRouter.post('/payroll-notices/:id/recall', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw httpError('仅开发者/管理员/财务可撤回工资条', 403)
  const row = await prisma.payrollNotice.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('工资条不存在', 404)
  if (row.status === 'confirmed') throw httpError('该工资条已被员工签收，无法撤回', 409)
  if (row.status === 'recalled') throw httpError('该工资条已撤回', 400)
  if (row.status === 'deleted') throw httpError('该工资条已删除', 400)
  const updated = await prisma.payrollNotice.update({
    where: { id: row.id },
    data: { status: 'recalled', recalledAt: new Date(), recalledBy: req.user.username },
  })
  // 通知员工：工资条已撤回
  if (row.targetUsername) {
    notify({
      username: row.targetUsername,
      templateKey: 'payroll_recalled',
      data: { employeeName: row.employeeName, period: periodText(row) },
      priority: 'high',
      target: 'staff-payroll',
      refType: 'payroll',
      refId: row.id,
    }).catch(() => {})
  }
  res.json({ ok: true, row: serialize(updated) })
}))

/** 删除工资条（软删除）：仅开发者/管理员/财务；删除后同周期可重新发放 */
payrollNoticeRouter.post('/payroll-notices/:id/delete', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw httpError('仅开发者/管理员/财务可删除工资条', 403)
  const row = await prisma.payrollNotice.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('工资条不存在', 404)
  if (row.status === 'deleted') throw httpError('该工资条已删除', 400)
  const updated = await prisma.payrollNotice.update({
    where: { id: row.id },
    data: { status: 'deleted', deletedAt: new Date(), deletedBy: req.user.username },
  })
  // 通知员工：工资条记录已删除
  if (row.targetUsername) {
    notify({
      username: row.targetUsername,
      templateKey: 'payroll_deleted',
      data: { employeeName: row.employeeName, period: periodText(row) },
      priority: 'normal',
      target: 'staff-payroll',
      refType: 'payroll',
      refId: row.id,
    }).catch(() => {})
  }
  res.json({ ok: true, row: serialize(updated) })
}))
