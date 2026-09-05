import crypto from 'node:crypto'
import { Router } from 'express'
import { prisma, dbReady } from './pg.js'
import { hasModuleAccess, hasSweetCardCapability, isSuperUser, MODULE_KEYS, SWEET_CARD_CAPABILITIES } from '../shared/accountPermissions.js'
import { sweetCardEnabled, sweetCardCommercialEnabled } from './sweet-card-core.js'
import { httpError } from './pos-core.js'

// The same module + store scope used by normal POS. Legacy redeem/test grants
// remain historical data and are not authorities for checkout.
export function hasNormalPosForStore(user, storeId) {
  return Boolean(user && user.status !== 'disabled' && user.role !== 'public'
    && hasModuleAccess(user, MODULE_KEYS.STORE_POS)
    && (isSuperUser(user) || (Array.isArray(user.storeKeys) && user.storeKeys.includes(storeId))))
}
export const storeBusinessAllowed = (store) => store?.active === true && store.operationType === 'DIRECT'
export const runtimeEnabled = () => sweetCardEnabled() && sweetCardCommercialEnabled()

export async function availabilityFor(tx, storeId, user) {
  const [store, control] = await Promise.all([
    tx.store.findUnique({ where: { key: storeId }, include: { sweetCardPolicy: true } }),
    tx.sweetCardControl.findUnique({ where: { id: 'GLOBAL' } }),
  ])
  const globalEnabled = runtimeEnabled() && control?.enabled === true
  const operatorAllowed = hasNormalPosForStore(user, storeId)
  const businessAllowed = storeBusinessAllowed(store)
  const storeEnabled = store?.sweetCardPolicy?.eligible === true
  return { enabled: globalEnabled && businessAllowed && storeEnabled && operatorAllowed,
    globalEnabled, businessAllowed, storeEnabled, operatorAllowed,
    reason: !operatorAllowed ? '无该门店 POS 权限' : !globalEnabled ? '甜意卡核销暂已停用' : !businessAllowed ? '当前门店不可使用甜意卡' : !storeEnabled ? '当前门店暂未开启甜意卡' : '' }
}

// Called inside the existing redemption transaction, before any economic effect.
// Shared row locks serialize disable/revoke against an in-flight authorization.
export async function assertNewRedemptionAccess(tx, storeId, actorId, { lock = false } = {}) {
  if (lock) {
    try {
    await tx.$queryRawUnsafe('SELECT id FROM sweet_card_control WHERE id = $1 FOR SHARE', 'GLOBAL')
    await tx.$queryRawUnsafe('SELECT key FROM "Store" WHERE key = $1 FOR SHARE', storeId)
    await tx.$queryRawUnsafe('SELECT store_id FROM sweet_card_store_policies WHERE store_id = $1 FOR SHARE', storeId)
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR SHARE', actorId)
    } catch (error) {
      // Raw SELECT row locks expose SQLSTATE via P2010 rather than P2034.
      // Abort this transaction with a controlled conflict; do not change the economic retry helper.
      if (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code)) throw httpError('门店配置或账号权限已变化，请重试', 409)
      throw error
    }
  }
  const user = await tx.user.findUnique({ where: { id: actorId } })
  const result = await availabilityFor(tx, storeId, user)
  if (!result.enabled) throw httpError(result.reason, 403)
  return result
}

export function rejectSpoof(body, user, storeId) {
  if ((body?.operatorId != null && body.operatorId !== user.id)
    || (body?.employeeId != null && body.employeeId !== user.employeeId)
    || (body?.role != null && body.role !== user.role)
    || (body?.storeId != null && body.storeId !== storeId)) throw httpError('操作身份或门店不匹配', 403)
}
export async function requireAvailabilityAdmin(tx, userId) {
  const user = await tx.user.findUnique({ where: { id: userId } })
  if (!user || user.status === 'disabled' || !hasModuleAccess(user, MODULE_KEYS.SWEET_CARD)
    || !hasSweetCardCapability(user, SWEET_CARD_CAPABILITIES.MANAGE)) throw httpError('无甜意卡管理权限', 403)
  return user
}
const audit = (tx, user, action, metadata) => tx.sweetCardAuditLog.create({ data: {
  id: `sca-${crypto.randomUUID()}`, action, actorId: user.id, actorName: user.username || '', metadata,
} })
export async function changeAvailability(tx, user, { storeId, enabled, allDirect = false }) {
  const stores = allDirect
    ? await tx.store.findMany({ where: { active: true, operationType: 'DIRECT' }, orderBy: { key: 'asc' } })
    : [await tx.store.findUnique({ where: { key: storeId } })]
  if (stores.some(s => !storeBusinessAllowed(s))) throw httpError('仅可配置营业中的直营门店', 403)
  const changes = []
  for (const store of stores) {
    const old = await tx.sweetCardStorePolicy.findUnique({ where: { storeId: store.key } })
    await tx.sweetCardStorePolicy.upsert({ where: { storeId: store.key },
      create: { storeId: store.key, eligible: enabled, updatedById: user.id, updatedByName: user.username || '' },
      update: { eligible: enabled, updatedById: user.id, updatedByName: user.username || '' } })
    const change = { storeId: store.key, previousValue: old?.eligible === true, newValue: enabled }
    changes.push(change)
    await audit(tx, user, enabled ? 'SWEET_CARD_STORE_ENABLED' : 'SWEET_CARD_STORE_DISABLED', change)
  }
  if (allDirect) await audit(tx, user, enabled ? 'SWEET_CARD_ALL_DIRECT_ENABLED' : 'SWEET_CARD_ALL_DIRECT_DISABLED', { changes })
  return changes
}

export const sweetCardAvailabilityRouter = Router()
const wrap = handler => async (req, res) => {
  try {
    if (!dbReady()) throw httpError('数据库不可用', 503)
    await requireAvailabilityAdmin(prisma, req.user?.id || '')
    res.setHeader('Cache-Control', 'no-store')
    await handler(req, res)
  } catch (e) { res.status(e.code === 'P2034' ? 409 : e.status || 500).json({ error: e.code === 'P2034' ? '配置已变化，请刷新后重试' : e.status ? e.message : '配置操作失败，请稍后重试' }) }
}
export async function availabilitySummary(tx) {
  const [stores, users, control] = await Promise.all([
    tx.store.findMany({ orderBy: { key: 'asc' }, include: { sweetCardPolicy: true } }),
    tx.user.findMany({ where: { status: { not: 'disabled' } } }),
    tx.sweetCardControl.findUnique({ where: { id: 'GLOBAL' } }),
  ])
  return { globalEnabled: runtimeEnabled() && control?.enabled === true, runtimeEnabled: runtimeEnabled(),
    stores: stores.map(s => ({ id: s.key, name: s.name, active: s.active, operationType: s.operationType,
      configurable: storeBusinessAllowed(s), enabled: storeBusinessAllowed(s) && s.sweetCardPolicy?.eligible === true,
      posOperatorCount: users.filter(u => hasNormalPosForStore(u, s.key)).length })) }
}
sweetCardAvailabilityRouter.get('/sweet-cards/availability', wrap(async (req, res) => res.json(await availabilitySummary(prisma))))
sweetCardAvailabilityRouter.put('/sweet-cards/availability/global', wrap(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw httpError('开关值无效')
  if (req.body.enabled && !runtimeEnabled()) throw httpError('运行环境尚未开放甜意卡', 409)
  await prisma.$transaction(async tx => {
    const user = await requireAvailabilityAdmin(tx, req.user.id)
    const old = await tx.sweetCardControl.findUnique({ where: { id: 'GLOBAL' } })
    await tx.sweetCardControl.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL', enabled: req.body.enabled, updatedById: user.id }, update: { enabled: req.body.enabled, updatedById: user.id } })
    await audit(tx, user, req.body.enabled ? 'SWEET_CARD_GLOBAL_ENABLED' : 'SWEET_CARD_GLOBAL_DISABLED', { previousValue: old?.enabled === true, newValue: req.body.enabled })
  }, { isolationLevel: 'Serializable' })
  res.json(await availabilitySummary(prisma))
}))
for (const [path, allDirect] of [['/sweet-cards/availability/all-direct', true], ['/sweet-cards/availability/stores/:storeId', false]]) {
  sweetCardAvailabilityRouter.put(path, wrap(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw httpError('开关值无效')
    await prisma.$transaction(async tx => {
      const user = await requireAvailabilityAdmin(tx, req.user.id)
      await changeAvailability(tx, user, { storeId: req.params.storeId, enabled: req.body.enabled, allDirect })
    }, { isolationLevel: 'Serializable' })
    res.json(await availabilitySummary(prisma))
  }))
}
