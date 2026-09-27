import { ACTIVE_ROLES } from '../shared/accountPermissions.js'

export const PRINCIPAL_TYPES = Object.freeze({
  INTERNAL: 'INTERNAL',
  CUSTOMER: 'CUSTOMER',
  PARTNER: 'PARTNER',
})

export const CUSTOMER_ROLE = 'customer'
export const PARTNER_ROLE = 'partner'

const EXTERNAL_ROLE_BY_PRINCIPAL = Object.freeze({
  [PRINCIPAL_TYPES.CUSTOMER]: CUSTOMER_ROLE,
  [PRINCIPAL_TYPES.PARTNER]: PARTNER_ROLE,
})

function denied(code = 'PRINCIPAL_DENIED', status = 401) {
  return Object.assign(new Error(code), { status })
}

export function resolveInternalPrincipal(user) {
  if (!user || user.status !== 'active' || !ACTIVE_ROLES.includes(user.role)) return null
  return Object.freeze({
    type: PRINCIPAL_TYPES.INTERNAL,
    userId: String(user.id),
    role: user.role,
    employeeId: String(user.employeeId || ''),
  })
}

export function resolveExternalPrincipal(user, principalType) {
  const expectedRole = EXTERNAL_ROLE_BY_PRINCIPAL[principalType]
  if (!expectedRole || !user || user.status !== 'active' || user.role !== expectedRole) return null
  return Object.freeze({ type: principalType, userId: String(user.id) })
}

export function assertPartnerPrincipal(principal) {
  if (!principal || principal.type !== PRINCIPAL_TYPES.PARTNER
      || !String(principal.userId || '') || !String(principal.partnerUserId || '')
      || !String(principal.partnerId || '')) {
    throw denied('PARTNER_PRINCIPAL_DENIED')
  }
  return principal
}

/**
 * Build a tenant-scoped Prisma predicate. The caller may supply resource IDs
 * and other server-owned criteria, but never a competing partnerId.
 */
export function partnerScopedWhere(principal, criteria = {}) {
  const authenticated = assertPartnerPrincipal(principal)
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)
      || Object.hasOwn(criteria, 'partnerId')) {
    throw denied('PARTNER_TENANT_SCOPE_DENIED')
  }
  return { ...criteria, partnerId: authenticated.partnerId }
}

export function isInternalUser(user) {
  return Boolean(user && ACTIVE_ROLES.includes(user.role))
}
