import express from 'express'
import { getUserByUsername } from './user-store.js'
import { verifyPassword } from './auth.js'
import { prisma } from './pg.js'
import {
  EXTERNAL_SESSION_TTL_MS,
  authenticateExternalSession,
  createExternalSession,
  revokeExternalSession,
} from './external-session.js'
import {
  PARTNER_ROLE,
  PRINCIPAL_TYPES,
  assertPartnerPrincipal,
  partnerScopedWhere,
  resolveExternalPrincipal,
} from './principals.js'
import {
  PARTNER_STATUSES,
  partnerPublicDto,
  partnerStorePublicDto,
} from './partner-domain-policy.js'
import {
  listPartnerCatalogue,
  quotePartnerCatalogueItem,
} from './partner-replenishment-catalogue.js'
import {
  REPLENISHMENT_CREATED_BY_TYPES,
  cancelPartnerReplenishmentOrder,
  createReplenishmentOrder,
  getPartnerReplenishmentOrder,
  listPartnerReplenishmentOrders,
  serializeReplenishmentOrder,
} from './replenishment-order-service.js'
import {
  afterSalesDto,
  createPartnerAfterSales,
  getPartnerAfterSalesAttachment,
  listPartnerAfterSales,
} from './replenishment-after-sales-service.js'

export const PARTNER_SESSION_COOKIE = 'budu_partner_token'
export const PARTNER_SESSION_TTL_MS = EXTERNAL_SESSION_TTL_MS

function denied(code = 'PARTNER_PRINCIPAL_DENIED', status = 401) {
  return Object.assign(new Error(code), { status })
}

function isAfter(value, boundary) {
  return value instanceof Date && boundary instanceof Date && value.getTime() > boundary.getTime()
}

export async function resolvePartnerBinding({ userId, sessionCreatedAt = null, db = prisma }) {
  const bindings = await db.partnerUser.findMany({
    where: { userId: String(userId || '') },
    include: { partner: true },
    take: 2,
  })
  if (bindings.length !== 1) throw denied()
  const binding = bindings[0]
  const partnerStatus = binding.partner?.status || (binding.partner?.isActive === true ? PARTNER_STATUSES.ACTIVE : '')
  if (binding.status !== 'active' || !Object.values(PARTNER_STATUSES).includes(partnerStatus)) throw denied()
  // Any binding/Partner mutation after issuance invalidates the old session.
  // Gate 2 can replace this conservative epoch with an explicit auth version.
  if (sessionCreatedAt && (isAfter(binding.updatedAt, sessionCreatedAt)
      || isAfter(binding.partner.updatedAt, sessionCreatedAt))) throw denied('PARTNER_SESSION_STALE')
  return assertPartnerPrincipal({
    type: PRINCIPAL_TYPES.PARTNER,
    userId: String(userId),
    partnerUserId: binding.id,
    partnerId: binding.partnerId,
  })
}

export async function createPartnerSession({ user, markerKey, db = prisma, now = new Date() }) {
  const basePrincipal = resolveExternalPrincipal(user, PRINCIPAL_TYPES.PARTNER)
  if (!basePrincipal) throw denied()
  const principal = await resolvePartnerBinding({ userId: basePrincipal.userId, db })
  const session = await createExternalSession({
    userId: basePrincipal.userId,
    principalType: PRINCIPAL_TYPES.PARTNER,
    markerKey,
    db,
    now,
    ttlMs: PARTNER_SESSION_TTL_MS,
  })
  return { ...session, principal }
}

export async function authenticatePartnerSession({ rawToken, markerKey, db = prisma, now = new Date() }) {
  const session = await authenticateExternalSession({
    rawToken,
    principalType: PRINCIPAL_TYPES.PARTNER,
    markerKey,
    db,
    now,
  })
  const principal = await resolvePartnerBinding({
    userId: session.userId,
    sessionCreatedAt: session.createdAt,
    db,
  })
  return { ...session, principal }
}

function cookieOptions({ includeMaxAge = true } = {}) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === '1',
    path: '/api/partner',
    ...(includeMaxAge ? { maxAge: PARTNER_SESSION_TTL_MS } : {}),
  }
}

function publicPartnerPrincipal(principal, partner, user = null) {
  return {
    type: principal.type,
    partner: { id: principal.partnerId, name: String(partner?.name || ''), status: partner?.status || '' },
    ...(user?.username ? { account: { username: String(user.username) } } : {}),
  }
}

export function createPartnerAuthRouter({
  db = prisma,
  userByUsername = getUserByUsername,
  secretLoader = async () => process.env.JWT_SECRET,
} = {}) {
  const router = express.Router()

  const requirePartnerPrincipal = async (req, res, next) => {
    try {
      const session = await authenticatePartnerSession({
        rawToken: req.cookies?.[PARTNER_SESSION_COOKIE],
        markerKey: await secretLoader(),
        db,
      })
      req.principal = session.principal
      req.partnerSession = session
      return next()
    } catch {
      return res.status(401).json({ error: 'PARTNER_SESSION_DENIED' })
    }
  }

  router.post('/auth/login', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (['partnerId', 'userId', 'principal', 'principalType', 'role'].some(key => Object.hasOwn(body, key))) {
      return res.status(400).json({ error: 'PARTNER_AUTHORITY_INPUT_REJECTED' })
    }
    try {
      const username = String(body.username || '').trim()
      const password = String(body.password || '')
      const user = await userByUsername(username)
      if (!user || !verifyPassword(password, user.passwordHash)
          || user.role !== PARTNER_ROLE || user.status !== 'active') throw denied('PARTNER_LOGIN_DENIED')
      const markerKey = await secretLoader()
      const priorToken = req.cookies?.[PARTNER_SESSION_COOKIE]
      if (priorToken) {
        await revokeExternalSession({
          rawToken: priorToken,
          principalType: PRINCIPAL_TYPES.PARTNER,
          markerKey,
          db,
        }).catch(() => {})
      }
      const issued = await createPartnerSession({ user, markerKey, db })
      const partner = await db.partner.findUnique({ where: { id: issued.principal.partnerId } })
      res.cookie(PARTNER_SESSION_COOKIE, issued.rawToken, cookieOptions())
      return res.json({
        principal: publicPartnerPrincipal(issued.principal, partner, user),
        expiresAt: issued.expiresAt.toISOString(),
      })
    } catch {
      return res.status(401).json({ error: 'PARTNER_LOGIN_DENIED' })
    }
  })

  router.get('/auth/me', requirePartnerPrincipal, async (req, res) => {
    const [partner, user] = await Promise.all([
      db.partner.findUnique({ where: { id: req.principal.partnerId } }),
      db.user?.findUnique ? db.user.findUnique({ where: { id: req.principal.userId }, select: { username: true } }) : null,
    ])
    return res.json({ principal: publicPartnerPrincipal(req.principal, partner, user) })
  })

  router.post('/auth/logout', async (req, res) => {
    const rawToken = req.cookies?.[PARTNER_SESSION_COOKIE]
    if (rawToken) {
      try {
        await revokeExternalSession({
          rawToken,
          principalType: PRINCIPAL_TYPES.PARTNER,
          markerKey: await secretLoader(),
          db,
        })
      } catch {
        // Logout remains idempotent and always clears this cookie namespace.
      }
    }
    res.clearCookie(PARTNER_SESSION_COOKIE, cookieOptions({ includeMaxAge: false }))
    return res.json({ ok: true })
  })

  router.use(requirePartnerPrincipal)

  const rejectTenantAuthorityInput = (req, res, next) => {
    if (Object.hasOwn(req.query || {}, 'partnerId') || Object.hasOwn(req.body || {}, 'partnerId')) {
      return res.status(400).json({ error: 'PARTNER_AUTHORITY_INPUT_REJECTED' })
    }
    return next()
  }

  router.use(rejectTenantAuthorityInput)

  router.get('/profile', async (req, res) => {
    const partner = await db.partner.findUnique({ where: { id: req.principal.partnerId } })
    if (!partner) return res.status(404).json({ error: 'PARTNER_PROFILE_NOT_FOUND' })
    return res.json({ partner: partnerPublicDto(partner) })
  })

  router.get('/stores', async (req, res) => {
    const rows = await db.partnerStore.findMany({
      where: partnerScopedWhere(req.principal),
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      take: 500,
    })
    return res.json({ rows: rows.map(partnerStorePublicDto) })
  })

  router.get('/stores/:id', async (req, res) => {
    const store = await db.partnerStore.findFirst({
      where: partnerScopedWhere(req.principal, { id: req.params.id }),
    })
    if (!store) return res.status(404).json({ error: 'PARTNER_STORE_NOT_FOUND' })
    return res.json({ store: partnerStorePublicDto(store) })
  })

  router.get('/catalogue', async (req, res) => {
    try {
      return res.json({ rows: await listPartnerCatalogue({ db, principal: req.principal }) })
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.code || 'PARTNER_CATALOGUE_FAILED', message: error.message })
    }
  })

  router.post('/catalogue/quote', async (req, res) => {
    try {
      const quote = await quotePartnerCatalogueItem({ db, principal: req.principal, body: req.body })
      return res.json({ quote })
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.code || 'PARTNER_QUOTE_FAILED', message: error.message })
    }
  })

  const orderHandler = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const status = Number(error?.status) || 500
      if (status >= 500) console.error('[partner-replenishment-order]', error?.code || 'REPLENISHMENT_ORDER_FAILED')
      return res.status(status).json({
        error: status >= 500 ? 'REPLENISHMENT_ORDER_FAILED' : error.code || 'REPLENISHMENT_ORDER_FAILED',
        message: status >= 500 ? '服务器错误' : error.message,
      })
    }
  }

  router.post('/replenishment-orders', orderHandler(async (req, res) => {
    const result = await createReplenishmentOrder({
      db,
      createdByType: REPLENISHMENT_CREATED_BY_TYPES.PARTNER,
      actor: { id: req.principal.userId },
      principalPartnerId: req.principal.partnerId,
      body: req.body,
      idempotencyKey: req.get('Idempotency-Key'),
    })
    return res.status(result.reused ? 200 : 201).json({ ok: true, reused: result.reused, order: serializeReplenishmentOrder(result.order) })
  }))

  router.get('/replenishment-orders', orderHandler(async (req, res) => {
    const rows = await listPartnerReplenishmentOrders({ db, principal: req.principal })
    return res.json({ rows: rows.map((row) => serializeReplenishmentOrder(row)) })
  }))

  router.get('/replenishment-orders/:id', orderHandler(async (req, res) => {
    const order = await getPartnerReplenishmentOrder({ db, principal: req.principal, orderId: req.params.id })
    if (!order) return res.status(404).json({ error: 'REPLENISHMENT_ORDER_NOT_FOUND' })
    return res.json({ order: serializeReplenishmentOrder(order) })
  }))

  router.post('/replenishment-orders/:id/cancel', orderHandler(async (req, res) => {
    const result = await cancelPartnerReplenishmentOrder({ db, principal: req.principal, orderId: req.params.id })
    return res.json({ ok: true, reused: result.reused, order: serializeReplenishmentOrder(result.order) })
  }))

  router.get('/after-sales', orderHandler(async (req, res) => {
    const rows = await listPartnerAfterSales({ db, principal: req.principal })
    return res.json({ rows: rows.map((row) => afterSalesDto(row)) })
  }))

  router.post('/after-sales', orderHandler(async (req, res) => {
    const row = await createPartnerAfterSales({ db, principal: req.principal, body: req.body })
    return res.status(201).json({ ok: true, request: afterSalesDto(row) })
  }))

  router.get('/after-sales/:requestId/attachments/:attachmentId', orderHandler(async (req, res) => {
    const attachment = await getPartnerAfterSalesAttachment({ db, principal: req.principal, requestId: req.params.requestId, attachmentId: req.params.attachmentId })
    return res.json({ attachment })
  }))

  router.use((req, res) => res.status(404).json({ error: 'PARTNER_API_NOT_IMPLEMENTED' }))
  return router
}
