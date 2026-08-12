import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { loadDb, persist } from './store.js'
import { httpError } from './pos-core.js'

export const assetCenterRouter = Router()

export const ASSET_CATEGORIES = ['license', 'store', 'staff', 'brand', 'contract', 'operation', 'other']

const DAY_MS = 24 * 60 * 60 * 1000

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[asset-center]', error)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

export function canViewAssets(user) {
  return Boolean(user && user.role !== 'public' && (user.role === 'developer' || user.assetCenter === true))
}

function requireAssetAccess(user) {
  if (!canViewAssets(user)) throw httpError('无权限', 403)
}

function licenseStatus(file, now = new Date()) {
  if (file.category !== 'license' || !file.expiryDate || file.isPermanent) return 'normal'
  const daysLeft = Math.ceil((new Date(file.expiryDate).getTime() - now.getTime()) / DAY_MS)
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= 30) return 'expiring'
  return 'normal'
}

function daysLeftOf(file, now = new Date()) {
  if (!file.expiryDate || file.isPermanent) return null
  return Math.ceil((new Date(file.expiryDate).getTime() - now.getTime()) / DAY_MS)
}

function serializeFile(file) {
  const latest = (file.versions && file.versions[0]) || null
  return {
    id: file.id,
    name: file.name,
    category: file.category,
    company: file.company,
    storeKey: file.storeKey,
    tags: Array.isArray(file.tags) ? file.tags : [],
    description: file.description,
    fileName: latest ? latest.name : '',
    fileType: latest ? latest.fileType : file.fileType,
    fileSize: latest ? latest.fileSize : file.fileSize,
    currentVersion: file.currentVersion,
    issuingAuthority: file.issuingAuthority,
    licenseNo: file.licenseNo,
    issueDate: file.issueDate,
    expiryDate: file.expiryDate,
    isPermanent: file.isPermanent,
    status: licenseStatus(file),
    daysLeft: daysLeftOf(file),
    createdBy: file.createdBy,
    updatedBy: file.updatedBy,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  }
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  return value.map((tag) => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 20)
}

function text(value, max, label, required = false) {
  const result = String(value ?? '').trim()
  if (required && !result) throw httpError(`请填写${label}`)
  if (result.length > max) throw httpError(`${label}不能超过 ${max} 个字符`)
  return result
}

function parseDate(value, label) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw httpError(`${label}格式不正确`)
  return d
}

function validDataUrl(value) {
  const dataUrl = String(value || '')
  if (!dataUrl) throw httpError('请选择文件')
  if (!/^data:[^;,]{2,80};base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw httpError('文件数据格式不正确')
  if (dataUrl.length > 12000000) throw httpError('文件过大，请压缩后上传（最大约 9MB）')
  return dataUrl
}

function decodeSize(dataUrl) {
  try {
    const base64 = dataUrl.split(',')[1] || ''
    return Buffer.from(base64, 'base64').length
  } catch {
    return 0
  }
}

async function logAction(user, action, input = {}) {
  await prisma.assetOperationLog.create({
    data: {
      id: `alog-${crypto.randomUUID()}`,
      action,
      userId: user.id,
      username: user.username,
      fileId: input.fileId || '',
      fileName: String(input.fileName || '').slice(0, 100),
      storeKey: input.storeKey || '',
      detail: String(input.detail || '').slice(0, 300),
    },
  }).catch((error) => console.error('[asset-log]', error.message))
}

function baseWhere(req) {
  const q = String(req.query.q || '').trim()
  const category = String(req.query.category || '').trim()
  const storeKey = String(req.query.store || '').trim()
  const company = String(req.query.company || '').trim()
  const tag = String(req.query.tag || '').trim()
  const status = String(req.query.status || '').trim()
  const where = { deletedAt: null }
  if (ASSET_CATEGORIES.includes(category)) where.category = category
  if (storeKey) where.storeKey = storeKey
  if (company) where.company = { contains: company, mode: 'insensitive' }
  if (tag) where.tags = { array_contains: [tag] }
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { licenseNo: { contains: q, mode: 'insensitive' } },
    ]
  }
  if (status === 'expired') {
    where.category = 'license'
    where.isPermanent = false
    where.expiryDate = { lt: new Date() }
  } else if (status === 'expiring') {
    where.category = 'license'
    where.isPermanent = false
    where.expiryDate = { gte: new Date(), lte: new Date(Date.now() + 30 * DAY_MS) }
  } else if (status === 'normal' && category === 'license') {
    where.category = 'license'
    where.OR = [{ isPermanent: true }, { expiryDate: { gt: new Date(Date.now() + 30 * DAY_MS) } }]
  }
  return where
}

assetCenterRouter.get('/asset-center/config', wrap(async (req, res) => {
  requireAssetAccess(req.user)
  res.json({ enabled: true, role: req.user.role })
}))

assetCenterRouter.get('/asset-center/overview', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const [total, expiring, expired, addedThisMonth, recent] = await Promise.all([
    prisma.assetFile.count({ where: { deletedAt: null } }),
    prisma.assetFile.count({
      where: { deletedAt: null, category: 'license', isPermanent: false, expiryDate: { gte: now, lte: new Date(Date.now() + 30 * DAY_MS) } },
    }),
    prisma.assetFile.count({ where: { deletedAt: null, category: 'license', isPermanent: false, expiryDate: { lt: now } } }),
    prisma.assetFile.count({ where: { deletedAt: null, createdAt: { gte: monthStart } } }),
    prisma.assetFile.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 8, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } }),
  ])
  res.json({
    total,
    expiring,
    expired,
    addedThisMonth,
    recent: recent.map(serializeFile),
  })
}))

assetCenterRouter.get('/asset-center/files', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50))
  const where = baseWhere(req)
  const [rows, total] = await Promise.all([
    prisma.assetFile.findMany({
      where,
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.assetFile.count({ where }),
  ])
  res.json({ rows: rows.map(serializeFile), total, page, pageSize })
}))

assetCenterRouter.get('/asset-center/files/:id/versions', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const versions = await prisma.assetFileVersion.findMany({
    where: { fileId: req.params.id },
    orderBy: { version: 'desc' },
  })
  if (versions.length === 0) throw httpError('文件不存在', 404)
  res.json({
    rows: versions.map((v) => ({
      id: v.id,
      version: v.version,
      name: v.name,
      fileType: v.fileType,
      fileSize: v.fileSize,
      uploaderName: v.uploaderName,
      note: v.note,
      createdAt: v.createdAt,
      dataUrl: v.dataUrl,
    })),
  })
}))

assetCenterRouter.post('/asset-center/files', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const body = req.body || {}
  const category = text(body.category, 20, '类别', true)
  if (!ASSET_CATEGORIES.includes(category)) throw httpError('类别不正确')
  const name = text(body.name, 100, '文件名称', true)
  const dataUrl = validDataUrl(body.dataUrl)
  const file = await prisma.$transaction(async (tx) => {
    const id = `af-${crypto.randomUUID()}`
    const created = await tx.assetFile.create({
      data: {
        id,
        name,
        category,
        company: text(body.company, 50, '所属公司'),
        storeKey: text(body.storeKey, 30, '所属门店'),
        tags: normalizeTags(body.tags),
        description: text(body.description, 300, '描述'),
        fileType: String(body.fileType || '').slice(0, 80),
        fileSize: decodeSize(dataUrl),
        issuingAuthority: text(body.issuingAuthority, 60, '发证机关'),
        licenseNo: text(body.licenseNo, 60, '证照编号'),
        issueDate: parseDate(body.issueDate, '发证日期'),
        expiryDate: parseDate(body.expiryDate, '到期日期'),
        isPermanent: body.isPermanent === true,
        createdBy: req.user.username,
        updatedBy: req.user.username,
      },
    })
    await tx.assetFileVersion.create({
      data: {
        id: `afv-${crypto.randomUUID()}`,
        fileId: id,
        version: 1,
        name: String(body.fileName || name).slice(0, 120),
        fileType: String(body.fileType || '').slice(0, 80),
        fileSize: decodeSize(dataUrl),
        dataUrl,
        uploaderId: req.user.id,
        uploaderName: req.user.username,
        note: '初始版本',
      },
    })
    return tx.assetFile.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } })
  })
  await logAction(req.user, 'upload', { fileId: file.id, fileName: file.name, storeKey: file.storeKey })
  res.status(201).json({ ok: true, file: serializeFile(file) })
}))

assetCenterRouter.put('/asset-center/files/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const body = req.body || {}
  const existing = await prisma.assetFile.findUnique({ where: { id: req.params.id } })
  if (!existing || existing.deletedAt) throw httpError('文件不存在', 404)
  const category = text(body.category || existing.category, 20, '类别', true)
  if (!ASSET_CATEGORIES.includes(category)) throw httpError('类别不正确')
  const dataUrl = body.dataUrl ? validDataUrl(body.dataUrl) : null
  const updated = await prisma.$transaction(async (tx) => {
    let currentVersion = existing.currentVersion
    let fileType = existing.fileType
    let fileSize = existing.fileSize
    let fileName = existing.name
    if (dataUrl) {
      currentVersion += 1
      fileType = String(body.fileType || existing.fileType || '').slice(0, 80)
      fileSize = decodeSize(dataUrl)
      fileName = String(body.fileName || existing.name || '').slice(0, 120)
      await tx.assetFileVersion.create({
        data: {
          id: `afv-${crypto.randomUUID()}`,
          fileId: existing.id,
          version: currentVersion,
          name: fileName,
          fileType,
          fileSize,
          dataUrl,
          uploaderId: req.user.id,
          uploaderName: req.user.username,
          note: String(body.note || '').slice(0, 200),
        },
      })
    }
    await tx.assetFile.update({
      where: { id: existing.id },
      data: {
        name: text(body.name || existing.name, 100, '文件名称', true),
        category,
        company: text(body.company !== undefined ? body.company : existing.company, 50, '所属公司'),
        storeKey: text(body.storeKey !== undefined ? body.storeKey : existing.storeKey, 30, '所属门店'),
        tags: body.tags !== undefined ? normalizeTags(body.tags) : existing.tags,
        description: text(body.description !== undefined ? body.description : existing.description, 300, '描述'),
        ...(dataUrl ? { fileType, fileSize, currentVersion } : {}),
        issuingAuthority: text(body.issuingAuthority !== undefined ? body.issuingAuthority : existing.issuingAuthority, 60, '发证机关'),
        licenseNo: text(body.licenseNo !== undefined ? body.licenseNo : existing.licenseNo, 60, '证照编号'),
        issueDate: body.issueDate !== undefined ? parseDate(body.issueDate, '发证日期') : existing.issueDate,
        expiryDate: body.expiryDate !== undefined ? parseDate(body.expiryDate, '到期日期') : existing.expiryDate,
        isPermanent: body.isPermanent !== undefined ? body.isPermanent === true : existing.isPermanent,
        updatedBy: req.user.username,
        updatedAt: new Date(),
      },
    })
    return tx.assetFile.findUnique({ where: { id: existing.id }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } })
  })
  await logAction(req.user, dataUrl ? 'upload_version' : 'update', {
    fileId: existing.id,
    fileName: updated.name,
    storeKey: updated.storeKey,
    detail: dataUrl ? `更新到 V${updated.currentVersion}` : '修改资料',
  })
  res.json({ ok: true, file: serializeFile(updated) })
}))

assetCenterRouter.post('/asset-center/files/:id/restore', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) throw httpError('版本号不正确')
  const target = await prisma.assetFileVersion.findUnique({
    where: { fileId_version: { fileId: req.params.id, version } },
  })
  if (!target) throw httpError('版本不存在', 404)
  const file = await prisma.assetFile.update({
    where: { id: req.params.id },
    data: {
      currentVersion: version,
      fileType: target.fileType,
      fileSize: target.fileSize,
      name: target.name.slice(0, 100) || undefined,
      updatedBy: req.user.username,
      updatedAt: new Date(),
    },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
  await logAction(req.user, 'restore', { fileId: file.id, fileName: file.name, storeKey: file.storeKey, detail: `恢复到 V${version}` })
  res.json({ ok: true, file: serializeFile(file) })
}))

assetCenterRouter.delete('/asset-center/files/:id', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const file = await prisma.assetFile.findUnique({ where: { id: req.params.id } })
  if (!file || file.deletedAt) throw httpError('文件不存在', 404)
  await prisma.assetFile.update({ where: { id: file.id }, data: { deletedAt: new Date(), updatedBy: req.user.username, updatedAt: new Date() } })
  await logAction(req.user, 'delete', { fileId: file.id, fileName: file.name, storeKey: file.storeKey })
  res.json({ ok: true })
}))

assetCenterRouter.get('/asset-center/files/:id/download', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const file = await prisma.assetFile.findUnique({ where: { id: req.params.id }, include: { versions: { orderBy: { version: 'desc' } } } })
  if (!file || file.deletedAt) throw httpError('文件不存在', 404)
  const version = file.versions.find((v) => v.version === file.currentVersion) || file.versions[0]
  if (!version) throw httpError('文件内容缺失', 404)
  await logAction(req.user, 'download', { fileId: file.id, fileName: file.name, storeKey: file.storeKey, detail: `V${version.version}` })
  res.json({
    ok: true,
    name: version.name,
    fileType: version.fileType,
    fileSize: version.fileSize,
    version: version.version,
    dataUrl: version.dataUrl,
  })
}))

assetCenterRouter.get('/asset-center/reminders', wrap(async (req, res) => {
  if (!dbReady()) throw httpError('数据库未配置', 503)
  requireAssetAccess(req.user)
  const rows = await prisma.assetReminder.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  res.json({ rows })
}))

assetCenterRouter.get('/asset-center/grants', wrap(async (req, res) => {
  if (req.user?.role !== 'developer') throw httpError('无权限', 403)
  const db = await loadDb()
  const users = (Array.isArray(db.users) ? db.users : []).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    assetCenter: u.role === 'developer' || Boolean(u.assetCenter),
  }))
  res.json({ users })
}))

assetCenterRouter.put('/asset-center/grants', wrap(async (req, res) => {
  if (req.user?.role !== 'developer') throw httpError('无权限', 403)
  const userId = String(req.body?.userId || '')
  const granted = req.body?.granted === true
  const db = await loadDb()
  const target = (db.users || []).find((u) => u.id === userId)
  if (!target) throw httpError('账号不存在', 404)
  target.assetCenter = granted
  await persist()
  await prisma.assetAccessGrant.upsert({
    where: { userId },
    update: { username: target.username, grantedBy: req.user.username },
    create: { id: `aag-${crypto.randomUUID()}`, userId, username: target.username, grantedBy: req.user.username },
  })
  await logAction(req.user, granted ? 'grant' : 'revoke', { fileName: target.username, detail: `资产中心${granted ? '授权' : '取消授权'}` })
  res.json({ ok: true, user: { id: target.id, username: target.username, assetCenter: target.role === 'developer' || granted } })
}))

assetCenterRouter.get('/asset-center/logs', wrap(async (req, res) => {
  if (req.user?.role !== 'developer') throw httpError('无权限', 403)
  const rows = await prisma.assetOperationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  res.json({ rows })
}))

assetCenterRouter.post('/asset-center/package-log', wrap(async (req, res) => {
  requireAssetAccess(req.user)
  const storeKey = String(req.body?.storeKey || '').slice(0, 30)
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 50) : []
  await logAction(req.user, 'package', {
    storeKey,
    fileName: files.join('、').slice(0, 100),
    detail: `开店资料包（${files.length} 个文件）`,
  })
  res.json({ ok: true })
}))
