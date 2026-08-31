import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { buduBusinessDate } from '../shared/businessDate.js'
import { httpError, parseCents } from './pos-core.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const dbDate = (value) => new Date(`${value}T00:00:00.000Z`)
const isoDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : null

export function normalizeCostEffectiveDate(value) {
  const date = String(value || '').trim()
  if (!DATE_RE.test(date) || isoDate(dbDate(date)) !== date) throw httpError('成本生效日期不正确')
  return date
}

export function serializeCostHistory(row) {
  return {
    id: row.id,
    inventoryItemId: row.inventoryItemId,
    costPriceCents: row.costPriceCents.toString(),
    effectiveFrom: isoDate(row.effectiveFrom),
    effectiveTo: isoDate(row.effectiveTo),
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export async function resolveEffectiveProductCosts(client, products, businessDate = buduBusinessDate()) {
  const ids = [...new Set((products || []).map((row) => row.id).filter(Boolean))]
  if (!ids.length) return products || []
  const date = dbDate(normalizeCostEffectiveDate(businessDate))
  const histories = await client.inventoryItemCostHistory.findMany({
    where: {
      inventoryItemId: { in: ids },
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: date } }],
    },
    orderBy: [{ inventoryItemId: 'asc' }, { effectiveFrom: 'desc' }],
  })
  const active = new Map()
  for (const row of histories) if (!active.has(row.inventoryItemId)) active.set(row.inventoryItemId, row)
  return products.map((product) => {
    const cost = active.get(product.id)
    if (!cost) throw httpError(`「${product.name || product.id}」在 ${businessDate} 没有有效成本配置`, 409)
    return { ...product, effectiveCostPriceCents: cost.costPriceCents, costAuthorityId: cost.id }
  })
}

export async function createInitialProductCost(client, { inventoryItemId, costPriceCents, effectiveFrom, reason = '商品创建初始成本', createdBy = '' }) {
  if (costPriceCents === null || costPriceCents === undefined) return null
  const date = normalizeCostEffectiveDate(effectiveFrom || buduBusinessDate())
  return client.inventoryItemCostHistory.create({ data: {
    id: `ich-${crypto.randomUUID()}`,
    inventoryItemId,
    costPriceCents: BigInt(costPriceCents),
    effectiveFrom: dbDate(date),
    reason: String(reason || '').trim().slice(0, 300),
    createdBy: String(createdBy || '').trim().slice(0, 120),
  } })
}

export async function appendProductCostVersion(client, input) {
  const inventoryItemId = String(input.inventoryItemId || '').trim()
  const effectiveFrom = normalizeCostEffectiveDate(input.effectiveFrom)
  const costPriceCents = parseCents(input.costPriceCents, '商品成本')
  const reason = String(input.reason || '').trim().slice(0, 300)
  const createdBy = String(input.createdBy || '').trim().slice(0, 120)
  if (!inventoryItemId) throw httpError('商品成本配置缺少商品 ID')
  if (!reason) throw httpError('请填写成本变更原因')

  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`product-cost:${inventoryItemId}`}))`)
    const product = await tx.inventoryItem.findUnique({ where: { id: inventoryItemId } })
    if (!product || product.category !== 'product') throw httpError('商品不存在', 404)
    const latest = await tx.inventoryItemCostHistory.findFirst({
      where: { inventoryItemId },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    if (latest && effectiveFrom <= isoDate(latest.effectiveFrom)) {
      throw httpError('成本版本只能按生效日期向后追加；历史修正需另开审计 Gate', 409)
    }
    if (latest?.effectiveTo && effectiveFrom < isoDate(latest.effectiveTo)) throw httpError('成本生效期间重叠', 409)
    if (latest && !latest.effectiveTo) {
      await tx.inventoryItemCostHistory.update({ where: { id: latest.id }, data: { effectiveTo: dbDate(effectiveFrom) } })
    }
    const created = await tx.inventoryItemCostHistory.create({ data: {
      id: `ich-${crypto.randomUUID()}`,
      inventoryItemId,
      costPriceCents,
      effectiveFrom: dbDate(effectiveFrom),
      reason,
      createdBy,
    } })
    if (effectiveFrom <= buduBusinessDate()) {
      await tx.inventoryItem.update({ where: { id: inventoryItemId }, data: { costPriceCents, version: { increment: 1 } } })
    }
    return created
  }, { maxWait: 5000, timeout: 10000 })
}

export async function listProductCostHistory(client, inventoryItemId) {
  const rows = await client.inventoryItemCostHistory.findMany({
    where: { inventoryItemId },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  })
  return rows.map(serializeCostHistory)
}
