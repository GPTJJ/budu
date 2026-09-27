import crypto from 'node:crypto'
import { hashPassword } from './auth.js'
import { prisma } from './pg.js'
import {
  EXTERNAL_SESSION_TTL_MS,
  authenticateExternalSession,
  createExternalSession,
  externalSessionInternals,
  externalSessionPattern,
  revokeExternalSession,
} from './external-session.js'
import { CUSTOMER_ROLE, PRINCIPAL_TYPES } from './principals.js'

export { CUSTOMER_ROLE }
export const CUSTOMER_SESSION_TTL_MS = EXTERNAL_SESSION_TTL_MS

function customerReference(userId, markerKey) {
  return `customer-${crypto.createHmac('sha256', markerKey).update(String(userId)).digest('hex').slice(0, 12)}`
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
  const session = await createExternalSession({
    userId,
    principalType: PRINCIPAL_TYPES.CUSTOMER,
    markerKey,
    db,
    now,
    ttlMs,
  })
  return { ...session, customerRef: customerReference(userId, markerKey) }
}

export async function authenticateCustomerSession({ rawToken, markerKey, db = prisma, now = new Date() }) {
  const session = await authenticateExternalSession({
    rawToken,
    principalType: PRINCIPAL_TYPES.CUSTOMER,
    markerKey,
    db,
    now,
  })
  return { ...session, customerRef: customerReference(session.userId, markerKey) }
}

export async function revokeCustomerSession({ rawToken, markerKey, db = prisma, now = new Date() }) {
  return revokeExternalSession({
    rawToken,
    principalType: PRINCIPAL_TYPES.CUSTOMER,
    markerKey,
    db,
    now,
  })
}

export function bearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

export const customerAuthInternals = {
  sha256: externalSessionInternals.sha256,
  customerReference,
  sessionSignature: (nonce, markerKey) => externalSessionInternals.sessionSignature(PRINCIPAL_TYPES.CUSTOMER, nonce, markerKey),
  validSessionSignature: (token, markerKey) => externalSessionInternals.validSessionSignature(token, PRINCIPAL_TYPES.CUSTOMER, markerKey),
  SESSION_PATTERN: externalSessionPattern(PRINCIPAL_TYPES.CUSTOMER),
}
