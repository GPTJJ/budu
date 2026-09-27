// Evaluated inside the currently running old application container. The file
// itself is never copied to production. PGOPTIONS makes every session read-only.
import { prisma } from './server/pg.js'

const select = { id: true, name: true, sku: true, category: true, createdAt: true,
  isActive: true, transferCode: true, productCategory: { select: { name: true } } }
const onlineSelect = { id: true, namespace: true, externalProductId: true,
  externalSkuId: true, productId: true, enabled: true }

try {
  const snapshot = await prisma.$transaction(async tx => ({
    products: await tx.inventoryItem.findMany({ where: { category: 'product' },
      select, orderBy: { id: 'asc' } }),
    online: await tx.onlineProductPolicy.findMany({ select: onlineSelect,
      orderBy: { id: 'asc' } }),
    channelFlags: await tx.inventoryItem.findMany({ where: { category: 'product' },
      select: { id: true, isActive: true, transferEnabled: true,
        partnerSupplyEnabled: true, partnerReplenishmentEnabled: true },
      orderBy: { id: 'asc' } }),
  }), { isolationLevel: 'RepeatableRead' })
  process.stdout.write(JSON.stringify(snapshot) + '\n')
} catch {
  process.stderr.write('SKU_READONLY_SNAPSHOT_FAILED\n')
  process.exitCode = 1
} finally {
  try { await prisma.$disconnect() } catch { process.exitCode = 1 }
}
