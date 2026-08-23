// 员工档案（Employee Master Profile）：唯一员工主档 + 敏感信息保护 + 历史履历
//
// 安全约定：
// - 身份证号/银行卡号 AES-256-GCM 加密存储（密钥 env EMPLOYEE_SENSITIVE_KEY，32 字节 hex；
//   缺失时敏感字段读写 fail-closed）
// - 普通接口只返回掩码（身份证 1101********1234 / 银行卡 **** **** **** 6288）
// - reveal（查看完整号码）独立接口 + 角色白名单 + 审计日志；日志只记 last4 变化，不记完整号码
// - 敏感字段绝不进入 console/error 消息/URL/localStorage
// - 历史（调薪/调店/调岗/状态）只追加不覆盖、不提供硬删除
import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { httpError } from './pos-core.js'
import { isSuperUser, hasModuleAccess, MODULE_KEYS } from '../shared/accountPermissions.js'

export const employeeProfileRouter = Router()

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    const status = error.status || 500
    // 只记录错误消息与堆栈，不打印 error.meta/args 等可能含请求数据的字段
    if (status >= 500) console.error('[employee-profile]', error.message, '\n', error.stack || '')
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

// ---------------- 敏感字段加密（AES-256-GCM） ----------------
function sensitiveKey() {
  const key = String(process.env.EMPLOYEE_SENSITIVE_KEY || '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return null
  return Buffer.from(key, 'hex')
}

export function encryptSensitive(plain) {
  if (!plain) return ''
  const key = sensitiveKey()
  if (!key) throw httpError('敏感字段加密未配置（EMPLOYEE_SENSITIVE_KEY）', 503)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`
}

export function decryptSensitive(stored) {
  if (!stored) return ''
  const key = sensitiveKey()
  if (!key) throw httpError('敏感字段解密未配置（EMPLOYEE_SENSITIVE_KEY）', 503)
  const [ivHex, tagHex, dataHex] = String(stored).split(':')
  if (!ivHex || !tagHex || !dataHex) throw httpError('敏感字段数据损坏', 500)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    throw httpError('敏感字段解密失败', 500)
  }
}

// ---------------- 权限 ----------------
const IDENTITY_REVEAL_ROLES = new Set(['developer', 'admin'])
export const BANK_REVEAL_ROLES = new Set(['developer', 'admin', 'finance'])
const EDIT_ROLES = new Set(['developer', 'admin', 'finance'])

function moduleOk(user) {
  return Boolean(user) && hasModuleAccess(user, MODULE_KEYS.EMPLOYEE_PROFILE)
}

function requireProfileAccess(user) {
  if (!moduleOk(user)) throw httpError('无权限访问员工档案', 403)
}

function canEdit(user) {
  return Boolean(user) && EDIT_ROLES.has(user.role)
}

function canRevealIdentity(user) {
  return Boolean(user) && IDENTITY_REVEAL_ROLES.has(user.role) && moduleOk(user)
}

function canRevealBank(user) {
  return Boolean(user) && BANK_REVEAL_ROLES.has(user.role) && moduleOk(user)
}

/** 查看范围：superuser/finance/manager 全量；staff 仅本人（一期预留，模块默认不开放给 staff） */
function canViewEmployee(user, employee) {
  if (!moduleOk(user)) return false
  if (isSuperUser(user) || user.role === 'finance' || user.role === 'manager') return true
  return Boolean(user && employee.userId && employee.userId === user.id)
}

// ---------------- 审计 ----------------
export async function logAudit(user, employeeId, action, extra = {}) {
  await prisma.employeeAuditLog.create({
    data: {
      id: `ea-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      employeeId,
      action,
      targetType: extra.targetType || '',
      targetId: extra.targetId || '',
      beforeValue: extra.beforeValue || undefined,
      afterValue: extra.afterValue || undefined,
      operatorName: user?.username || '',
      operatorRole: user?.role || '',
    },
  }).catch((error) => console.error('[employee-profile] audit', error.message))
}

// ---------------- 序列化 ----------------
const MASKED = '****'
export function maskIdentity(number) {
  if (!number) return ''
  const n = String(number)
  if (n.length < 8) return MASKED
  const stars = n.length - 10
  return `${n.slice(0, 6)}${'*'.repeat(Math.max(stars, 4))}${n.slice(-4)}`
}
export function maskBank(card, last4) {
  const tail = last4 || (String(card || '').slice(-4)) || MASKED
  return `**** **** **** ${tail}`
}

function serializeEmployee(row, { profile, bank, contract } = {}) {
  const base = {
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    status: row.status,
    employmentType: row.employmentType,
    hireDate: row.hireDate,
    currentStoreKey: row.currentStoreKey,
    position: row.position,
    level: row.level,
    avatar: row.avatar,
    userId: row.userId || '',
    createdAt: row.createdAt,
  }
  if (profile) {
    base.profile = {
      gender: profile.gender,
      birthDate: profile.birthDate,
      phone: profile.phone,
      backupPhone: profile.backupPhone,
      email: profile.email,
      wechat: profile.wechat,
      nationality: profile.nationality,
      city: profile.city,
      address: profile.address,
      idType: profile.idType,
      idMasked: profile.idNumberMasked || (profile.idNumberLast4 ? maskIdentity(profile.idNumberLast4) : ''),
      idExpiryDate: profile.idExpiryDate,
      idPermanent: profile.idPermanent,
      emergency: profile.emergencyName
        ? {
            name: profile.emergencyName,
            relation: profile.emergencyRelation,
            phone: profile.emergencyPhone,
            backup: profile.emergencyBackup,
            note: profile.emergencyNote,
          }
        : null,
    }
  }
  if (bank) {
    base.bank = bank.map((b) => ({
      id: b.id,
      bankName: b.bankName,
      maskedNumber: maskBank('', b.cardLast4),
      cardLast4: b.cardLast4,
      accountName: b.accountName,
      bankBranch: b.bankBranch,
      bankCode: b.bankCode,
      isPayroll: b.isPayroll,
      status: b.status,
      effectiveDate: b.effectiveDate,
    }))
  }
  if (contract) {
    base.contract = contract
  }
  return base
}

// ---------------- API ----------------

/** 员工列表（姓名/编号/手机号搜索） */
employeeProfileRouter.get('/employees', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const q = String(req.query.q || '').trim().slice(0, 40)
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { employeeNo: { contains: q, mode: 'insensitive' } },
          { profile: { phone: { contains: q, mode: 'insensitive' } } },
        ],
      }
    : {}
  const rows = await prisma.employee.findMany({
    where,
    include: { profile: true },
    orderBy: [{ employeeNo: 'asc' }],
    take: 200,
  })
  res.json({
    rows: rows.map((row) => ({
      id: row.id,
      employeeNo: row.employeeNo,
      name: row.name,
      status: row.status,
      employmentType: row.employmentType,
      currentStoreKey: row.currentStoreKey,
      position: row.position,
      level: row.level,
      phone: row.profile?.phone || '',
      avatar: row.avatar,
    })),
  })
}))

/** 员工档案详情（普通资料；敏感字段一律掩码） */
employeeProfileRouter.get('/employees/:id/profile', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const row = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: { profile: true, bankAccounts: true },
  })
  if (!row) throw httpError('员工不存在', 404)
  if (!canViewEmployee(req.user, row)) throw httpError('无权限查看该员工档案', 403)
  res.json({ employee: serializeEmployee(row, { profile: row.profile, bank: row.bankAccounts }) })
}))

/** 编辑基本资料（敏感字段不在此接口修改） */
employeeProfileRouter.put('/employees/:id/profile', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可编辑员工档案', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const profileData = {
    gender: String(b.gender || '').slice(0, 10),
    birthDate: b.birthDate ? new Date(b.birthDate) : null,
    phone: String(b.phone || '').slice(0, 20),
    backupPhone: String(b.backupPhone || '').slice(0, 20),
    email: String(b.email || '').slice(0, 80),
    wechat: String(b.wechat || '').slice(0, 40),
    nationality: String(b.nationality || '').slice(0, 20),
    city: String(b.city || '').slice(0, 40),
    address: String(b.address || '').slice(0, 200),
    emergencyName: String(b.emergencyName || '').slice(0, 40),
    emergencyRelation: String(b.emergencyRelation || '').slice(0, 20),
    emergencyPhone: String(b.emergencyPhone || '').slice(0, 20),
    emergencyBackup: String(b.emergencyBackup || '').slice(0, 20),
    emergencyNote: String(b.emergencyNote || '').slice(0, 200),
  }
  await prisma.employeeProfile.upsert({
    where: { employeeId: row.id },
    create: { id: `ep-${crypto.randomUUID()}`, employeeId: row.id, ...profileData },
    update: profileData,
  })
  await logAudit(req.user, row.id, 'profile.edit')
  const updated = await prisma.employee.findUnique({ where: { id: row.id }, include: { profile: true, bankAccounts: true } })
  res.json({ ok: true, employee: serializeEmployee(updated, { profile: updated.profile, bank: updated.bankAccounts }) })
}))

/** 编辑任职信息（门店/岗位/职级/状态/用工类型/入职日期）——变更自动写入对应历史 */
employeeProfileRouter.put('/employees/:id/employment', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可编辑任职信息', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const next = {
    currentStoreKey: String(b.currentStoreKey || row.currentStoreKey || '').slice(0, 40),
    position: String(b.position ?? row.position).slice(0, 40),
    level: String(b.level ?? row.level).slice(0, 40),
    employmentType: String(b.employmentType || row.employmentType).slice(0, 20),
    hireDate: b.hireDate ? new Date(b.hireDate) : row.hireDate,
  }
  const effective = b.effectiveDate ? new Date(b.effectiveDate) : new Date()
  const reason = String(b.reason || '').slice(0, 200)
  const changes = []
  if (next.currentStoreKey !== row.currentStoreKey) {
    changes.push('store')
    await prisma.employeeStoreHistory.create({
      data: {
        id: `esh-${crypto.randomUUID()}`, employeeId: row.id, effectiveDate: effective,
        fromStoreKey: row.currentStoreKey, toStoreKey: next.currentStoreKey, reason, operatorName: req.user.username,
      },
    })
  }
  if (next.position !== row.position || next.level !== row.level) {
    changes.push('position')
    await prisma.employeePositionHistory.create({
      data: {
        id: `eph-${crypto.randomUUID()}`, employeeId: row.id, effectiveDate: effective,
        fromPosition: row.position, toPosition: next.position,
        fromLevel: row.level, toLevel: next.level, reason, operatorName: req.user.username,
      },
    })
  }
  if (b.status && b.status !== row.status) {
    changes.push('status')
    await prisma.employeeStatusHistory.create({
      data: {
        id: `est-${crypto.randomUUID()}`, employeeId: row.id, action: 'STATUS_CHANGE', effectiveDate: effective,
        fromStatus: row.status, toStatus: String(b.status), reason, operatorName: req.user.username,
      },
    })
  }
  const updated = await prisma.employee.update({
    where: { id: row.id },
    data: { ...next, ...(b.status ? { status: String(b.status) } : {}) },
  })
  if (changes.length > 0) await logAudit(req.user, row.id, `employment.change:${changes.join(',')}`)
  res.json({ ok: true, employee: serializeEmployee(updated) })
}))

/** 身份证信息（掩码展示；完整号码走 reveal） */
employeeProfileRouter.get('/employees/:id/identity', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { profile: true } })
  if (!row) throw httpError('员工不存在', 404)
  if (!canViewEmployee(req.user, row)) throw httpError('无权限', 403)
  res.json({
    idType: row.profile?.idType || 'identity',
    idMasked: row.profile?.idNumberMasked || (row.profile?.idNumberLast4 ? maskIdentity(row.profile.idNumberLast4) : ''),
    idExpiryDate: row.profile?.idExpiryDate || null,
    idPermanent: row.profile?.idPermanent || false,
    hasFull: Boolean(row.profile?.idNumberEnc),
  })
}))

/** 编辑身份证（号码加密存储；审计只记 last4 变化） */
employeeProfileRouter.put('/employees/:id/identity', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可编辑身份信息', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { profile: true } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const idNumber = String(b.idNumber || '').trim()
  const idType = String(b.idType || 'identity').slice(0, 20)
  const data = {
    idType,
    idExpiryDate: b.idExpiryDate ? new Date(b.idExpiryDate) : null,
    idPermanent: b.idPermanent === true,
  }
  if (idNumber) {
    if (idType === 'identity' && !/^\d{17}[\dXx]$/.test(idNumber)) throw httpError('身份证号码格式不正确')
    data.idNumberEnc = encryptSensitive(idNumber)
    data.idNumberLast4 = idNumber.slice(-4)
    data.idNumberMasked = maskIdentity(idNumber)
  }
  await prisma.employeeProfile.upsert({
    where: { employeeId: row.id },
    create: { id: `ep-${crypto.randomUUID()}`, employeeId: row.id, ...data },
    update: data,
  })
  const oldLast4 = row.profile?.idNumberLast4 || ''
  await logAudit(req.user, row.id, 'identity.edit', {
    beforeValue: { idLast4: oldLast4 },
    afterValue: { idLast4: idNumber ? idNumber.slice(-4) : oldLast4 },
  })
  res.json({ ok: true })
}))

/** 查看完整身份证号（角色白名单 + 审计；仅 developer/admin） */
employeeProfileRouter.post('/employees/:id/identity/reveal', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canRevealIdentity(req.user)) throw httpError('无权限查看完整身份证号', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { profile: true } })
  if (!row) throw httpError('员工不存在', 404)
  if (!row.profile?.idNumberEnc) throw httpError('暂未填写身份证号', 400)
  const full = decryptSensitive(row.profile.idNumberEnc)
  await logAudit(req.user, row.id, 'identity.reveal', { targetType: 'identity' })
  res.json({ idNumber: full, idLast4: row.profile.idNumberLast4 })
}))

/** 工资银行卡（掩码展示） */
employeeProfileRouter.get('/employees/:id/bank-account', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { bankAccounts: true } })
  if (!row) throw httpError('员工不存在', 404)
  if (!canViewEmployee(req.user, row)) throw httpError('无权限', 403)
  res.json({
    bank: row.bankAccounts.map((b) => ({
      id: b.id,
      bankName: b.bankName,
      maskedNumber: maskBank('', b.cardLast4),
      cardLast4: b.cardLast4,
      accountName: b.accountName,
      bankBranch: b.bankBranch,
      isPayroll: b.isPayroll,
      status: b.status,
    })),
  })
}))

/** 编辑工资银行卡（卡号加密；审计只记 last4） */
employeeProfileRouter.put('/employees/:id/bank-account', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可编辑银行卡', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const cardNumber = String(b.cardNumber || '').trim()
  if (!cardNumber) throw httpError('银行卡号必填')
  if (!/^\d{8,25}$/.test(cardNumber)) throw httpError('银行卡号格式不正确')
  const data = {
    accountName: String(b.accountName || row.name).slice(0, 40),
    cardNumberEnc: encryptSensitive(cardNumber),
    cardLast4: cardNumber.slice(-4),
    bankName: String(b.bankName || '').slice(0, 40),
    bankBranch: String(b.bankBranch || '').slice(0, 60),
    bankCode: String(b.bankCode || '').slice(0, 30),
    isPayroll: b.isPayroll !== false,
    status: String(b.status || 'active').slice(0, 10),
    effectiveDate: b.effectiveDate ? new Date(b.effectiveDate) : null,
    note: String(b.note || '').slice(0, 200),
  }
  const before = await prisma.employeeBankAccount.findFirst({ where: { employeeId: row.id, isPayroll: true } })
  await prisma.employeeBankAccount.upsert({
    where: { id: b.id || 'none' },
    create: { id: `eba-${crypto.randomUUID()}`, employeeId: row.id, ...data },
    update: data,
  })
  await logAudit(req.user, row.id, 'bank.edit', {
    beforeValue: { cardLast4: before?.cardLast4 || '' },
    afterValue: { cardLast4: cardNumber.slice(-4) },
  })
  res.json({ ok: true })
}))

/** 查看完整银行卡号（角色白名单 + 审计） */
employeeProfileRouter.post('/employees/:id/bank-account/reveal', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canRevealBank(req.user)) throw httpError('无权限查看完整银行卡号', 403)
  const account = await prisma.employeeBankAccount.findFirst({
    where: { employeeId: req.params.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  if (!account) throw httpError('暂未填写银行卡', 400)
  const full = decryptSensitive(account.cardNumberEnc)
  await logAudit(req.user, req.params.id, 'bank.reveal', { targetType: 'bank_account', targetId: account.id })
  res.json({ bankName: account.bankName, cardNumber: full, cardLast4: account.cardLast4 })
}))

/** 合同列表 */
employeeProfileRouter.get('/employees/:id/contracts', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const rows = await prisma.employeeContract.findMany({
    where: { employeeId: req.params.id },
    orderBy: [{ signDate: 'desc' }, { createdAt: 'desc' }],
  })
  res.json({ rows: rows.map((c) => ({
    id: c.id, contractType: c.contractType, contractNo: c.contractNo,
    signDate: c.signDate, startDate: c.startDate, endDate: c.endDate,
    isIndefinite: c.isIndefinite, probationMonths: c.probationMonths,
    status: c.status, note: c.note, createdAt: c.createdAt,
  })) })
}))

/** 新增合同（canEdit） */
employeeProfileRouter.post('/employees/:id/contracts', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可新增合同', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const c = await prisma.employeeContract.create({
    data: {
      id: `ec-${crypto.randomUUID()}`,
      employeeId: row.id,
      contractType: String(b.contractType || 'labor').slice(0, 20),
      contractNo: String(b.contractNo || '').slice(0, 60),
      signDate: b.signDate ? new Date(b.signDate) : null,
      startDate: b.startDate ? new Date(b.startDate) : null,
      endDate: b.endDate ? new Date(b.endDate) : null,
      isIndefinite: b.isIndefinite === true,
      probationMonths: Math.max(0, Math.min(24, Number(b.probationMonths) || 0)),
      status: String(b.status || 'active').slice(0, 20),
      note: String(b.note || '').slice(0, 200),
    },
  })
  await logAudit(req.user, row.id, 'contract.add', { targetType: 'contract', targetId: c.id, afterValue: { contractNo: c.contractNo, contractType: c.contractType } })
  res.json({ ok: true, id: c.id })
}))

/** 合同终止（软删：保留记录，状态置 terminated） */
employeeProfileRouter.delete('/employees/:id/contracts/:contractId', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可终止合同', 403)
  const c = await prisma.employeeContract.findUnique({ where: { id: req.params.contractId } })
  if (!c || c.employeeId !== req.params.id) throw httpError('合同不存在', 404)
  await prisma.employeeContract.update({ where: { id: c.id }, data: { status: 'terminated' } })
  await logAudit(req.user, req.params.id, 'contract.terminate', { targetType: 'contract', targetId: c.id, afterValue: { contractNo: c.contractNo } })
  res.json({ ok: true })
}))

/** 调薪记录（追加历史，不覆盖） */
employeeProfileRouter.post('/employees/:id/salary-change', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可记录调薪', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const oldValue = String(b.oldValue || '').slice(0, 40)
  const newValue = String(b.newValue || '').slice(0, 40)
  const effectiveDate = b.effectiveDate ? new Date(b.effectiveDate) : new Date()
  if (!oldValue && !newValue) throw httpError('请填写调薪前后数值')
  await prisma.employeeSalaryHistory.create({
    data: {
      id: `esh-${crypto.randomUUID()}`, employeeId: row.id, effectiveDate,
      oldValue, newValue, salaryType: String(b.salaryType || '').slice(0, 20),
      reason: String(b.reason || '').slice(0, 200), operatorName: req.user.username,
    },
  })
  await logAudit(req.user, row.id, 'salary.change', { afterValue: { oldValue, newValue } })
  res.json({ ok: true })
}))

/** 在职状态变更（入职/转正/离职/返聘——离职 ≠ 删除） */
employeeProfileRouter.post('/employees/:id/status-change', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可操作在职状态', 403)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  const b = req.body || {}
  const action = String(b.action || '').toUpperCase() // HIRE | PROBATION_PASS | LEAVE | SUSPEND | RESIGN | REHIRE
  const valid = new Set(['HIRE', 'PROBATION_PASS', 'LEAVE', 'SUSPEND', 'RESIGN', 'REHIRE'])
  if (!valid.has(action)) throw httpError('不支持的职状态操作')
  const toStatus = { HIRE: 'ACTIVE', PROBATION_PASS: 'ACTIVE', LEAVE: 'LEAVE', SUSPEND: 'SUSPENDED', RESIGN: 'RESIGNED', REHIRE: 'ACTIVE' }[action]
  const effectiveDate = b.effectiveDate ? new Date(b.effectiveDate) : new Date()
  await prisma.employeeStatusHistory.create({
    data: {
      id: `est-${crypto.randomUUID()}`, employeeId: row.id, action, effectiveDate,
      fromStatus: row.status, toStatus,
      lastWorkDate: b.lastWorkDate ? new Date(b.lastWorkDate) : null,
      resignType: String(b.resignType || '').slice(0, 20),
      resignReason: String(b.resignReason || '').slice(0, 300),
      handoverStatus: String(b.handoverStatus || '').slice(0, 20),
      salarySettled: b.salarySettled === true,
      propertyReturned: b.propertyReturned === true,
      accountDisabled: b.accountDisabled === true,
      rehireAllowed: b.rehireAllowed !== false,
      note: String(b.note || '').slice(0, 300),
      operatorName: req.user.username,
    },
  })
  await prisma.employee.update({ where: { id: row.id }, data: { status: toStatus } })
  await logAudit(req.user, row.id, `status.change:${action}`, { afterValue: { toStatus } })
  res.json({ ok: true })
}))

/** 人事履历时间线（合并各历史，按时间倒序） */
employeeProfileRouter.get('/employees/:id/timeline', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  if (!canViewEmployee(req.user, row)) throw httpError('无权限', 403)
  const [hire, salary, store, position, status] = await Promise.all([
    prisma.employee.findUnique({ where: { id: row.id }, select: { hireDate: true } }),
    prisma.employeeSalaryHistory.findMany({ where: { employeeId: row.id }, orderBy: { effectiveDate: 'desc' } }),
    prisma.employeeStoreHistory.findMany({ where: { employeeId: row.id }, orderBy: { effectiveDate: 'desc' } }),
    prisma.employeePositionHistory.findMany({ where: { employeeId: row.id }, orderBy: { effectiveDate: 'desc' } }),
    prisma.employeeStatusHistory.findMany({ where: { employeeId: row.id }, orderBy: { effectiveDate: 'desc' } }),
  ])
  const items = []
  if (hire.hireDate) items.push({ date: hire.hireDate, type: 'hire', title: '入职', detail: `${row.name} · ${row.currentStoreKey}` })
  for (const s of salary) items.push({ date: s.effectiveDate, type: 'salary', title: '薪资调整', detail: `${s.oldValue} → ${s.newValue}${s.reason ? `（${s.reason}）` : ''}`, operator: s.operatorName })
  for (const s of store) items.push({ date: s.effectiveDate, type: 'store', title: '门店调动', detail: `${s.fromStoreKey || '—'} → ${s.toStoreKey}${s.reason ? `（${s.reason}）` : ''}`, operator: s.operatorName })
  for (const p of position) items.push({ date: p.effectiveDate, type: 'position', title: '岗位/职级调整', detail: `${p.fromPosition || '—'}→${p.toPosition}${p.fromLevel || p.toLevel ? ` · ${p.fromLevel || '—'}→${p.toLevel || '—'}` : ''}`, operator: p.operatorName })
  for (const s of status) items.push({ date: s.effectiveDate, type: 'status', title: s.action, detail: `${s.fromStatus} → ${s.toStatus}${s.resignReason ? `（${s.resignReason}）` : ''}`, operator: s.operatorName })
  items.sort((a, b) => new Date(b.date) - new Date(a.date))
  res.json({ timeline: items })
}))

/** 工资/考勤摘要（只读现有 PayrollNotice / DailyStoreStaff，不建第二份真值） */
employeeProfileRouter.get('/employees/:id/summary', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const row = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!row) throw httpError('员工不存在', 404)
  if (!canViewEmployee(req.user, row)) throw httpError('无权限', 403)
  const [notices, staffRows] = await Promise.all([
    prisma.payrollNotice.findMany({
      where: { employeeName: row.name, storeKey: row.currentStoreKey || undefined },
      orderBy: { createdAt: 'desc' },
      take: 6,
    }),
    prisma.dailyStoreStaff.findMany({
      where: { staffId: row.id },
      orderBy: { date: 'desc' },
      take: 60,
    }),
  ])
  res.json({
    payroll: notices.map((n) => ({
      id: n.id, periodType: n.periodType, periodKey: n.periodKey,
      totalCents: n.totalCents.toString(), status: n.status, createdAt: n.createdAt,
    })),
    attendance: {
      days: staffRows.length,
      totalHours: Number(staffRows.reduce((sum, s) => sum + (s.actualHours || 0), 0).toFixed(1)),
    },
  })
}))

/** 附件（认证+鉴权访问；敏感附件默认只返回元数据） */
employeeProfileRouter.get('/employees/:id/documents', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const rows = await prisma.employeeDocument.findMany({
    where: { employeeId: req.params.id },
    orderBy: { createdAt: 'desc' },
  })
  res.json({
    rows: rows.map((d) => ({
      id: d.id, documentType: d.documentType, fileName: d.fileName, mimeType: d.mimeType,
      fileSize: d.fileSize, isSensitive: d.isSensitive, note: d.note, uploadedBy: d.uploadedBy, createdAt: d.createdAt,
    })),
  })
}))

/** 上传附件（敏感附件标记 isSensitive；字节仅管理员可读取） */
employeeProfileRouter.post('/employees/:id/documents', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可上传附件', 403)
  const b = req.body || {}
  const data = String(b.data || '')
  if (!data || data.length > 4 * 1024 * 1024) throw httpError('附件内容为空或超过 4MB')
  const doc = await prisma.employeeDocument.create({
    data: {
      id: `ed-${crypto.randomUUID()}`,
      employeeId: req.params.id,
      documentType: String(b.documentType || 'other').slice(0, 20),
      fileName: String(b.fileName || 'file').slice(0, 120),
      mimeType: String(b.mimeType || 'application/octet-stream').slice(0, 60),
      fileSize: Buffer.byteLength(data, 'base64'),
      data,
      isSensitive: b.isSensitive === true,
      note: String(b.note || '').slice(0, 200),
      uploadedBy: req.user.username,
    },
  })
  await logAudit(req.user, req.params.id, 'document.upload', { targetType: 'document', targetId: doc.id, afterValue: { isSensitive: doc.isSensitive, type: doc.documentType } })
  res.json({ ok: true, id: doc.id })
}))

/** 读取附件内容（必须登录 + 模块权限；敏感附件需 edit 权限） */
employeeProfileRouter.get('/employees/:id/documents/:docId/content', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.docId } })
  if (!doc || doc.employeeId !== req.params.id) throw httpError('附件不存在', 404)
  if (doc.isSensitive && !canEdit(req.user)) throw httpError('无权限查看敏感附件', 403)
  await logAudit(req.user, req.params.id, 'document.read', { targetType: 'document', targetId: doc.id })
  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`)
  res.send(Buffer.from(doc.data, 'base64'))
}))

/** 删除附件（逻辑删除：仅清除内容字节，保留记录） */
employeeProfileRouter.delete('/employees/:id/documents/:docId', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可删除附件', 403)
  const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.docId } })
  if (!doc || doc.employeeId !== req.params.id) throw httpError('附件不存在', 404)
  await prisma.employeeDocument.update({ where: { id: doc.id }, data: { data: '' } })
  await logAudit(req.user, req.params.id, 'document.delete', { targetType: 'document', targetId: doc.id })
  res.json({ ok: true })
}))

/** 现有员工回填档案（仅 developer/admin/finance）：从 Staff 名单生成 Employee 主档与 employeeNo（BUDU-XXXX），不修改任何现有数据 */
employeeProfileRouter.post('/employees/backfill', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireProfileAccess(req.user)
  if (!canEdit(req.user)) throw httpError('仅开发者/管理员/财务可执行档案回填', 403)
  const staffRows = await prisma.staff.findMany({ orderBy: [{ storeKey: 'asc' }, { name: 'asc' }] })
  const existing = new Set(
    (await prisma.employee.findMany({ select: { currentStoreKey: true, name: true } }))
      .map((e) => `${e.currentStoreKey}::${e.name}`),
  )
  const max = await prisma.employee.aggregate({ _max: { employeeNo: true } })
  let seq = max._max.employeeNo ? Number(String(max._max.employeeNo).replace(/\D/g, '')) || 0 : 0
  let created = 0
  let skipped = 0
  const createdIds = []
  for (const s of staffRows) {
    const key = `${s.storeKey}::${s.name}`
    if (existing.has(key)) { skipped += 1; continue }
    seq += 1
    const emp = await prisma.employee.create({
      data: {
        id: `emp-${crypto.randomUUID()}`,
        employeeNo: `BUDU-${String(seq).padStart(4, '0')}`,
        name: s.name,
        status: 'ACTIVE',
        employmentType: String(s.type || 'fulltime'),
        currentStoreKey: s.storeKey,
        position: '店员',
        hireDate: null,
      },
    })
    createdIds.push(emp.id)
    created += 1
  }
  // 逐员工审计（employeeId 必须指向真实员工，外键约束不允许汇总占位行）
  for (const id of createdIds) {
    await logAudit(req.user, id, 'backfill.create', { targetType: 'employee', afterValue: { created: true } })
  }
  res.json({ ok: true, total: staffRows.length, created, skipped })
}))
