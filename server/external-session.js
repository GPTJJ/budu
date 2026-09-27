import crypto from 'node:crypto'
import { PRINCIPAL_TYPES, resolveExternalPrincipal } from './principals.js'

export const EXTERNAL_SESSION_TTL_MS = 15 * 60 * 1000

const SESSION_CONFIG = Object.freeze({
  [PRINCIPAL_TYPES.CUSTOMER]: Object.freeze({
    prefix: 'budu:customer-session:v1:',
    pattern: /^budu:customer-session:v1:([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/,
    denied: 'CUSTOMER_SESSION_DENIED',
  }),
  [PRINCIPAL_TYPES.PARTNER]: Object.freeze({
    prefix: 'budu:partner-session:v1:',
    pattern: /^budu:partner-session:v1:([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/,
    denied: 'PARTNER_SESSION_DENIED',
  }),
})

function errorFor(principalType) {
  return Object.assign(new Error(SESSION_CONFIG[principalType]?.denied || 'EXTERNAL_SESSION_DENIED'), { status: 401 })
}

function configFor(principalType) {
  const config = SESSION_CONFIG[principalType]
  if (!config) throw errorFor(principalType)
  return config
}

function requireMarkerKey(markerKey, principalType) {
  if (String(markerKey || '').length < 16) throw errorFor(principalType)
  return String(markerKey)
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function sessionSignature(principalType, nonce, markerKey) {
  const config = configFor(principalType)
  return crypto.createHmac('sha256', requireMarkerKey(markerKey, principalType))
    .update(`${config.prefix}${nonce}`)
    .digest('base64url')
    .slice(0, 22)
}

function validSessionSignature(token, principalType, markerKey) {
  const config = configFor(principalType)
  const match = String(token || '').match(config.pattern)
  if (!match) return false
  let expected
  try {
    expected = Buffer.from(sessionSignature(principalType, match[1], markerKey))
  } catch {
    return false
  }
  const actual = Buffer.from(match[2])
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

export async function createExternalSession({
  userId,
  principalType,
  markerKey,
  db,
  now = new Date(),
  ttlMs = EXTERNAL_SESSION_TTL_MS,
}) {
  const config = configFor(principalType)
  requireMarkerKey(markerKey, principalType)
  if (!db?.customerSession || !String(userId || '') || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw errorFor(principalType)
  }
  const nonce = crypto.randomBytes(32).toString('base64url')
  const rawToken = `${config.prefix}${nonce}.${sessionSignature(principalType, nonce, markerKey)}`
  const expiresAt = new Date(now.getTime() + ttlMs)
  await db.customerSession.create({
    data: {
      id: crypto.randomUUID(),
      tokenHash: sha256(rawToken),
      userId: String(userId),
      principalType,
      expiresAt,
      createdAt: now,
    },
  })
  return { rawToken, expiresAt, createdAt: now }
}

export async function authenticateExternalSession({ rawToken, principalType, markerKey, db, now = new Date() }) {
  const token = String(rawToken || '').trim()
  if (!db?.customerSession || !validSessionSignature(token, principalType, markerKey)) throw errorFor(principalType)
  const session = await db.customerSession.findUnique({
    where: { tokenHash: sha256(token) }, include: { user: true },
  })
  // Missing principalType is accepted only for legacy/mock customer rows. A
  // Partner session always requires an explicit PARTNER row discriminator.
  const storedType = session?.principalType || PRINCIPAL_TYPES.CUSTOMER
  const principal = resolveExternalPrincipal(session?.user, principalType)
  if (!session || storedType !== principalType || session.revokedAt || session.expiresAt <= now || !principal) {
    throw errorFor(principalType)
  }
  return {
    sessionId: session.id,
    userId: session.userId,
    createdAt: session.createdAt || now,
    user: session.user,
    principal,
  }
}

export async function revokeExternalSession({ rawToken, principalType, markerKey, db, now = new Date() }) {
  const session = await authenticateExternalSession({ rawToken, principalType, markerKey, db, now })
  await db.customerSession.update({ where: { id: session.sessionId }, data: { revokedAt: now } })
  return { revoked: true }
}

export function externalSessionPattern(principalType) {
  return configFor(principalType).pattern
}

export const externalSessionInternals = {
  sha256,
  sessionSignature,
  validSessionSignature,
  SESSION_CONFIG,
}
