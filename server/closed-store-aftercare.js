import { httpError } from './pos-core.js'

// Call only inside a transaction. Existing actor/store authority is retained;
// this permission applies to new manual aftercare, not result/recovery paths.
export async function assertClosedStoreAftercare(tx, storeId, actorId) {
  if (actorId) await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR SHARE', actorId)
  await tx.$queryRawUnsafe('SELECT key FROM "Store" WHERE key = $1 FOR SHARE', storeId)
  const store = await tx.store.findUnique({ where: { key: storeId }, select: { key: true, active: true } })
  if (!store) throw httpError('门店不存在', 404)
  if (store.active === true) return
  const actor = actorId && await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, status: true } })
  if (!actor || actor.role !== 'developer' || actor.status !== 'active') throw httpError('闭店后的订单善后仅开发者可办理', 403)
}
