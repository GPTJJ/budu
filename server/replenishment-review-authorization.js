import { canManagePartnerDomain } from '../shared/accountPermissions.js'
import { buduBusinessDate } from '../shared/businessDate.js'

// Stable Store.key from the canonical fixed store directory. Authorization
// never matches the Chinese display name.
export const PARTNER_REPLENISHMENT_REVIEW_STORE_KEY = 'guanshe'
const DUTY_ELIGIBLE_ROLES = new Set(['manager', 'staff'])

function denied(message = '无补货审核权限', code = 'REPLENISHMENT_REVIEW_FORBIDDEN') {
  const error = new Error(message)
  error.status = 403
  error.code = code
  return error
}

async function authorizePartnerOperation({ db, actor, now, message, code }) {
  const actorId = String(actor?.id || '').trim()
  if (!actorId) throw denied(message, code)
  const user = await db.user.findUnique({
    where: { id: actorId },
    select: { id: true, username: true, role: true, status: true, employeeId: true },
  })
  if (!user || user.status !== 'active') throw denied(message, code)
  if (canManagePartnerDomain(user)) {
    return { actor: { id: user.id, name: user.username }, authority: 'DEVELOPER_OR_ADMIN', businessDate: buduBusinessDate(now) }
  }
  if (!DUTY_ELIGIBLE_ROLES.has(user.role) || !String(user.employeeId || '').trim()) throw denied(message, code)

  const businessDate = buduBusinessDate(now)
  const [store, employee, schedules] = await Promise.all([
    db.store.findUnique({ where: { key: PARTNER_REPLENISHMENT_REVIEW_STORE_KEY }, select: { key: true, active: true } }),
    db.employee.findUnique({ where: { id: user.employeeId }, select: { id: true, status: true } }),
    db.schedule.findMany({
      where: { storeKey: PARTNER_REPLENISHMENT_REVIEW_STORE_KEY, date: businessDate },
      select: { id: true, shifts: true },
      take: 2,
    }),
  ])
  if (!store?.active || !employee || employee.status === 'RESIGNED' || schedules.length !== 1) throw denied(message, code)
  const shifts = Array.isArray(schedules[0].shifts) ? schedules[0].shifts : []
  if (!shifts.some((shift) => String(shift?.employeeId || '').trim() === employee.id)) throw denied(message, code)
  return {
    actor: { id: user.id, name: user.username, employeeId: employee.id },
    authority: 'GUANSHE_ON_DUTY',
    businessDate,
    storeKey: PARTNER_REPLENISHMENT_REVIEW_STORE_KEY,
  }
}

export function authorizeReplenishmentReviewer({ db, actor, now = new Date() }) {
  return authorizePartnerOperation({
    db,
    actor,
    now,
    message: '无补货审核权限',
    code: 'REPLENISHMENT_REVIEW_FORBIDDEN',
  })
}

export function authorizeReplenishmentShipper({ db, actor, now = new Date() }) {
  return authorizePartnerOperation({
    db,
    actor,
    now,
    message: '无补货发货权限',
    code: 'REPLENISHMENT_SHIPMENT_FORBIDDEN',
  })
}
