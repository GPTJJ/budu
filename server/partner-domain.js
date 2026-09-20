import crypto from 'node:crypto'
import { Router } from 'express'
import { hashPassword } from './auth.js'
import { prisma, dbReady } from './pg.js'
import { createUser, mirrorUsersToKv } from './user-store.js'
import { canManagePartnerDomain } from '../shared/accountPermissions.js'
import {
  PARTNER_STATUSES,
  PARTNER_STORE_STATUSES,
  PARTNER_USER_STATUSES,
  boundedText,
  partnerPublicDto,
  partnerLifecycleFields,
  partnerStorePublicDto,
  validateDateOnly,
  validateDiscountBps,
  validatePartnerStatus,
  validatePartnerStoreStatus,
  validatePartnerUserStatus,
} from './partner-domain-policy.js'
import {
  REPLENISHMENT_CREATED_BY_TYPES,
  createReplenishmentOrder,
  getInternalReplenishmentOrder,
  serializeReplenishmentOrder,
} from './replenishment-order-service.js'
import {
  REPLENISHMENT_REVIEW_ACTIONS,
  getReplenishmentReviewOrder,
  listReplenishmentReviewOrders,
  previewReplenishmentApproval,
  reviewReplenishmentOrder,
} from './replenishment-review-service.js'
import { deliverPartnerReplenishmentStockingNotification } from './transfer-notification.js'
import {
  createReplenishmentShipment,
  listFulfillmentStores,
} from './replenishment-shipment-service.js'
import {
  afterSalesDto,
  getInternalAfterSalesAttachment,
  listInternalAfterSales,
  processInternalAfterSales,
} from './replenishment-after-sales-service.js'

const bad = (message, status = 400, code = 'PARTNER_DOMAIN_INVALID') => Object.assign(new Error(message), { status, code })
const uid = () => crypto.randomUUID()

function actor(user) {
  return { id: String(user?.id || ''), username: String(user?.username || '') }
}

function partnerInput(body = {}) {
  return {
    name: boundedText(body.name, { label: '合作商名称', max: 80, required: true }),
    companyName: boundedText(body.companyName, { label: '公司主体', max: 120, required: true }),
    contactName: boundedText(body.contactName, { label: '联系人', max: 50, required: true }),
    contactPhone: boundedText(body.contactPhone, { label: '联系电话', max: 30, required: true }),
    cooperationStartDate: validateDateOnly(body.cooperationStartDate),
    defaultDiscountBps: validateDiscountBps(body.defaultDiscountBps),
    defaultStoreKey: boundedText(body.defaultStoreKey, { label: '默认发货门店', max: 40, required: true }),
    invoiceTitle: boundedText(body.invoiceTitle, { label: '发票抬头', max: 120 }),
    taxpayerId: boundedText(body.taxpayerId, { label: '纳税人识别号', max: 40 }),
    contractReference: boundedText(body.contractReference, { label: '合同/档案引用', max: 200 }),
    note: boundedText(body.internalNote, { label: '内部备注', max: 1000 }),
  }
}

function partnerStoreInput(body = {}) {
  return {
    name: boundedText(body.name, { label: '合作门店名称', max: 80, required: true }),
    contactName: boundedText(body.contactName, { label: '门店联系人', max: 50, required: true }),
    phone: boundedText(body.phone, { label: '门店联系电话', max: 30, required: true }),
    province: boundedText(body.province, { label: '省/直辖市', max: 30, required: true }),
    city: boundedText(body.city, { label: '城市', max: 30, required: true }),
    district: boundedText(body.district, { label: '区/县', max: 30, required: true }),
    addressLine: boundedText(body.addressLine, { label: '详细收货地址', max: 200, required: true }),
    status: validatePartnerStoreStatus(body.status || PARTNER_STORE_STATUSES.ACTIVE),
  }
}

function accountInput(body = {}) {
  const username = boundedText(body.username, { label: '用户名', max: 20, required: true })
  const password = String(body.password || '')
  if (username.length < 2) throw bad('用户名需为 2-20 个字符')
  if (password.length < 6 || password.length > 128) throw bad('初始密码需为 6-128 个字符')
  return { username, password }
}

function publicAuditValue(type, value) {
  if (!value) return null
  if (type === 'PARTNER') return partnerAdminFields(value)
  if (type === 'PARTNER_STORE') return partnerStorePublicDto(value)
  if (type === 'PARTNER_USER') return {
    id: value.id,
    userId: value.userId,
    username: value.user?.username || value.username || '',
    status: value.status,
  }
  return null
}

function partnerAdminFields(partner) {
  return {
    ...partnerPublicDto(partner),
    internalNote: partner.note || '',
    defaultStoreKey: partner.defaultStoreKey,
  }
}

export async function writePartnerAudit(tx, { partnerId, entityType, entityId, action, before = null, after = null, user }) {
  const by = actor(user)
  return tx.partnerAuditLog.create({
    data: {
      id: uid(),
      partnerId,
      entityType,
      entityId,
      action,
      before: publicAuditValue(entityType, before),
      after: publicAuditValue(entityType, after),
      actorUserId: by.id,
      actorUsername: by.username,
    },
  })
}

async function requireActiveDefaultStore(tx, key) {
  const store = await tx.store.findUnique({ where: { key } })
  if (!store?.active) throw bad('默认发货门店不存在或已停用', 409)
  return store
}

async function requireUniquePartnerName(tx, name, excludeId = '') {
  const duplicate = await tx.partner.findFirst({
    where: { ...(excludeId ? { id: { not: excludeId } } : {}), name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (duplicate) throw bad('合作商名称已存在', 409)
}

async function requireUniqueUsername(tx, username) {
  const duplicate = await tx.user.findUnique({ where: { username }, select: { id: true } })
  if (duplicate) throw bad('用户名已存在', 409)
}

function newPartnerUser(username, password) {
  return {
    id: uid(),
    username,
    displayName: '',
    role: 'partner',
    storeKeys: [],
    staffKey: '',
    employeeId: '',
    status: 'active',
    bindingLegacyExempt: false,
    operationalIdentityType: 'STANDARD',
    permissions: {},
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  }
}

export async function provisionPartner({ body, currentUser, db = prisma, mirrorUsers = mirrorUsersToKv }) {
  if (!canManagePartnerDomain(currentUser)) throw bad('仅开发者或管理员可管理合作商', 403)
  const profile = partnerInput(body)
  const firstStore = partnerStoreInput(body.store)
  const account = accountInput(body.account)
  const status = validatePartnerStatus(body.status || PARTNER_STATUSES.ACTIVE)
  const by = actor(currentUser)

  const result = await db.$transaction(async (tx) => {
    await requireActiveDefaultStore(tx, profile.defaultStoreKey)
    await requireUniquePartnerName(tx, profile.name)
    await requireUniqueUsername(tx, account.username)

    const partner = await tx.partner.create({
      data: {
        id: uid(),
        ...profile,
        ...partnerLifecycleFields(status),
        createdBy: by.username,
        updatedBy: by.username,
      },
    })
    const store = await tx.partnerStore.create({
      data: { id: uid(), partnerId: partner.id, ...firstStore, createdById: by.id, updatedById: by.id },
    })
    const user = await createUser(newPartnerUser(account.username, account.password), { client: tx, mirror: false })
    const binding = await tx.partnerUser.create({
      data: { id: uid(), partnerId: partner.id, userId: user.id, status: PARTNER_USER_STATUSES.ACTIVE, createdById: by.id },
      include: { user: { select: { username: true } } },
    })
    await writePartnerAudit(tx, { partnerId: partner.id, entityType: 'PARTNER', entityId: partner.id, action: 'PARTNER_CREATED', after: partner, user: currentUser })
    await writePartnerAudit(tx, { partnerId: partner.id, entityType: 'PARTNER_STORE', entityId: store.id, action: 'PARTNER_STORE_CREATED', after: store, user: currentUser })
    await writePartnerAudit(tx, { partnerId: partner.id, entityType: 'PARTNER_USER', entityId: binding.id, action: 'PARTNER_USER_PROVISIONED', after: binding, user: currentUser })
    return { partnerId: partner.id }
  })
  await mirrorUsers().catch(() => {})
  return result
}

export async function provisionPartnerUser({ partnerId, body, currentUser, db = prisma, mirrorUsers = mirrorUsersToKv }) {
  if (!canManagePartnerDomain(currentUser)) throw bad('仅开发者或管理员可管理合作商', 403)
  const account = accountInput(body)
  const by = actor(currentUser)
  const result = await db.$transaction(async (tx) => {
    const partner = await tx.partner.findUnique({ where: { id: partnerId }, select: { id: true, status: true } })
    if (!partner) throw bad('合作商不存在', 404)
    if (partner.status === PARTNER_STATUSES.TERMINATED) throw bad('已停止合作，不能创建登录账号', 409)
    const activeCount = await tx.partnerUser.count({ where: { partnerId, status: PARTNER_USER_STATUSES.ACTIVE } })
    if (activeCount >= 1) throw bad('1.0 当前只允许一个启用中的合作商账号', 409)
    await requireUniqueUsername(tx, account.username)
    const user = await createUser(newPartnerUser(account.username, account.password), { client: tx, mirror: false })
    const binding = await tx.partnerUser.create({
      data: { id: uid(), partnerId, userId: user.id, status: PARTNER_USER_STATUSES.ACTIVE, createdById: by.id },
      include: { user: { select: { username: true } } },
    })
    await writePartnerAudit(tx, { partnerId, entityType: 'PARTNER_USER', entityId: binding.id, action: 'PARTNER_USER_PROVISIONED', after: binding, user: currentUser })
    return { partnerUserId: binding.id }
  })
  await mirrorUsers().catch(() => {})
  return result
}

const adminInclude = {
  defaultStore: { select: { key: true, name: true } },
  partnerStores: { orderBy: [{ status: 'asc' }, { name: 'asc' }] },
  partnerUsers: {
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, username: true, status: true, createdAt: true } } },
  },
  auditLogs: { orderBy: { createdAt: 'desc' }, take: 100 },
  _count: { select: { supplyOrders: true } },
}

function adminPartnerDto(row) {
  return {
    ...partnerAdminFields(row),
    defaultStoreName: row.defaultStore?.name || '',
    stores: (row.partnerStores || []).map(partnerStorePublicDto),
    users: (row.partnerUsers || []).map((binding) => ({
      id: binding.id,
      userId: binding.userId,
      username: binding.user?.username || '',
      userStatus: binding.user?.status || '',
      status: binding.status,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    })),
    audits: (row.auditLogs || []).map((log) => ({
      id: log.id,
      entityType: log.entityType,
      entityId: log.entityId,
      action: log.action,
      before: log.before,
      after: log.after,
      actorUserId: log.actorUserId,
      actorUsername: log.actorUsername,
      createdAt: log.createdAt,
    })),
    legacySupplyOrderCount: row._count?.supplyOrders || 0,
  }
}

async function loadAdminPartner(db, id) {
  const row = await db.partner.findUnique({ where: { id }, include: adminInclude })
  if (!row) throw bad('合作商不存在', 404)
  return adminPartnerDto(row)
}

export function createPartnerDomainRouter({ db = prisma, mirrorUsers = mirrorUsersToKv } = {}) {
  const router = Router()
  const wrap = (handler) => async (req, res) => {
    try {
      if (db === prisma && !dbReady()) throw bad('数据库未配置', 503)
      if (!canManagePartnerDomain(req.user)) throw bad('仅开发者或管理员可管理合作商', 403)
      await handler(req, res)
    } catch (error) {
      const status = Number(error?.status) || (error?.code === 'P2002' ? 409 : error?.code === 'P2034' ? 409 : 500)
      // Provisioning payload may contain an initial password; never log the
      // thrown request/error object because driver diagnostics can echo input.
      if (status >= 500) console.error('[partner-domain]', error?.code || 'PARTNER_DOMAIN_ERROR')
      res.status(status).json({ error: status === 409 && error?.code === 'P2002' ? '数据已存在或发生唯一性冲突' : error?.message || '服务器错误' })
    }
  }

  const reviewWrap = (handler) => async (req, res) => {
    try {
      if (db === prisma && !dbReady()) throw bad('数据库未配置', 503)
      await handler(req, res)
    } catch (error) {
      const status = Number(error?.status) || (['P2002', 'P2034'].includes(error?.code) ? 409 : 500)
      if (status >= 500) console.error('[partner-replenishment-review]', error?.code || 'REPLENISHMENT_REVIEW_ERROR')
      res.status(status).json({
        error: status >= 500 ? 'REPLENISHMENT_REVIEW_FAILED' : error?.code || 'REPLENISHMENT_REVIEW_FAILED',
        message: status >= 500 ? '服务器错误' : error?.message || '审核失败',
      })
    }
  }

  const shipmentWrap = (handler) => async (req, res) => {
    try {
      if (db === prisma && !dbReady()) throw bad('数据库未配置', 503)
      await handler(req, res)
    } catch (error) {
      const status = Number(error?.status) || (['P2002', 'P2034', '23505', '40001', '40P01'].includes(error?.code) ? 409 : 500)
      if (status >= 500) console.error('[partner-replenishment-shipment]', error?.code || 'REPLENISHMENT_SHIPMENT_ERROR')
      res.status(status).json({
        error: status >= 500 ? 'REPLENISHMENT_SHIPMENT_FAILED' : error?.code || 'REPLENISHMENT_SHIPMENT_FAILED',
        message: status >= 500 ? '服务器错误' : error?.message || '发货失败',
      })
    }
  }

  router.get('/partner-management/partners', wrap(async (req, res) => {
    const rows = await db.partner.findMany({
      include: { defaultStore: { select: { name: true } }, _count: { select: { partnerStores: true, partnerUsers: true, supplyOrders: true } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      take: 500,
    })
    res.json({ rows: rows.map((row) => ({
      ...partnerAdminFields(row),
      defaultStoreName: row.defaultStore?.name || '',
      storeCount: row._count.partnerStores,
      userCount: row._count.partnerUsers,
      legacySupplyOrderCount: row._count.supplyOrders,
    })) })
  }))

  router.post('/partner-management/partners', wrap(async (req, res) => {
    const created = await provisionPartner({ body: req.body, currentUser: req.user, db, mirrorUsers })
    res.status(201).json({ ok: true, partner: await loadAdminPartner(db, created.partnerId) })
  }))

  router.get('/partner-management/partners/:id', wrap(async (req, res) => {
    res.json({ partner: await loadAdminPartner(db, req.params.id) })
  }))

  router.put('/partner-management/partners/:id', wrap(async (req, res) => {
    const data = partnerInput(req.body)
    const version = Number(req.body?.version)
    if (!Number.isSafeInteger(version) || version < 1) throw bad('合作商版本不正确，请刷新后重试')
    await db.$transaction(async (tx) => {
      const before = await tx.partner.findUnique({ where: { id: req.params.id } })
      if (!before) throw bad('合作商不存在', 404)
      await requireActiveDefaultStore(tx, data.defaultStoreKey)
      await requireUniquePartnerName(tx, data.name, before.id)
      const changed = await tx.partner.updateMany({
        where: { id: before.id, version },
        data: { ...data, updatedBy: req.user.username, version: { increment: 1 } },
      })
      if (changed.count !== 1) throw bad('合作商已被其他人修改，请刷新后重试', 409)
      const after = await tx.partner.findUnique({ where: { id: before.id } })
      await writePartnerAudit(tx, { partnerId: before.id, entityType: 'PARTNER', entityId: before.id, action: 'PARTNER_UPDATED', before, after, user: req.user })
      if (before.defaultDiscountBps !== after.defaultDiscountBps) {
        await writePartnerAudit(tx, { partnerId: before.id, entityType: 'PARTNER', entityId: before.id, action: 'PARTNER_DISCOUNT_CHANGED', before, after, user: req.user })
      }
    })
    res.json({ ok: true, partner: await loadAdminPartner(db, req.params.id) })
  }))

  router.put('/partner-management/partners/:id/status', wrap(async (req, res) => {
    const status = validatePartnerStatus(req.body?.status)
    const version = Number(req.body?.version)
    if (!Number.isSafeInteger(version) || version < 1) throw bad('合作商版本不正确，请刷新后重试')
    await db.$transaction(async (tx) => {
      const before = await tx.partner.findUnique({ where: { id: req.params.id } })
      if (!before) throw bad('合作商不存在', 404)
      const changed = await tx.partner.updateMany({
        where: { id: before.id, version },
        data: { ...partnerLifecycleFields(status), updatedBy: req.user.username, version: { increment: 1 } },
      })
      if (changed.count !== 1) throw bad('合作商已被其他人修改，请刷新后重试', 409)
      const after = await tx.partner.findUnique({ where: { id: before.id } })
      await writePartnerAudit(tx, { partnerId: before.id, entityType: 'PARTNER', entityId: before.id, action: 'PARTNER_STATUS_CHANGED', before, after, user: req.user })
    })
    res.json({ ok: true, partner: await loadAdminPartner(db, req.params.id) })
  }))

  router.post('/partner-management/partners/:id/stores', wrap(async (req, res) => {
    const data = partnerStoreInput(req.body)
    const by = actor(req.user)
    const store = await db.$transaction(async (tx) => {
      const partner = await tx.partner.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } })
      if (!partner) throw bad('合作商不存在', 404)
      if (partner.status === PARTNER_STATUSES.TERMINATED) throw bad('已停止合作，不能新增合作门店', 409)
      const created = await tx.partnerStore.create({ data: { id: uid(), partnerId: partner.id, ...data, createdById: by.id, updatedById: by.id } })
      await writePartnerAudit(tx, { partnerId: partner.id, entityType: 'PARTNER_STORE', entityId: created.id, action: 'PARTNER_STORE_CREATED', after: created, user: req.user })
      return created
    })
    res.status(201).json({ ok: true, store: partnerStorePublicDto(store) })
  }))

  router.put('/partner-management/partners/:partnerId/stores/:storeId', wrap(async (req, res) => {
    const data = partnerStoreInput(req.body)
    const version = Number(req.body?.version)
    if (!Number.isSafeInteger(version) || version < 1) throw bad('合作门店版本不正确，请刷新后重试')
    const by = actor(req.user)
    const store = await db.$transaction(async (tx) => {
      const before = await tx.partnerStore.findFirst({ where: { id: req.params.storeId, partnerId: req.params.partnerId } })
      if (!before) throw bad('合作门店不存在', 404)
      const changed = await tx.partnerStore.updateMany({
        where: { id: before.id, partnerId: before.partnerId, version },
        data: { ...data, updatedById: by.id, version: { increment: 1 } },
      })
      if (changed.count !== 1) throw bad('合作门店已被其他人修改，请刷新后重试', 409)
      const after = await tx.partnerStore.findUnique({ where: { id: before.id } })
      await writePartnerAudit(tx, { partnerId: before.partnerId, entityType: 'PARTNER_STORE', entityId: before.id, action: 'PARTNER_STORE_UPDATED', before, after, user: req.user })
      return after
    })
    res.json({ ok: true, store: partnerStorePublicDto(store) })
  }))

  router.post('/partner-management/partners/:id/users', wrap(async (req, res) => {
    const created = await provisionPartnerUser({ partnerId: req.params.id, body: req.body, currentUser: req.user, db, mirrorUsers })
    res.status(201).json({ ok: true, partnerUserId: created.partnerUserId })
  }))

  router.put('/partner-management/partners/:partnerId/users/:partnerUserId/status', wrap(async (req, res) => {
    const status = validatePartnerUserStatus(req.body?.status)
    await db.$transaction(async (tx) => {
      const before = await tx.partnerUser.findFirst({
        where: { id: req.params.partnerUserId, partnerId: req.params.partnerId },
        include: { user: { select: { username: true } } },
      })
      if (!before) throw bad('合作商账号不存在', 404)
      if (status === PARTNER_USER_STATUSES.ACTIVE) {
        const activeCount = await tx.partnerUser.count({
          where: { partnerId: before.partnerId, status: PARTNER_USER_STATUSES.ACTIVE, id: { not: before.id } },
        })
        if (activeCount >= 1) throw bad('1.0 当前只允许一个启用中的合作商账号', 409)
      }
      const by = actor(req.user)
      const after = await tx.partnerUser.update({
        where: { id: before.id },
        data: {
          status,
          disabledAt: status === PARTNER_USER_STATUSES.DISABLED ? new Date() : null,
          disabledById: status === PARTNER_USER_STATUSES.DISABLED ? by.id : '',
        },
        include: { user: { select: { username: true } } },
      })
      await writePartnerAudit(tx, {
        partnerId: before.partnerId,
        entityType: 'PARTNER_USER',
        entityId: before.id,
        action: status === PARTNER_USER_STATUSES.ACTIVE ? 'PARTNER_USER_ENABLED' : 'PARTNER_USER_DISABLED',
        before,
        after,
        user: req.user,
      })
    })
    res.json({ ok: true })
  }))

  router.post('/partner-management/replenishment-orders', wrap(async (req, res) => {
    const result = await createReplenishmentOrder({
      db,
      createdByType: REPLENISHMENT_CREATED_BY_TYPES.INTERNAL,
      actor: { id: req.user.id, name: req.user.username },
      body: req.body,
      idempotencyKey: req.get('Idempotency-Key'),
    })
    res.status(result.reused ? 200 : 201).json({ ok: true, reused: result.reused, order: serializeReplenishmentOrder(result.order, { internal: true }) })
  }))

  router.get('/partner-management/replenishment-orders', reviewWrap(async (req, res) => {
    const result = await listReplenishmentReviewOrders({ db, actor: { id: req.user.id }, status: req.query.status })
    res.json({
      authority: { type: result.authorization.authority, businessDate: result.authorization.businessDate },
      rows: result.rows.map((row) => serializeReplenishmentOrder(row, { internal: true })),
    })
  }))

  router.get('/partner-management/replenishment-orders/:id', reviewWrap(async (req, res) => {
    const result = await getReplenishmentReviewOrder({ db, actor: { id: req.user.id }, orderId: req.params.id })
    res.json({
      authority: { type: result.authorization.authority, businessDate: result.authorization.businessDate },
      order: serializeReplenishmentOrder(result.order, { internal: true }),
    })
  }))

  router.post('/partner-management/replenishment-orders/:id/review-preview', reviewWrap(async (req, res) => {
    const preview = await previewReplenishmentApproval({ db, actor: { id: req.user.id }, orderId: req.params.id, body: req.body })
    res.json({ preview })
  }))

  router.post('/partner-management/replenishment-orders/:id/approve', reviewWrap(async (req, res) => {
    const result = await reviewReplenishmentOrder({
      db,
      actor: { id: req.user.id },
      orderId: req.params.id,
      action: REPLENISHMENT_REVIEW_ACTIONS.APPROVE,
      body: req.body,
      idempotencyKey: req.get('Idempotency-Key'),
    })
    await deliverPartnerReplenishmentStockingNotification({ prismaClient: db, order: result.order }).catch((error) => {
      console.error('[partner-stocking-notification]', String(error?.message || 'notification delivery failed').slice(0, 200))
    })
    res.status(result.reused ? 200 : 201).json({ ok: true, reused: result.reused, order: serializeReplenishmentOrder(result.order, { internal: true }) })
  }))

  router.post('/partner-management/replenishment-orders/:id/reject', reviewWrap(async (req, res) => {
    const result = await reviewReplenishmentOrder({
      db,
      actor: { id: req.user.id },
      orderId: req.params.id,
      action: REPLENISHMENT_REVIEW_ACTIONS.REJECT,
      body: req.body,
      idempotencyKey: req.get('Idempotency-Key'),
    })
    res.status(result.reused ? 200 : 201).json({ ok: true, reused: result.reused, order: serializeReplenishmentOrder(result.order, { internal: true }) })
  }))

  router.get('/partner-management/fulfillment-stores', shipmentWrap(async (req, res) => {
    const result = await listFulfillmentStores({ db, actor: { id: req.user.id } })
    res.json({
      authority: { type: result.authorization.authority, businessDate: result.authorization.businessDate },
      rows: result.rows,
      defaultStoreKey: 'guanshe',
    })
  }))

  router.post('/partner-management/replenishment-orders/:id/shipments', shipmentWrap(async (req, res) => {
    const result = await createReplenishmentShipment({
      db,
      actor: { id: req.user.id },
      orderId: req.params.id,
      body: req.body,
      idempotencyKey: req.get('Idempotency-Key'),
    })
    const order = await getInternalReplenishmentOrder({ db, orderId: req.params.id })
    res.status(result.reused ? 200 : 201).json({
      ok: true,
      reused: result.reused,
      order: serializeReplenishmentOrder(order, { internal: true }),
    })
  }))

  router.get('/partner-management/after-sales', wrap(async (req, res) => {
    const rows = await listInternalAfterSales({ db, actor: { id: req.user.id } })
    res.json({ rows: rows.map((row) => ({ ...afterSalesDto(row, { internal: true }), partnerName: row.partner?.name || '' })) })
  }))

  router.post('/partner-management/after-sales/:id/process', wrap(async (req, res) => {
    const row = await processInternalAfterSales({ db, actor: { id: req.user.id }, requestId: req.params.id, body: req.body })
    res.json({ ok: true, request: afterSalesDto(row, { internal: true }) })
  }))

  router.get('/partner-management/after-sales/:requestId/attachments/:attachmentId', wrap(async (req, res) => {
    const attachment = await getInternalAfterSalesAttachment({ db, actor: { id: req.user.id }, requestId: req.params.requestId, attachmentId: req.params.attachmentId })
    res.json({ attachment })
  }))

  return router
}
