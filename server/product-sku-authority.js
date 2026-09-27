import crypto from 'node:crypto'
import { httpError } from './pos-core.js'

export const PRODUCT_SKU_PATTERN = /^(BD|TP)-\d{6}$/
export const PRODUCT_SKU_PREFIXES = Object.freeze(['BD', 'TP'])

export function productSkuPrefix(source) {
  if (source === 'BD' || source === 'TP') return source
  throw httpError('请选择商品来源：budu 自有或第三方')
}

export function canOverrideProductSku(user) {
  return Boolean(user && user.status !== 'disabled' && ['developer', 'admin'].includes(user.role))
}

export function validateProductSkuOverride(value, prefix, user, reason) {
  if (!canOverrideProductSku(user)) throw httpError('只有高级管理员可在首次创建前指定 SKU', 403)
  const sku = String(value || '').trim().toUpperCase()
  if (!PRODUCT_SKU_PATTERN.test(sku) || !sku.startsWith(`${prefix}-`)) throw httpError('SKU 必须符合所选来源的 BD-000001 / TP-000001 格式')
  const serial = Number(sku.slice(3))
  if (serial < 1) throw httpError('SKU 编号必须从 000001 开始')
  if (!String(reason || '').trim()) throw httpError('指定 SKU 请填写原因')
  return { sku, serial }
}

export async function reserveProductSku(tx, { source, override, user, reason }) {
  const prefix = productSkuPrefix(source)
  const overrideValue = override ? validateProductSkuOverride(override, prefix, user, reason) : null
  // Row lock serializes both automatic and overridden allocations of a prefix.
  const [sequence] = await tx.$queryRaw`SELECT "next_value" FROM "product_sku_sequences" WHERE "prefix" = ${prefix} FOR UPDATE`
  if (!sequence) throw httpError('SKU 流水尚未初始化', 503)
  let serial = overrideValue?.serial ?? sequence.next_value
  if (serial < sequence.next_value || serial > 999999) throw httpError('SKU 编号已越过当前流水或已用尽', 409)
  while (serial <= 999999) {
    const sku = `${prefix}-${String(serial).padStart(6, '0')}`
    const [item, assignment, alias] = await Promise.all([
      tx.inventoryItem.findUnique({ where: { sku }, select: { id: true } }),
      tx.productSkuAssignment.findUnique({ where: { sku }, select: { itemId: true } }),
      tx.productSkuAlias.findUnique({ where: { alias: sku }, select: { itemId: true } }),
    ])
    if (!item && !assignment && !alias) {
      await tx.productSkuSequence.update({ where: { prefix }, data: { nextValue: serial + 1 } })
      return sku
    }
    if (overrideValue) throw httpError('SKU 已被商品或历史别名占用', 409)
    serial += 1
  }
  throw httpError('SKU 流水已用尽', 409)
}

export async function recordProductSkuAssignment(tx, { sku, itemId, oldSku = null, user, reason }) {
  return tx.productSkuAssignment.create({ data: {
    sku,
    itemId,
    oldSku,
    actorUserId: String(user?.id || ''),
    reason: String(reason || '商品首次创建'),
  } })
}

export async function appendProductSkuAudit(tx, { itemId, sku, oldSku = null, user, reason }) {
  await tx.sensitiveRecordAudit.create({ data: {
    id: `audit-${crypto.randomUUID()}`,
    action: 'product.sku.assign',
    recordType: 'InventoryItem',
    recordId: itemId,
    actorUserId: String(user?.id || ''),
    actorUsername: String(user?.username || user?.name || ''),
    reason: JSON.stringify({ oldSku, newSku: sku, reason: String(reason || '商品首次创建') }),
  } })
}
