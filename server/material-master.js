import crypto from 'node:crypto'
import { httpError, normalizeSku, parseCents } from './pos-core.js'

const supplied = (body, key, fallback) => Object.hasOwn(body || {}, key) ? body[key] : fallback

export function materialData(body, existing = null) {
  const name = String(body?.name ?? existing?.name ?? '').trim()
  const sortOrder = Number(body?.sortOrder ?? existing?.transferSortOrder ?? 0)
  if (!name || name.length > 50) throw httpError('物料名称不正确')
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999) throw httpError('排序必须是 0-999999 的整数')
  for (const [key, original] of [['sku', existing?.sku], ['code', existing?.transferCode]]) {
    if (original && Object.hasOwn(body || {}, key) && String(body[key]) !== original) throw httpError('已有物料编号不能重新生成或覆盖', 409)
  }
  const salePriceCents = parseCents(supplied(body, 'salePriceCents', existing?.salePriceCents ?? '10') ?? existing?.salePriceCents ?? '10', '零售价')
  const costPriceCents = existing?.costPriceCents ?? parseCents(supplied(body, 'costPriceCents', '10'), '成本价')
  if (existing?.costPriceCents != null && body?.costPriceCents != null && parseCents(body.costPriceCents, '成本价') !== existing.costPriceCents) {
    throw httpError('已有物料成本请使用成本历史追加新版本', 409)
  }
  const partnerReplenishmentEnabled = supplied(body, 'partnerReplenishmentEnabled', existing?.partnerReplenishmentEnabled ?? false) === true
  const partnerOrderUnit = String(supplied(body, 'partnerOrderUnit', existing?.partnerOrderUnit ?? '') || '').trim().toUpperCase() || null
  if (partnerOrderUnit && !['KG', 'PCS', 'NATIVE'].includes(partnerOrderUnit)) throw httpError('补货方式不正确')
  const unit = String(supplied(body, 'unit', existing?.unit ?? '') || '').trim()
  if (unit.length > 20) throw httpError('单位不能超过 20 个字符')
  const rawQuote = supplied(body, 'partnerMaterialPriceCents', existing?.partnerMaterialPriceCents)
  const partnerMaterialPriceCents = rawQuote == null || rawQuote === '' ? null : parseCents(rawQuote, '物料补货标准报价')
  if (partnerReplenishmentEnabled && (!partnerOrderUnit || !partnerMaterialPriceCents || (partnerOrderUnit === 'NATIVE' && !unit))) {
    throw httpError('开启物料补货前请选择补货方式、填写独立标准报价；现有单位补货还需填写单位')
  }
  return {
    name, transferSortOrder: sortOrder,
    transferEnabled: supplied(body, 'enabled', existing?.transferEnabled ?? true) !== false,
    productCategoryId: String(supplied(body, 'productCategoryId', existing?.productCategoryId ?? '') || '').trim() || null,
    salePriceCents, costPriceCents, unit,
    isActive: false, partnerSupplyEnabled: false,
    partnerReplenishmentEnabled, partnerOrderUnit, partnerMaterialPriceCents,
    // Keep the existing KG configuration CHECK; this is a projection of the
    // independent material quote, never a retail/cost fallback.
    partnerKgBasePriceCents: partnerOrderUnit === 'KG' && partnerMaterialPriceCents > 0n ? partnerMaterialPriceCents : null,
    partnerMinOrderBaseQty: partnerOrderUnit ? existing?.partnerMinOrderBaseQty ?? 1 : null,
    partnerOrderStepBaseQty: partnerOrderUnit ? existing?.partnerOrderStepBaseQty ?? 1 : null,
  }
}

// Derived from stable ID, never from a display name/order or the import row index.
export async function materialIdentifiers(tx, item) {
  if (item.sku && item.transferCode) return { sku: item.sku, transferCode: item.transferCode }
  for (let attempt = 0; attempt < 32; attempt++) {
    const generated = `BUDU-MAT-${crypto.createHash('sha256').update(`${item.id}:${attempt}`).digest('hex').slice(0, 24).toUpperCase()}`
    const sku = item.sku || (attempt === 0 && item.transferCode ? normalizeSku(item.transferCode) : generated)
    const transferCode = item.transferCode || (attempt === 0 && item.sku && item.sku.length <= 40 ? item.sku : generated)
    const conflict = await tx.inventoryItem.findFirst({ where: { id: { not: item.id }, OR: [{ sku }, { transferCode }] }, select: { id: true } })
    if (!conflict) return { sku, transferCode }
  }
  throw httpError('物料编号冲突，请刷新后重试', 409)
}

export function materialExtras(item, includeCost = false) {
  return {
    salePriceCents: item.salePriceCents?.toString() ?? null,
    costPriceCents: includeCost ? item.costPriceCents?.toString() ?? null : null,
    costVisible: includeCost, unit: item.unit || '', isActive: false,
    partnerReplenishmentEnabled: item.partnerReplenishmentEnabled === true,
    partnerOrderUnit: item.partnerOrderUnit || '',
    partnerMaterialPriceCents: item.partnerMaterialPriceCents?.toString() ?? null,
  }
}
