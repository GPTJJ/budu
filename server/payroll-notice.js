// 工资条：开发者发放 → 员工查看签收
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { isSuperUser } from '../shared/accountPermissions.js'
import { notify } from './notification-center.js'
import {
  buildAuthoritativeIssueRows,
  findPayrollRangeOverlaps,
  loadAuthoritativePayrollRange,
  normalizeAuthoritativePeriod,
  validateClientIssueRows,
} from './payroll-authority.js'

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
    periodStart: row.periodStart ? row.periodStart.toISOString().slice(0, 10) : '',
    periodEnd: row.periodEnd ? row.periodEnd.toISOString().slice(0, 10) : '',
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
    ? `${row.periodStart.toISOString().slice(0, 10)} ～ ${row.periodEnd.toISOString().slice(0, 10)}`
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

payrollNoticeRouter.post('/payroll-notices/preflight', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw httpError('仅开发者/管理员/财务可检查工资发放', 403)
  const period = normalizeAuthoritativePeriod(req.body || {})
  const employeeIds = Array.isArray(req.body?.employeeIds)
    ? [...new Set(req.body.employeeIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : []
  if (employeeIds.length < 1 || employeeIds.length > 200) throw httpError('请提供 1-200 名员工')
  const authority = await loadAuthoritativePayrollRange(prisma, period)
  const overlaps = await findPayrollRangeOverlaps(prisma, period, employeeIds)
  const overlapById = new Map()
  for (const overlap of overlaps) {
    const rows = overlapById.get(overlap.employeeId) || []
    rows.push(overlap)
    overlapById.set(overlap.employeeId, rows)
  }
  const rows = employeeIds.map((employeeId) => {
    try {
      const row = buildAuthoritativeIssueRows(authority, [employeeId])[0]
      const employeeOverlaps = overlapById.get(employeeId) || []
      return {
        employeeId,
        issueReady: employeeOverlaps.length === 0,
        totalCents: row.totalCents,
        blockers: employeeOverlaps.length > 0 ? ['OVERLAPPING_PAYROLL_NOTICE'] : [],
        overlaps: employeeOverlaps,
      }
    } catch (error) {
      return { employeeId, issueReady: false, totalCents: null, blockers: [error.code || 'PAYROLL_NOT_READY'], overlaps: overlapById.get(employeeId) || [] }
    }
  })
  res.json({ ok: true, period, calculationReady: authority.result.calculationReady, rows })
}))

payrollNoticeRouter.post('/payroll-notices', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!isSuperUser(req.user)) throw httpError('仅开发者/管理员/财务可发放工资条', 403)
  const period = normalizeAuthoritativePeriod(req.body || {})
  const rows = req.body?.rows
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) throw httpError('请至少选择 1 名员工（最多 200 名）')
  const employeeIds = rows.map((row) => String(row?.employeeId || '').trim())
  if (employeeIds.some((id) => !id || id.length > 100) || new Set(employeeIds).size !== employeeIds.length) {
    throw httpError('员工 ID 缺失或重复')
  }

  const runTransaction = () => prisma.$transaction(async (tx) => {
    // Per-Employee advisory locks serialize same/overlapping range issuance.
    for (const employeeId of [...employeeIds].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))`
    }
    const authority = await loadAuthoritativePayrollRange(tx, period)
    const authoritativeRows = buildAuthoritativeIssueRows(authority, employeeIds)
    validateClientIssueRows(authoritativeRows, rows)
    const overlaps = await findPayrollRangeOverlaps(tx, period, employeeIds)
    if (overlaps.length > 0) {
      const names = [...new Set(overlaps.map((row) => row.employeeName || row.employeeId))].join('、')
      const error = httpError(`「${names}」存在重复或重叠工资条`, 409)
      error.code = 'OVERLAPPING_PAYROLL_NOTICE'
      error.overlaps = overlaps
      throw error
    }
    const created = []
    for (const row of authoritativeRows) {
      created.push(await tx.payrollNotice.create({
        data: {
          id: `pn-${crypto.randomUUID()}`,
          periodType: period.periodType,
          periodKey: period.periodKey,
          periodStart: new Date(`${period.periodStart}T00:00:00.000Z`),
          periodEnd: new Date(`${period.periodEnd}T00:00:00.000Z`),
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          storeKey: row.storeKey,
          targetUsername: row.targetUsername,
          snapshot: row.snapshot,
          totalCents: BigInt(row.totalCents),
          status: 'pending',
          createdBy: req.user.username,
        },
      }))
    }
    return created
  }, { isolationLevel: 'Serializable' })

  let created
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      created = await runTransaction()
      break
    } catch (error) {
      if (error.code !== 'P2034' || attempt === 3) throw error
    }
  }

  // Notifications are emitted only after the atomic DB transaction commits.
  for (const row of created) {
    const periodDisplay = periodText(row)
    const total = (Number(row.totalCents) / 100).toFixed(2)
    if (row.targetUsername) {
      notify({
        username: row.targetUsername,
        templateKey: 'payroll_pending',
        data: { employeeName: row.employeeName, period: periodDisplay, amount: total },
        priority: 'high',
        target: 'staff-payroll',
        refType: 'payroll',
        refId: row.id,
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
