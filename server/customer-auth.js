import crypto from 'node:crypto'
import { hashPassword } from './auth.js'
import { prisma } from './pg.js'

export const CUSTOMER_ROLE = 'customer'
export const CUSTOMER_SESSION_TTL_MS = 15 * 60 * 1000
const SESSION_PREFIX = 'budu:customer-session:v1:'
const SESSION_PATTERN = /^budu:customer-session:v1:([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function customerReference(userId, markerKey) {
  return `customer-${crypto.createHmac('sha256', markerKey).update(String(userId)).digest('hex').slice(0, 12)}`
}

function sessionSignature(nonce, markerKey) {
  return crypto.createHmac('sha256', markerKey).update(`${SESSION_PREFIX}${nonce}`).digest('base64url').slice(0, 22)
}

function validSessionSignature(token, markerKey) {
  const match = token.match(SESSION_PATTERN)
  if (!match || !markerKey) return false
  const expected = Buffer.from(sessionSignature(match[1], markerKey))
  const actual = Buffer.from(match[2])
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function newCustomerData() {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  return {
    id: crypto.randomUUID(),
    username: `wx_${suffix}`,
    passwordHash: hashPassword(crypto.randomBytes(32).toString('base64url')),
    role: CUSTOMER_ROLE,
    displayName: '',
    avatar: '',
    storeKeys: [],
    staffKey: '',
    employeeId: '',
    status: 'active',
    permissions: {},
  }
}

export async function resolveOrCreateCustomerIdentity({
  appId,
  openId,
  unionId = null,
  db = prisma,
}) {
  const provider = 'WECHAT_MINIPROGRAM'
  const scopedAppId = String(appId || '').trim()
  const scopedOpenId = String(openId || '').trim()
  const observedUnionId = String(unionId || '').trim() || null
  if (!scopedAppId || !scopedOpenId) throw Object.assign(new Error('WECHAT_IDENTITY_REQUIRED'), { status: 401 })
  const lockKey = `${provider}\n${scopedAppId}\n${scopedOpenId}`

  const work = async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    let identity = await tx.weChatAuthIdentity.findUnique({
      where: { provider_appId_openId: { provider, appId: scopedAppId, openId: scopedOpenId } },
      include: { user: true },
    })
    if (!identity) {
      const user = await tx.user.create({ data: newCustomerData() })
      identity = await tx.weChatAuthIdentity.create({
        data: {
          id: crypto.randomUUID(), provider, appId: scopedAppId, openId: scopedOpenId,
          unionId: observedUnionId, userId: user.id,
        },
        include: { user: true },
      })
    } else if (!identity.unionId && observedUnionId) {
      identity = await tx.weChatAuthIdentity.update({
        where: { id: identity.id }, data: { unionId: observedUnionId }, include: { user: true },
      })
    }
    if (identity.user.role !== CUSTOMER_ROLE || identity.user.status !== 'active') {
      throw Object.assign(new Error('CUSTOMER_IDENTITY_UNAVAILABLE'), { status: 403 })
    }
    return { identityId: identity.id, userId: identity.userId, createdAt: identity.createdAt }
  }
  return typeof db.$transaction === 'function' ? db.$transaction(work) : work(db)
}

export async function createCustomerSession({
  userId,
  markerKey,
  db = prisma,
  now = new Date(),
  ttlMs = CUSTOMER_SESSION_TTL_MS,
}) {
  const nonce = crypto.randomBytes(32).toString('base64url')
  const rawToken = `${SESSION_PREFIX}${nonce}.${sessionSignature(nonce, markerKey)}`
  const expiresAt = new Date(now.getTime() + ttlMs)
  await db.customerSession.create({
    data: { id: crypto.randomUUID(), tokenHash: sha256(rawToken), userId, expiresAt },
  })
  return { rawToken, expiresAt, customerRef: customerReference(userId, markerKey) }
}

export async function authenticateCustomerSession({ rawToken, markerKey, db = prisma, now = new Date() }) {
  const token = String(rawToken || '').trim()
  if (!validSessionSignature(token, markerKey)) throw Object.assign(new Error('CUSTOMER_SESSION_DENIED'), { status: 401 })
  const session = await db.customerSession.findUnique({
    where: { tokenHash: sha256(token) }, include: { user: true },
  })
  if (!session || session.revokedAt || session.expiresAt <= now
      || session.user.role !== CUSTOMER_ROLE || session.user.status !== 'active') {
    throw Object.assign(new Error('CUSTOMER_SESSION_DENIED'), { status: 401 })
  }
  return { sessionId: session.id, userId: session.userId, customerRef: customerReference(session.userId, markerKey) }
}

export async function revokeCustomerSession({ rawToken, markerKey, db = prisma, now = new Date() }) {
  const session = await authenticateCustomerSession({ rawToken, markerKey, db, now })
  await db.customerSession.update({ where: { id: session.sessionId }, data: { revokedAt: now } })
  return { revoked: true }
}

export function bearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

export const customerAuthInternals = { sha256, customerReference, sessionSignature, validSessionSignature, SESSION_PATTERN }
