import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { listUsers } from './user-store.js'
import { publicBaseUrl, pushWechat } from './notification-center.js'
import { MODULE_KEYS, hasModuleAccess, isSuperUser } from '../shared/accountPermissions.js'
import {
  CUSTOMER_REQUEST_STATUS,
  CUSTOMER_REQUEST_TTL_MS,
  CUSTOMER_REQUEST_TYPES,
  createCustomerToken,
  createFixedWindowLimiter,
  customerRequestPublicUrl,
  hashCustomerToken,
  httpError,
  safeRateKey,
  serializePublicRequest,
  validateInvoiceMetadata,
  validateInvoiceSubmission,
  validateMailingMetadata,
  validateMailingSubmission,
} from './customer-request-core.js'

export const customerRequestRouter = Router()
export const publicCustomerRequestRouter = Router()

const publicReadLimiter = createFixedWindowLimiter({ limit: 30, windowMs: 10 * 60 * 1000 })
const publicSubmitLimiter = createFixedWindowLimiter({ limit: 8, windowMs: 10 * 60 * 1000 })

const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (error) {
    const status = error.status || 500
    if (status >= 500) console.error('[customer-request]', error.message)
    res.status(status).json({ error: error.message || '服务器错误' })
  }
}

function requireDatabase() {
  if (!dbReady()) throw httpError('数据库未配置', 503)
}

function canUseType(user, type) {
  if (type === CUSTOMER_REQUEST_TYPES.MAILING) return hasModuleAccess(user, MODULE_KEYS.STORE_MAILING)
  if (type === CUSTOMER_REQUEST_TYPES.INVOICE) return hasModuleAccess(user, MODULE_KEYS.FINANCE_INVOICE)
  return false
}

function canUseStore(user, storeKey) {
  return Boolean(user && (isSuperUser(user) || (Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey))))
}

function normalizeType(raw) {
  const type = String(raw || '').toUpperCase()
  if (!Object.values(CUSTOMER_REQUEST_TYPES).includes(type)) throw httpError('请求类型不正确')
  return type
}

function invoiceHandler(users, creator, storeKey) {
  const priority = { finance: 0, admin: 1, developer: 2, manager: 3 }
  const eligible = users
    .filter((user) => user.status !== 'disabled')
    .filter((user) => Object.hasOwn(priority, user.role))
    .filter((user) => hasModuleAccess(user, MODULE_KEYS.FINANCE_INVOICE))
    .filter((user) => isSuperUser(user) || (Array.isArray(user.storeKeys) && user.storeKeys.includes(storeKey)))
    .sort((a, b) => (priority[a.role] - priority[b.role]) || String(a.username).localeCompare(String(b.username)))
  return eligible[0]?.username || creator.username
}

function serializeStaffRequest(request) {
  return {
    id: request.id,
    type: request.type,
    storeKey: request.storeKey,
    status: request.status,
    expiresAt: request.expiresAt,
    submittedAt: request.submittedAt,
    linkedBusinessRecordId: request.linkedBusinessRecordId || '',
    createdAt: request.createdAt,
    requestMetadata: request.requestMetadata,
  }
}

async function expireIfNeeded(prismaClient, tokenRow, now) {
  if (tokenRow.expiresAt > now && tokenRow.request.expiresAt > now) return tokenRow
  await prismaClient.$transaction([
    prismaClient.customerServiceRequestToken.updateMany({
      where: { id: tokenRow.id, status: 'ACTIVE' },
      data: { status: 'INVALIDATED', invalidatedAt: now },
    }),
    prismaClient.customerServiceRequest.updateMany({
      where: { id: tokenRow.requestId, status: CUSTOMER_REQUEST_STATUS.WAITING },
      data: { status: CUSTOMER_REQUEST_STATUS.EXPIRED, updatedAt: now },
    }),
  ])
  throw httpError('二维码已失效，请联系 budu 工作人员重新生成', 410)
}

export async function createCustomerServiceRequest({ prismaClient = prisma, user, input, origin = publicBaseUrl(), now = new Date() }) {
  const type = normalizeType(input?.type)
  const storeKey = String(input?.storeKey || '').trim()
  if (!canUseType(user, type) || !canUseStore(user, storeKey)) throw httpError('无权限', 403)
  const store = await prismaClient.store.findUnique({ where: { key: storeKey } })
  if (!store || !store.active) throw httpError('门店不存在或已停用', 404)
  const metadata = type === CUSTOMER_REQUEST_TYPES.MAILING
    ? validateMailingMetadata(input)
    : validateInvoiceMetadata(input)
  const users = type === CUSTOMER_REQUEST_TYPES.INVOICE ? await listUsers() : []
  const handlerUsername = type === CUSTOMER_REQUEST_TYPES.INVOICE
    ? invoiceHandler(users, user, storeKey)
    : user.username
  const token = createCustomerToken()
  const tokenHash = hashCustomerToken(token)
  const publicUrl = customerRequestPublicUrl(origin, token)
  const expiresAt = new Date(now.getTime() + CUSTOMER_REQUEST_TTL_MS)
  const requestId = uid('csr')
  const tokenId = uid('cst')
  const request = await prismaClient.$transaction(async (tx) => {
    const previous = await tx.customerServiceRequest.findMany({
      where: {
        type,
        storeKey,
        createdByUsername: user.username,
        status: CUSTOMER_REQUEST_STATUS.WAITING,
      },
      select: { id: true },
    })
    if (previous.length) {
      const previousIds = previous.map((row) => row.id)
      await tx.customerServiceRequestToken.updateMany({
        where: { requestId: { in: previousIds }, status: 'ACTIVE' },
        data: { status: 'INVALIDATED', invalidatedAt: now },
      })
      await tx.customerServiceRequest.updateMany({
        where: { id: { in: previousIds }, status: CUSTOMER_REQUEST_STATUS.WAITING },
        data: { status: CUSTOMER_REQUEST_STATUS.CANCELLED, cancelledAt: now, updatedAt: now },
      })
    }
    return tx.customerServiceRequest.create({
      data: {
        id: requestId,
        type,
        storeKey,
        createdByUserId: user.id,
        createdByUsername: user.username,
        handlerUsername,
        status: CUSTOMER_REQUEST_STATUS.WAITING,
        expiresAt,
        requestMetadata: metadata,
        tokens: {
          create: {
            id: tokenId,
            tokenHash,
            status: 'ACTIVE',
            expiresAt,
          },
        },
      },
    })
  })
  return {
    request: serializeStaffRequest(request),
    publicUrl,
  }
}

export async function resolvePublicCustomerRequest({ prismaClient = prisma, token, now = new Date() }) {
  const tokenHash = hashCustomerToken(token)
  if (!tokenHash) throw httpError('二维码无效或已失效', 404)
  const tokenRow = await prismaClient.customerServiceRequestToken.findUnique({
    where: { tokenHash },
    include: { request: true },
  })
  if (!tokenRow) throw httpError('二维码无效或已失效', 404)
  if (tokenRow.request.status === CUSTOMER_REQUEST_STATUS.SUBMITTED) {
    return serializePublicRequest(tokenRow.request)
  }
  if (tokenRow.status !== 'ACTIVE' || tokenRow.request.status === CUSTOMER_REQUEST_STATUS.CANCELLED) {
    throw httpError('二维码已失效，请联系 budu 工作人员重新生成', 410)
  }
  await expireIfNeeded(prismaClient, tokenRow, now)
  return serializePublicRequest(tokenRow.request)
}

function notificationData(type, request, businessRecordId) {
  if (type === CUSTOMER_REQUEST_TYPES.MAILING) {
    return {
      id: uid('ntf'),
      username: request.handlerUsername,
      templateKey: 'mailing_new',
      title: '新的邮寄信息',
      content: '顾客已提交收件信息，请核对并安排发货。',
      priority: 'normal',
      status: 'unread',
      ackStatus: 'none',
      target: MODULE_KEYS.STORE_MAILING,
      refType: 'mailing',
      refId: businessRecordId,
    }
  }
  return {
    id: uid('ntf'),
    username: request.handlerUsername,
    templateKey: 'invoice_new',
    title: '新的开票申请',
    content: '顾客已提交开票资料，请核对并处理。',
    priority: 'normal',
    status: 'unread',
    ackStatus: 'none',
    target: MODULE_KEYS.FINANCE_INVOICE,
    refType: 'invoice',
    refId: businessRecordId,
  }
}

export async function submitCustomerServiceRequest({ prismaClient = prisma, token, payload, now = new Date() }) {
  const tokenHash = hashCustomerToken(token)
  if (!tokenHash) throw httpError('二维码无效或已失效', 404)
  let committed
  try {
    committed = await prismaClient.$transaction(async (tx) => {
      const tokenRow = await tx.customerServiceRequestToken.findUnique({
        where: { tokenHash },
        include: { request: true },
      })
      if (!tokenRow) throw httpError('二维码无效或已失效', 404)
      if (tokenRow.request.status === CUSTOMER_REQUEST_STATUS.SUBMITTED || tokenRow.status === 'CONSUMED') {
        throw httpError('该资料已经提交，请勿重复提交', 409)
      }
      if (tokenRow.status !== 'ACTIVE' || tokenRow.request.status !== CUSTOMER_REQUEST_STATUS.WAITING) {
        throw httpError('二维码已失效，请联系 budu 工作人员重新生成', 410)
      }
      if (tokenRow.expiresAt <= now || tokenRow.request.expiresAt <= now) {
        throw httpError('二维码已失效，请联系 budu 工作人员重新生成', 410)
      }
      const input = tokenRow.request.type === CUSTOMER_REQUEST_TYPES.MAILING
        ? validateMailingSubmission(payload)
        : validateInvoiceSubmission(payload)
      const tokenClaim = await tx.customerServiceRequestToken.updateMany({
        where: { id: tokenRow.id, status: 'ACTIVE', consumedAt: null, expiresAt: { gt: now } },
        data: { status: 'CONSUMED', consumedAt: now },
      })
      const requestClaim = await tx.customerServiceRequest.updateMany({
        where: { id: tokenRow.requestId, status: CUSTOMER_REQUEST_STATUS.WAITING, expiresAt: { gt: now } },
        data: { status: CUSTOMER_REQUEST_STATUS.SUBMITTED, submittedAt: now, updatedAt: now },
      })
      if (tokenClaim.count !== 1 || requestClaim.count !== 1) {
        throw httpError('该资料已经提交，请勿重复提交', 409)
      }
      const metadata = tokenRow.request.requestMetadata && typeof tokenRow.request.requestMetadata === 'object'
        ? tokenRow.request.requestMetadata
        : {}
      let businessRecord
      if (tokenRow.request.type === CUSTOMER_REQUEST_TYPES.MAILING) {
        const locked = validateMailingMetadata(metadata)
        businessRecord = await tx.mailingRecord.create({
          data: {
            id: uid('mlr'),
            method: locked.method,
            postage: locked.postage,
            fee: locked.fee || null,
            address: input.address,
            recipient: input.recipient,
            phone: input.phone,
            remark: input.remark,
            status: 'pending',
            createdBy: tokenRow.request.createdByUsername,
          },
        })
      } else {
        const locked = validateInvoiceMetadata(metadata)
        const titleType = input.titleType === 'PERSONAL' ? 'personal' : 'company'
        if (titleType === 'company') {
          await tx.invoiceCompany.upsert({
            where: { name: input.invoiceTitle },
            update: { taxNo: input.taxNo, updatedAt: now },
            create: { id: uid('ic'), name: input.invoiceTitle, taxNo: input.taxNo },
          })
        }
        businessRecord = await tx.invoice.create({
          data: {
            id: uid('inv'),
            storeKey: tokenRow.request.storeKey,
            titleType,
            companyName: input.invoiceTitle,
            taxNo: input.taxNo,
            amountCents: BigInt(locked.amountCents),
            category: locked.category,
            email: input.email,
            note: input.note,
            status: 'pending',
            createdBy: tokenRow.request.createdByUsername,
          },
        })
      }
      await tx.customerServiceRequest.update({
        where: { id: tokenRow.requestId },
        data: { linkedBusinessRecordId: businessRecord.id, updatedAt: now },
      })
      const notification = await tx.notification.create({
        data: notificationData(tokenRow.request.type, tokenRow.request, businessRecord.id),
      })
      await tx.notificationDelivery.create({
        data: { id: uid('nld'), notificationId: notification.id, channel: 'inapp', status: 'sent' },
      })
      return { type: tokenRow.request.type, notification }
    })
  } catch (error) {
    if (error?.code === 'P2034') throw httpError('该资料已经提交，请勿重复提交', 409)
    throw error
  }
  pushWechat(committed.notification, committed.notification.title, committed.notification.content, committed.notification.target).catch(() => {})
  return { ok: true, type: committed.type, status: CUSTOMER_REQUEST_STATUS.SUBMITTED }
}

export async function cancelCustomerServiceRequest({ prismaClient = prisma, requestId, user, now = new Date() }) {
  const request = await prismaClient.customerServiceRequest.findUnique({ where: { id: requestId } })
  if (!request) throw httpError('顾客请求不存在', 404)
  if (!canUseType(user, request.type) || !canUseStore(user, request.storeKey)) throw httpError('无权限', 403)
  if (request.status !== CUSTOMER_REQUEST_STATUS.WAITING) throw httpError('该二维码已不能取消', 409)
  await prismaClient.$transaction([
    prismaClient.customerServiceRequestToken.updateMany({
      where: { requestId, status: 'ACTIVE' },
      data: { status: 'INVALIDATED', invalidatedAt: now },
    }),
    prismaClient.customerServiceRequest.update({
      where: { id: requestId },
      data: { status: CUSTOMER_REQUEST_STATUS.CANCELLED, cancelledAt: now, updatedAt: now },
    }),
  ])
  return request
}

function publicToken(req) {
  const value = String(req.get('X-Customer-Request-Token') || '')
  if (!value) throw httpError('二维码无效或已失效', 404)
  return value
}

function applyPublicRateLimit(req, res, token, limiter) {
  const tokenHash = hashCustomerToken(token)
  const ipResult = limiter.consume(`ip:${safeRateKey(req.ip, '')}`)
  const tokenResult = limiter.consume(`token:${tokenHash || 'invalid'}`)
  res.setHeader('X-RateLimit-Remaining', String(Math.min(ipResult.remaining, tokenResult.remaining)))
  if (!ipResult.allowed || !tokenResult.allowed) {
    res.setHeader('Retry-After', String(Math.max(ipResult.retryAfterSeconds, tokenResult.retryAfterSeconds)))
    throw httpError('请求过于频繁，请稍后再试', 429)
  }
}

publicCustomerRequestRouter.get('/customer-request', wrap(async (req, res) => {
  requireDatabase()
  const token = publicToken(req)
  applyPublicRateLimit(req, res, token, publicReadLimiter)
  const request = await resolvePublicCustomerRequest({ token })
  res.json({ ok: true, request })
}))

publicCustomerRequestRouter.post('/customer-request/submit', wrap(async (req, res) => {
  requireDatabase()
  if (!req.is('application/json')) throw httpError('请求格式不正确', 415)
  const token = publicToken(req)
  applyPublicRateLimit(req, res, token, publicSubmitLimiter)
  const result = await submitCustomerServiceRequest({ token, payload: req.body || {} })
  res.status(201).json(result)
}))

customerRequestRouter.post('/customer-requests', wrap(async (req, res) => {
  requireDatabase()
  const result = await createCustomerServiceRequest({ user: req.user, input: req.body || {} })
  res.status(201).json({ ok: true, ...result })
}))

customerRequestRouter.get('/customer-requests', wrap(async (req, res) => {
  requireDatabase()
  const type = normalizeType(req.query.type)
  if (!canUseType(req.user, type)) throw httpError('无权限', 403)
  const where = { type }
  if (!isSuperUser(req.user)) {
    where.storeKey = { in: Array.isArray(req.user.storeKeys) ? req.user.storeKeys : [] }
  }
  const rows = await prisma.customerServiceRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
  res.json({ ok: true, rows: rows.map(serializeStaffRequest) })
}))

customerRequestRouter.post('/customer-requests/:id/cancel', wrap(async (req, res) => {
  requireDatabase()
  await cancelCustomerServiceRequest({ requestId: req.params.id, user: req.user })
  res.json({ ok: true })
}))

customerRequestRouter.post('/customer-requests/:id/regenerate', wrap(async (req, res) => {
  requireDatabase()
  const request = await prisma.customerServiceRequest.findUnique({ where: { id: req.params.id } })
  if (!request) throw httpError('顾客请求不存在', 404)
  if (!canUseType(req.user, request.type) || !canUseStore(req.user, request.storeKey)) throw httpError('无权限', 403)
  if (request.status !== CUSTOMER_REQUEST_STATUS.WAITING) throw httpError('该二维码已不能重新生成', 409)
  const metadata = request.requestMetadata && typeof request.requestMetadata === 'object' ? request.requestMetadata : {}
  const result = await createCustomerServiceRequest({
    user: req.user,
    input: { type: request.type, storeKey: request.storeKey, ...metadata },
  })
  res.status(201).json({ ok: true, ...result })
}))

export function resetPublicCustomerRequestRateLimitsForTest() {
  publicReadLimiter.clear()
  publicSubmitLimiter.clear()
}
