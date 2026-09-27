import { Prisma } from '@prisma/client'
import { appendProductSkuAudit } from './product-sku-authority.js'
import { buildProductSkuPlan } from './product-sku-plan.js'

const snapshotSelect = {
  id: true, name: true, sku: true, category: true, createdAt: true, isActive: true,
  transferCode: true, productCategory: { select: { name: true } },
}

export async function applyProductSkuPlanOnTestDatabase(prisma, plan, { dryRollback = false } = {}) {
  if (process.env.SKU_AUTHORITY_TEST_APPLY !== 'YES') throw new Error('仅测试数据库可运行此应用器')
  const target = new URL(process.env.DATABASE_URL || '')
  const dbName = decodeURIComponent(target.pathname.slice(1))
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) || !/^sku_authority_test_[a-z0-9_]+$/.test(dbName)) {
    throw new Error('SKU 测试应用器只接受本机专用测试数据库')
  }
  const [{ name: actualDb }] = await prisma.$queryRaw`SELECT current_database() AS name`
  if (actualDb !== dbName) throw new Error('数据库身份与测试连接目标不符')
  const rollbackSignal = new Error('SKU_TEST_ROLLBACK_COMPLETE')
  try {
    return await prisma.$transaction(async (tx) => {
      const sequences = await tx.$queryRaw`SELECT "prefix", "next_value" FROM "product_sku_sequences" ORDER BY "prefix" FOR UPDATE`
      if (sequences.length !== 2 || sequences.some((row) => row.next_value !== 1)) throw new Error('SKU 流水不在初始状态')
      const rows = await tx.inventoryItem.findMany({ where: { category: 'product' }, select: snapshotSelect })
      const current = buildProductSkuPlan(rows, { actorUserId: plan.actorUserId, reason: plan.reason,
        snapshotId: plan.snapshotId, expectedCount: plan.counts.total })
      if (JSON.stringify(current) !== JSON.stringify(plan)) {
        throw new Error('商品权威快照已漂移，映射摘要不匹配')
      }
      const existingAssignments = await tx.productSkuAssignment.count()
      const existingAliases = await tx.productSkuAlias.count()
      if (existingAssignments || existingAliases) throw new Error('SKU 分配或别名已存在，禁止重放')
      const onlineBefore = await tx.onlineProductPolicy.findMany({ select: {
        id: true, namespace: true, externalProductId: true, externalSkuId: true, productId: true, enabled: true,
      }, orderBy: { id: 'asc' } })
      const actor = { id: plan.actorUserId, username: plan.actorUserId }
      for (const row of current.mapping) {
        const changed = await tx.inventoryItem.updateMany({
          where: { id: row.id, category: 'product', sku: row.oldSku, name: row.name,
            createdAt: new Date(row.createdAt), isActive: row.isActive, transferCode: row.transferCodeBefore },
          data: { sku: row.newSku, version: { increment: 1 } },
        })
        if (changed.count !== 1) throw new Error(`商品 ${row.id} 已漂移`)
        await tx.productSkuAssignment.create({ data: {
          sku: row.newSku, itemId: row.id, oldSku: row.oldSku,
          actorUserId: current.actorUserId, reason: current.reason,
        } })
        if (row.alias) await tx.productSkuAlias.create({ data: {
          alias: row.alias, itemId: row.id, actorUserId: current.actorUserId, reason: current.reason,
        } })
        await appendProductSkuAudit(tx, { itemId: row.id, sku: row.newSku,
          oldSku: row.oldSku, user: actor, reason: current.reason })
      }
      for (const prefix of ['BD', 'TP']) await tx.productSkuSequence.update({
        where: { prefix }, data: { nextValue: current.counts[prefix] + 1 },
      })
      const onlineAfter = await tx.onlineProductPolicy.findMany({ select: {
        id: true, namespace: true, externalProductId: true, externalSkuId: true, productId: true, enabled: true,
      }, orderBy: { id: 'asc' } })
      if (JSON.stringify(onlineBefore) !== JSON.stringify(onlineAfter)) throw new Error('Online Catalog Mapping 漂移')
      if (dryRollback) throw rollbackSignal
      return { counts: current.counts, onlineMappings: onlineAfter.length, sha256: current.sha256 }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 120000 })
  } catch (error) {
    if (error === rollbackSignal) return { rolledBack: true, sha256: plan.sha256 }
    throw error
  }
}
