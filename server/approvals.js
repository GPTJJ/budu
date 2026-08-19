// 审批中心 API（通用审批引擎）：
// 模板 / 单据（草稿·提交·撤回·审批·归档）/ 附件 / 抄送 / 意见 / 日志 / 站内通知
// 一期模板：工资审批（payroll）、报销审批（expense）；审批人=developer（老板），抄送=财务+相关人
// 通知 channel 预留 wechat/wecom（二期接入 server/wechat-alert.js）
import { Router } from 'express'
import crypto from 'node:crypto'
import { prisma, dbReady } from './pg.js'
import { isSuperUser } from '../shared/accountPermissions.js'
import { loadDb } from './store.js'
import { notify } from './notification-center.js'
import { httpError } from './pos-core.js'
import { storeAssetData, readAssetData, assetObjectKey } from './asset-storage.js'
import {
  canViewRequest,
  canCreate,
  canEdit,
  canSubmit,
  canWithdraw,
  canDecide,
  canArchive,
  canDelete,
  isApproverFor,
  isSubmitter,
  validateFormData,
  resolveCcUsers,
  genRequestNo,
} from './approvals-core.js'

export const approvalRouter = Router()

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('[approvals]', err)
    res.status(status).json({ error: err.message || '服务器错误' })
  }
}

const MAX_ATTACH_SIZE = 8 * 1024 * 1024 // 8MB
const ALLOWED_MIME = /^(image\/(png|jpe?g|webp|gif)|application\/pdf|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel)$/

function text(value, max, label, required = false) {
  const out = String(value ?? '').trim()
  if (required && !out) throw httpError(`${label}不能为空`)
  if (out.length > max) throw httpError(`${label}长度不能超过 ${max} 字符`)
  return out
}

function validDataUrl(value) {
  const dataUrl = String(value ?? '')
  if (!/^data:([^;,]+);base64,[A-Za-z0-9+/=\s]+$/.test(dataUrl)) throw httpError('附件数据格式不正确')
  return dataUrl
}

function decodeSize(dataUrl) {
  try {
    return Buffer.from(String(dataUrl).split(',')[1] || '', 'base64').length
  } catch {
    return 0
  }
}

/** 内置模板（启动时 ensure，可随时调整 schema 无需新迁移） */
export async function ensureApprovalTemplates() {
  if (!dbReady()) return
  const now = new Date()
  const templates = [
    {
      key: 'payroll',
      name: '工资审批',
      description: '员工工资发放审批：提交人到老板审批，通过后自动抄送财务与员工',
      sort: 1,
      schema: [
        { key: 'periodStart', label: '周期开始', type: 'date', required: true },
        { key: 'periodEnd', label: '周期结束', type: 'date', required: true },
        { key: 'store', label: '门店', type: 'store', required: true },
        { key: 'employee', label: '员工', type: 'employee', required: true },
        { key: 'grossPay', label: '应发（元）', type: 'money', required: true },
        { key: 'socialSecurity', label: '社保（元）', type: 'money' },
        { key: 'incomeTax', label: '个税（元）', type: 'money' },
        { key: 'netPay', label: '实发（元）', type: 'money', required: true, amount: true },
        { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 },
      ],
      approverRule: { type: 'role', role: 'admin' },
      ccRule: [
        { type: 'submitter' },
        { type: 'role', role: 'finance' },
      ],
    },
    {
      key: 'expense',
      name: '报销审批',
      description: '费用报销审批：员工提交到老板审批，通过后抄送财务与提交人',
      sort: 2,
      schema: [
        {
          key: 'expenseType',
          label: '报销类型',
          type: 'select',
          required: true,
          options: ['餐饮', '交通', '办公', '物料', '其他'],
        },
        { key: 'amount', label: '金额（元）', type: 'money', required: true, amount: true },
        { key: 'occurredDate', label: '发生日期', type: 'date', required: true },
        { key: 'remark', label: '备注', type: 'textarea', maxLength: 500 },
      ],
      approverRule: { type: 'role', role: 'admin' },
      ccRule: [
        { type: 'submitter' },
        { type: 'role', role: 'finance' },
      ],
    },
  ]
  for (const t of templates) {
    const exists = await prisma.approvalTemplate.findUnique({ where: { key: t.key } })
    if (exists) {
      await prisma.approvalTemplate.update({
        where: { key: t.key },
        data: { name: t.name, description: t.description, schema: t.schema, approverRule: t.approverRule, ccRule: t.ccRule, active: true, sort: t.sort, updatedAt: now },
      })
    } else {
      await prisma.approvalTemplate.create({ data: { ...t, createdAt: now, updatedAt: now } })
    }
  }
}

/** 用户上下文：角色用户列表 + 员工绑定账号映射（来源 KV 共享数据） */
async function userCtx() {
  const db = await loadDb()
  const users = Array.isArray(db.users) ? db.users : []
  const roleUsers = {}
  const staffKeyMap = {}
  for (const u of users) {
    const name = u.displayName || u.username
    roleUsers[u.role] = roleUsers[u.role] || []
    roleUsers[u.role].push({ username: u.username, name })
    if (u.staffKey) staffKeyMap[u.staffKey] = { username: u.username, name }
  }
  return { users, roleUsers, staffKeyMap }
}

/** 模板的审批人列表：role=admin → 全部管理员；若该角色无账号则回退开发者（保证流程可跑） */
function approverUsernames(template, roleUsers) {
  const rule = template?.approverRule || {}
  if (rule.type === 'username') return [rule.username]
  if (rule.type === 'role') {
    const names = (roleUsers[rule.role] || []).map((u) => u.username)
    if (names.length > 0) return names
    // 回退：超管角色（开发者/财务/管理员）任意一个
    for (const fallback of ['developer', 'finance', 'admin']) {
      const fb = (roleUsers[fallback] || []).map((u) => u.username)
      if (fb.length > 0) return fb
    }
    return []
  }
  return []
}

function serialize(row) {
  return {
    id: row.id,
    requestNo: row.requestNo,
    templateKey: row.templateKey,
    title: row.title,
    status: row.status,
    formData: row.formData,
    amountCents: row.amountCents.toString(),
    submitterUsername: row.submitterUsername,
    submitterName: row.submitterName,
    approvedAt: row.approvedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ---------------- 模板 ----------------
approvalRouter.get('/approvals/templates', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const rows = await prisma.approvalTemplate.findMany({ where: { active: true }, orderBy: { sort: 'asc' } })
  res.json({ ok: true, rows: rows.map((t) => ({ key: t.key, name: t.name, description: t.description, schema: t.schema, approverRule: t.approverRule, ccRule: t.ccRule })) })
}))

/** 可抄送账号候选（非公开/收银账号；用于表单「添加抄送人」） */
approvalRouter.get('/approvals/cc-candidates', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!canCreate(req.user)) throw httpError('无权限', 403)
  const db = await loadDb()
  const users = (Array.isArray(db.users) ? db.users : []).filter(
    (u) => u.role !== 'public' && u.role !== 'cashier',
  )
  res.json({
    ok: true,
    rows: users.map((u) => ({ username: u.username, role: u.role, name: u.displayName || u.username })),
  })
}))

/** 校验额外抄送人账号列表（去重；仅保留存在的非公开/收银账号） */
async function validateCcUsernames(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return []
  const db = await loadDb()
  const users = Array.isArray(db.users) ? db.users : []
  const seen = new Set()
  const out = []
  for (const name of rawList.slice(0, 20)) {
    const uname = String(name || '').trim().slice(0, 30)
    if (!uname || seen.has(uname)) continue
    const u = users.find((x) => x.username === uname)
    if (!u) throw httpError(`抄送账号「${uname}」不存在`)
    if (u.role === 'public' || u.role === 'cashier') throw httpError(`「${uname}」不可作为抄送人`)
    seen.add(uname)
    out.push(uname)
  }
  return out
}

/** 抄送人集合：规则（提交人+财务等）+ 额外手动添加，返回 Map(username → name) */
async function ccNamesOf(template, submitterUsername, submitterName, formData, extraCc, ctx) {
  const ccUsers = resolveCcUsers(template.ccRule, {
    roleUsers: ctx.roleUsers,
    submitter: { username: submitterUsername, name: submitterName },
    formData: formData || {},
    staffKeyMap: ctx.staffKeyMap,
  })
  const ccNames = new Map()
  for (const u of ccUsers) ccNames.set(u.username, u.name || u.username)
  const nameByUser = new Map()
  for (const list of Object.values(ctx.roleUsers || {})) {
    for (const u of list) if (!nameByUser.has(u.username)) nameByUser.set(u.username, u.name || u.username)
  }
  for (const uname of extraCc || []) if (!ccNames.has(uname)) ccNames.set(uname, nameByUser.get(uname) || uname)
  return ccNames
}

/** 校验 payroll 周期起止日期 */
function validatePayrollPeriod(template, normalized) {
  if (template.key !== 'payroll') return
  const start = String(normalized.periodStart || '')
  const end = String(normalized.periodEnd || '')
  if (start && end && start > end) throw httpError('周期开始不能晚于周期结束')
}

// ---------------- 附件 ----------------
approvalRouter.post('/approvals/attachments', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!canCreate(req.user)) throw httpError('无权限', 403)
  const body = req.body || {}
  const name = text(body.name, 120, '附件名称', true)
  const fileType = text(body.fileType, 80, '附件类型')
  if (!ALLOWED_MIME.test(fileType)) throw httpError('仅支持图片、PDF、Excel 附件')
  const dataUrl = validDataUrl(body.dataUrl)
  const size = decodeSize(dataUrl)
  if (size <= 0) throw httpError('附件内容为空')
  if (size > MAX_ATTACH_SIZE) throw httpError('附件不能超过 8MB')
  const id = `aa-${crypto.randomUUID()}`
  const storage = await storeAssetData(dataUrl, assetObjectKey(id, 1))
  const row = await prisma.approvalAttachment.create({
    data: {
      id,
      name,
      fileType,
      fileSize: size,
      dataUrl: storage.dataUrl,
      storageProvider: storage.provider,
      storageKey: storage.storageKey,
      uploaderUsername: req.user.username,
    },
  })
  res.json({ ok: true, attachment: { id: row.id, name: row.name, fileType: row.fileType, fileSize: row.fileSize, createdAt: row.createdAt } })
}))

approvalRouter.get('/approvals/attachments/:id/download', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const row = await prisma.approvalAttachment.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('附件不存在', 404)
  if (row.requestId) {
    const request = await prisma.approvalRequest.findUnique({ where: { id: row.requestId } })
    if (!request) throw httpError('附件不存在', 404)
    const ctx = await userCtx()
    const template = await prisma.approvalTemplate.findUnique({ where: { key: request.templateKey } })
    const ccs = await prisma.approvalCc.findMany({ where: { requestId: request.id } })
    if (!canViewRequest(req.user, request, { template, ccList: ccs })) throw httpError('无权查看该附件', 403)
  } else if (row.uploaderUsername !== req.user.username && req.user.role !== 'developer') {
    throw httpError('无权查看该附件', 403)
  }
  const dataUrl = await readAssetData(row.storageProvider, row.storageKey, row.dataUrl)
  res.json({ ok: true, attachment: { id: row.id, name: row.name, fileType: row.fileType, fileSize: row.fileSize, dataUrl, createdAt: row.createdAt } })
}))

// ---------------- 单据 ----------------
/** 从表单中提取单据金额（分）：schema 中 amount:true 的字段 */
function amountFromForm(schema, formData) {
  const field = (schema || []).find((f) => f.amount === true)
  if (!field) return 0n
  const cents = Number(formData?.[field.key] || 0)
  return BigInt(Number.isSafeInteger(cents) ? cents : 0)
}

/** 生成标题（前端也可自定义，服务端兜底） */
function buildTitle(template, formData) {
  const d = formData || {}
  if (template.key === 'payroll') {
    const emp = String(d.employee || '').split('::')[1] || ''
    const start = d.periodStart || ''
    const end = d.periodEnd || ''
    return `${emp || '员工'} · ${start} ~ ${end} 工资`
  }
  if (template.key === 'expense') {
    return `${d.expenseType || '费用'}报销 ${Number(d.amount || 0) / 100} 元`
  }
  return template.name
}

approvalRouter.post('/approvals/requests', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (!canCreate(req.user)) throw httpError('无权限', 403)
  const body = req.body || {}
  const template = await prisma.approvalTemplate.findUnique({ where: { key: text(body.templateKey, 30, '模板', true) } })
  if (!template || !template.active) throw httpError('审批模板不存在或已停用')

  const { errors, normalized } = validateFormData(template.schema, body.formData)
  if (errors.length) throw httpError(`表单填写不完整：${errors[0]}`)
  validatePayrollPeriod(template, normalized)
  const extraCc = await validateCcUsernames(body.ccUsernames)
  normalized._ccUsernames = extraCc

  // 序号：当天单据数 + 1
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart.getTime() + 86400000)
  const todayCount = await prisma.approvalRequest.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } })

  const submit = body.submit === true
  const title = text(body.title || buildTitle(template, normalized), 60, '标题')
  const amountCents = amountFromForm(template.schema, normalized)
  const id = `ar-${crypto.randomUUID()}`
  const requestNo = genRequestNo(new Date(), todayCount + 1)
  const ctx = await userCtx()
  const approvers = approverUsernames(template, ctx.roleUsers)
  if (submit && approvers.length === 0) throw httpError('审批人未配置，无法提交')

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.approvalRequest.create({
      data: {
        id,
        requestNo,
        templateKey: template.key,
        title,
        status: submit ? 'pending' : 'draft',
        formData: normalized,
        amountCents,
        submitterUsername: req.user.username,
        submitterName: req.user.displayName || req.user.username,
      },
    })
    // 绑定附件
    if (Array.isArray(body.attachmentIds)) {
      const rows = await tx.approvalAttachment.findMany({ where: { id: { in: body.attachmentIds.slice(0, 10) } } })
      const seen = new Set()
      for (const aid of body.attachmentIds.slice(0, 10)) {
        if (seen.has(aid)) continue
        seen.add(aid)
        const row = rows.find((r) => r.id === aid)
        if (!row) throw httpError('附件不存在')
        if (row.requestId && row.requestId !== id) throw httpError('附件已被其他单据使用')
        if (row.uploaderUsername !== req.user.username && req.user.role !== 'developer') throw httpError('无权使用该附件')
        if (!row.requestId) await tx.approvalAttachment.update({ where: { id: row.id }, data: { requestId: id } })
      }
    }
    await tx.approvalLog.create({
      data: { id: `al-${crypto.randomUUID()}`, requestId: id, action: submit ? 'submit' : 'create', username: req.user.username, detail: submit ? '提交审批' : '创建草稿' },
    })
    if (submit) {
      for (const username of approvers) {
        await tx.approvalNode.create({
          data: { id: `an-${crypto.randomUUID()}`, requestId: id, nodeIndex: 1, approverUsername: username },
        })
        await tx.approvalNotification.create({
          data: {
            id: `anot-${crypto.randomUUID()}`,
            requestId: id,
            username,
            type: 'todo',
            title: '待你审批',
            content: `${req.user.username} 提交了${template.name}申请「${title}」`,
          },
        })
        // 通知中心（站内消息 + 微信提醒；与原通知并存，兼容零回归）
        notify({
          username,
          templateKey: 'approval_todo',
          data: { title, submitterName: req.user.displayName || req.user.username, templateName: template.name },
          priority: 'high',
          target: 'approval',
          refType: 'approval',
          refId: id,
        }).catch(() => {})
      }
      // 提交即建立抄送关系（提交人 + 财务 + 手动添加）
      const ccNames = await ccNamesOf(template, req.user.username, req.user.displayName || req.user.username, normalized, extraCc, ctx)
      for (const [uname, unameName] of ccNames) {
        await tx.approvalCc.upsert({
          where: { requestId_ccUsername: { requestId: id, ccUsername: uname } },
          create: { id: `acc-${crypto.randomUUID()}`, requestId: id, ccUsername: uname, ccName: unameName },
          update: {},
        })
      }
    }
    return request
  })
  res.json({ ok: true, request: serialize(created) })
}))

/** 详情聚合 */
async function detailOf(requestId) {
  const request = await prisma.approvalRequest.findUnique({ where: { id: requestId } })
  if (!request) throw httpError('审批单不存在', 404)
  const [template, nodes, ccs, attachments, comments, logs] = await Promise.all([
    prisma.approvalTemplate.findUnique({ where: { key: request.templateKey } }),
    prisma.approvalNode.findMany({ where: { requestId }, orderBy: { nodeIndex: 'asc' } }),
    prisma.approvalCc.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } }),
    prisma.approvalAttachment.findMany({ where: { requestId } }),
    prisma.approvalComment.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } }),
    prisma.approvalLog.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } }),
  ])
  return {
    request: serialize(request),
    template: { key: template.key, name: template.name, description: template.description, schema: template.schema, approverRule: template.approverRule },
    nodes: nodes.map((n) => ({ id: n.id, nodeIndex: n.nodeIndex, approverUsername: n.approverUsername, status: n.status, comment: n.comment, actedAt: n.actedAt })),
    ccs: ccs.map((c) => ({ id: c.id, ccUsername: c.ccUsername, ccName: c.ccName, readAt: c.readAt })),
    attachments: await Promise.all(attachments.map(async (a) => ({
      id: a.id,
      name: a.name,
      fileType: a.fileType,
      fileSize: a.fileSize,
      dataUrl: await readAssetData(a.storageProvider, a.storageKey, a.dataUrl),
      createdAt: a.createdAt,
    }))),
    comments: comments.map((c) => ({ id: c.id, username: c.username, userRole: c.userRole, content: c.content, createdAt: c.createdAt })),
    logs: logs.map((l) => ({ id: l.id, action: l.action, username: l.username, detail: l.detail, createdAt: l.createdAt })),
  }
}

approvalRouter.get('/approvals/requests', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const user = req.user
  if (user.role === 'public' || user.role === 'cashier') throw httpError('无权限', 403)
  const scope = String(req.query.scope || 'my')
  const status = String(req.query.status || '')
  const templateKey = String(req.query.template || '')
  const where = {}
  if (scope === 'my') {
    where.submitterUsername = user.username
  } else if (scope === 'todo') {
    where.status = 'pending'
    // 超管审批权一致：todo 包含所有超管级审批节点的单据
    const ctx = await userCtx()
    const approverNames = new Set([user.username])
    if (isSuperUser(user)) {
      for (const r of ['developer', 'finance', 'admin']) {
        for (const u of ctx.roleUsers[r] || []) approverNames.add(u.username)
      }
    }
    where.nodes = { some: { approverUsername: { in: [...approverNames] }, status: 'pending' } }
  } else if (scope === 'cc') {
    where.ccs = { some: { ccUsername: user.username } }
  } else if (scope === 'all') {
    // 超管（开发者/管理员/财务）查看全部；其他角色无权
    if (!isSuperUser(user)) throw httpError('无权查看全部审批', 403)
  } else {
    throw httpError('scope 不正确')
  }
  if (status && ['draft', 'pending', 'approved', 'rejected', 'withdrawn', 'archived'].includes(status)) where.status = status
  if (templateKey) where.templateKey = templateKey
  const rows = await prisma.approvalRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { template: { select: { name: true, approverRule: true } } },
  })
  // todo 兜底权限过滤（模板规则变化时防御）
  let list = rows
  if (scope === 'todo') {
    const ctx = await userCtx()
    list = rows.filter((r) => isApproverFor(user, r, r.template))
  }
  res.json({
    ok: true,
    rows: list.map((r) => ({
      id: r.id,
      requestNo: r.requestNo,
      templateKey: r.templateKey,
      templateName: r.template?.name || r.templateKey,
      title: r.title,
      status: r.status,
      amountCents: r.amountCents.toString(),
      submitterUsername: r.submitterUsername,
      submitterName: r.submitterName,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  })
}))

approvalRouter.get('/approvals/requests/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const detail = await detailOf(req.params.id)
  if (!canViewRequest(req.user, detail.request, { template: detail.template, ccList: detail.ccs })) {
    throw httpError('无权查看该审批单', 403)
  }
  res.json({ ok: true, ...detail })
}))

/** 编辑：草稿 或 驳回后重新提交（仅表单与附件） */
approvalRouter.put('/approvals/requests/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('审批单不存在', 404)
  if (!canEdit(req.user, request)) throw httpError('仅草稿或已驳回单据可编辑', 403)
  const body = req.body || {}
  const template = await prisma.approvalTemplate.findUnique({ where: { key: request.templateKey } })
  const { errors, normalized } = validateFormData(template.schema, body.formData || request.formData)
  if (errors.length) throw httpError(`表单填写不完整：${errors[0]}`)
  validatePayrollPeriod(template, normalized)
  const extraCc = body.ccUsernames !== undefined ? await validateCcUsernames(body.ccUsernames) : (request.formData?._ccUsernames || [])
  normalized._ccUsernames = extraCc
  const title = text(body.title || request.title, 60, '标题')
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({
      where: { id: request.id },
      data: { formData: normalized, title, amountCents: amountFromForm(template.schema, normalized) },
    })
    if (Array.isArray(body.attachmentIds)) {
      const rows = await tx.approvalAttachment.findMany({ where: { id: { in: body.attachmentIds.slice(0, 10) } } })
      const seen = new Set()
      for (const aid of body.attachmentIds.slice(0, 10)) {
        if (seen.has(aid)) continue
        seen.add(aid)
        const row = rows.find((r) => r.id === aid)
        if (!row) throw httpError('附件不存在')
        if (row.requestId && row.requestId !== request.id) throw httpError('附件已被其他单据使用')
        if (row.uploaderUsername !== req.user.username && req.user.role !== 'developer') throw httpError('无权使用该附件')
        if (!row.requestId) await tx.approvalAttachment.update({ where: { id: row.id }, data: { requestId: request.id } })
      }
    }
    await tx.approvalLog.create({ data: { id: `al-${crypto.randomUUID()}`, requestId: request.id, action: 'edit', username: req.user.username, detail: '编辑单据' } })
  })
  res.json({ ok: true, request: serialize(await prisma.approvalRequest.findUnique({ where: { id: request.id } })) })
}))

/** 提交（草稿提交 / 驳回后重新提交） */
approvalRouter.post('/approvals/requests/:id/submit', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('审批单不存在', 404)
  if (!canSubmit(req.user, request)) throw httpError('当前状态不可提交', 403)
  const template = await prisma.approvalTemplate.findUnique({ where: { key: request.templateKey } })
  const ctx = await userCtx()
  const approvers = approverUsernames(template, ctx.roleUsers)
  if (approvers.length === 0) throw httpError('审批人未配置，无法提交')
  const wasRejected = request.status === 'rejected'
  // 额外抄送人：优先使用本次提交携带的，否则沿用草稿已保存的
  const bodyCc = req.body && Array.isArray(req.body.ccUsernames) ? await validateCcUsernames(req.body.ccUsernames) : null
  const extraCc = bodyCc !== null ? bodyCc : (request.formData?._ccUsernames || [])
  // 规则抄送人（提交人 + 财务）+ 额外抄送人
  const ccNames = await ccNamesOf(template, request.submitterUsername, request.submitterName, request.formData, extraCc, ctx)
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({ where: { id: request.id }, data: { status: 'pending', approvedAt: null, archivedAt: null } })
    for (const username of approvers) {
      await tx.approvalNode.create({
        data: { id: `an-${crypto.randomUUID()}`, requestId: request.id, nodeIndex: 1, approverUsername: username },
      })
      await tx.approvalNotification.create({
        data: {
          id: `anot-${crypto.randomUUID()}`,
          requestId: request.id,
          username,
          type: 'todo',
          title: '待你审批',
          content: `${req.user.username} 提交了${template.name}申请「${request.title}」`,
        },
      })
      // 通知中心
      notify({
        username,
        templateKey: 'approval_todo',
        data: { title: request.title, submitterName: req.user.displayName || req.user.username, templateName: template.name },
        priority: 'high',
        target: 'approval',
        refType: 'approval',
        refId: request.id,
      }).catch(() => {})
    }
    // 提交即建立抄送关系（提交人 + 财务 + 手动添加），审批通过后统一通知
    for (const [uname, unameName] of ccNames) {
      await tx.approvalCc.upsert({
        where: { requestId_ccUsername: { requestId: request.id, ccUsername: uname } },
        create: { id: `acc-${crypto.randomUUID()}`, requestId: request.id, ccUsername: uname, ccName: unameName },
        update: {},
      })
    }
    await tx.approvalLog.create({
      data: { id: `al-${crypto.randomUUID()}`, requestId: request.id, action: 'submit', username: req.user.username, detail: wasRejected ? '驳回后重新提交' : '提交审批' },
    })
  })
  res.json({ ok: true, request: serialize(await prisma.approvalRequest.findUnique({ where: { id: request.id } })) })
}))

/** 撤回（待审批 → 已撤回，仅提交人） */
approvalRouter.post('/approvals/requests/:id/withdraw', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('审批单不存在', 404)
  if (!canWithdraw(req.user, request)) throw httpError('仅提交人可在待审批时撤回', 403)
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({ where: { id: request.id }, data: { status: 'withdrawn' } })
    await tx.approvalLog.create({ data: { id: `al-${crypto.randomUUID()}`, requestId: request.id, action: 'withdraw', username: req.user.username, detail: '撤回申请' } })
  })
  res.json({ ok: true, request: serialize(await prisma.approvalRequest.findUnique({ where: { id: request.id } })) })
}))

/** 审批：通过 / 驳回（驳回意见必填） */
approvalRouter.post('/approvals/requests/:id/decide', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('审批单不存在', 404)
  const template = await prisma.approvalTemplate.findUnique({ where: { key: request.templateKey } })
  if (!canDecide(req.user, request, template)) throw httpError('无权审批该单据', 403)
  const body = req.body || {}
  const action = String(body.action || '')
  if (!['approve', 'reject'].includes(action)) throw httpError('审批操作不正确')
  const comment = text(body.comment, 300, '审批意见')
  if (action === 'reject' && comment.length < 2) throw httpError('驳回时必须填写审批意见')
  const ctx = await userCtx()
  await prisma.$transaction(async (tx) => {
    const updated = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'pending' }, // 防并发重复审批
      data: { status: action === 'approve' ? 'approved' : 'rejected', approvedAt: action === 'approve' ? new Date() : null },
    })
    if (updated.count !== 1) throw httpError('单据状态已变化，请刷新后重试', 409)
    // 更新节点
    const node = await tx.approvalNode.findFirst({
      where: { requestId: request.id, status: 'pending' },
      orderBy: { nodeIndex: 'asc' },
    })
    if (node) {
      await tx.approvalNode.update({
        where: { id: node.id },
        data: { status: action === 'approve' ? 'approved' : 'rejected', comment, actedAt: new Date() },
      })
      if (comment) {
        await tx.approvalComment.create({
          data: { id: `ac-${crypto.randomUUID()}`, requestId: request.id, nodeId: node.id, username: req.user.username, userRole: req.user.role, content: comment },
        })
      }
    }
    await tx.approvalLog.create({
      data: {
        id: `al-${crypto.randomUUID()}`,
        requestId: request.id,
        action: action === 'approve' ? 'approve' : 'reject',
        username: req.user.username,
        detail: action === 'approve' ? '审批通过' : `审批驳回：${comment}`,
      },
    })
    // 通知提交人（结果）
    await tx.approvalNotification.create({
      data: {
        id: `anot-${crypto.randomUUID()}`,
        requestId: request.id,
        username: request.submitterUsername,
        type: 'result',
        title: action === 'approve' ? '审批已通过' : '审批已驳回',
        content: `你的${template.name}申请「${request.title}」已被 ${req.user.username} ${action === 'approve' ? '通过' : '驳回'}${comment ? `：${comment}` : ''}`,
      },
    })
    // 通知中心
    notify({
      username: request.submitterUsername,
      templateKey: 'approval_result',
      data: {
        title: request.title,
        templateName: template.name,
        result: action === 'approve' ? '审批已通过' : '审批已驳回',
        resultText: action === 'approve' ? '通过' : `驳回：${comment}`,
        approverName: req.user.displayName || req.user.username,
      },
      priority: action === 'approve' ? 'normal' : 'high',
      target: 'approval',
      refType: 'approval',
      refId: request.id,
    }).catch(() => {})
    // 通过 → 通知抄送人（提交时已建立抄送关系：提交人 + 财务 + 手动添加），排除提交人本人（结果通知已覆盖）
    if (action === 'approve') {
      const ccRows = await tx.approvalCc.findMany({ where: { requestId: request.id } })
      for (const c of ccRows) {
        if (c.ccUsername === request.submitterUsername) continue
        await tx.approvalNotification.create({
          data: {
            id: `anot-${crypto.randomUUID()}`,
            requestId: request.id,
            username: c.ccUsername,
            type: 'cc',
            title: '抄送：审批已通过',
            content: `${template.name}申请「${request.title}」已通过审批，请查收`,
          },
        })
        // 通知中心
        notify({
          username: c.ccUsername,
          templateKey: 'approval_cc',
          data: { title: request.title, templateName: template.name },
          target: 'approval',
          refType: 'approval',
          refId: request.id,
        }).catch(() => {})
      }
    }
  })
  res.json({ ok: true, request: serialize(await prisma.approvalRequest.findUnique({ where: { id: request.id } })) })
}))

/** 归档（已通过/已驳回 → 已归档，仅开发者） */
approvalRouter.post('/approvals/requests/:id/archive', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('审批单不存在', 404)
  if (!canArchive(req.user, request)) throw httpError('仅开发者可归档已通过/已驳回单据', 403)
  await prisma.$transaction(async (tx) => {
    await tx.approvalRequest.update({ where: { id: request.id }, data: { status: 'archived', archivedAt: new Date() } })
    await tx.approvalLog.create({ data: { id: `al-${crypto.randomUUID()}`, requestId: request.id, action: 'archive', username: req.user.username, detail: '归档单据' } })
  })
  res.json({ ok: true, request: serialize(await prisma.approvalRequest.findUnique({ where: { id: request.id } })) })
}))

/** 删除（仅草稿） */
approvalRouter.delete('/approvals/requests/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('审批单不存在', 404)
  if (!canDelete(req.user, request)) throw httpError('仅草稿可删除', 403)
  await prisma.approvalRequest.delete({ where: { id: request.id } })
  res.json({ ok: true })
}))

// ---------------- 站内通知 ----------------
approvalRouter.get('/approvals/notifications', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  if (req.user.role === 'public' || req.user.role === 'cashier') throw httpError('无权限', 403)
  const unreadOnly = req.query.unread === '1'
  const rows = await prisma.approvalNotification.findMany({
    where: { username: req.user.username, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  res.json({
    ok: true,
    rows: rows.map((n) => ({ id: n.id, requestId: n.requestId, type: n.type, title: n.title, content: n.content, readAt: n.readAt, channel: n.channel, createdAt: n.createdAt })),
  })
}))

approvalRouter.post('/approvals/notifications/read', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  const body = req.body || {}
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : []
  if (body.all === true) {
    await prisma.approvalNotification.updateMany({
      where: { username: req.user.username, readAt: null },
      data: { readAt: new Date() },
    })
  } else if (ids.length) {
    await prisma.approvalNotification.updateMany({
      where: { id: { in: ids }, username: req.user.username },
      data: { readAt: new Date() },
    })
  }
  res.json({ ok: true })
}))
