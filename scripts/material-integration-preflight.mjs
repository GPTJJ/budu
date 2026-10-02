// Run inside an already-authorized environment. No env-file loading, no writes.
import { PrismaClient } from '@prisma/client'
import { materialIntegrationPlan } from '../server/material-integration-plan.js'

if (!process.env.DATABASE_URL) throw new Error('READ_ONLY_PREFLIGHT_NOT_RUN: DATABASE_URL must be supplied by the authorized runtime')
const db = new PrismaClient()
try {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    const category = await tx.productCategory.findUnique({ where: { name: '物料' }, select: { id: true, name: true } })
    if (!category) throw new Error('MATERIAL_CATEGORY_NOT_CONFIRMED')
    const where = { OR: [{ category: 'material' }, { category: 'product', productCategoryId: category.id }] }
    if (await tx.inventoryItem.count({ where }) > 1000) throw new Error('READ_ONLY_SCOPE_LIMIT_EXCEEDED')
    const rows = await tx.inventoryItem.findMany({ where, orderBy: { id: 'asc' }, select: { id: true, name: true, category: true, sku: true, transferCode: true, image: true, productCategoryId: true, sortOrder: true, transferSortOrder: true, salePriceCents: true, costPriceCents: true, isActive: true, transferEnabled: true, partnerReplenishmentEnabled: true, partnerOrderUnit: true, version: true, _count: { select: { transferItems: true, purchaseItems: true, orderItems: true, replenishmentItems: true, costHistories: true } } } })
    return materialIntegrationPlan(category, rows)
  }, { timeout: 15000 })
  console.log(JSON.stringify(result, null, 2))
  if (result.conflicts.length) process.exitCode = 2
} finally { await db.$disconnect() }
