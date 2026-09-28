// Evaluated inside the currently running old application container. The file
// itself is never copied to production. Keep this stdin probe self-contained:
// the old image cannot import the new release adapter. Replace all options,
// preserve other URL fields, and guard the actual session and read transaction.
import { PrismaClient } from '@prisma/client'
let prisma

const select = { id: true, name: true, sku: true, category: true, createdAt: true,
  isActive: true, transferCode: true, productCategory: { select: { name: true } } }
const onlineSelect = { id: true, namespace: true, externalProductId: true,
  externalSkuId: true, productId: true, enabled: true }

try {
  const url = new URL(process.env.DATABASE_URL)
  url.searchParams.set('options', '-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0')
  prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  const [session] = await prisma.$queryRawUnsafe('SHOW default_transaction_read_only')
  const [transaction] = await prisma.$queryRawUnsafe('SHOW transaction_read_only')
  if (session?.default_transaction_read_only !== 'on' || transaction?.transaction_read_only !== 'on')
    throw Error('SKU_READONLY_GUARD_FAILED')
  const snapshot = await prisma.$transaction(async tx => {
    const [state] = await tx.$queryRawUnsafe('SHOW transaction_read_only')
    if (state?.transaction_read_only !== 'on') throw Error('SKU_READONLY_GUARD_FAILED')
    return {
      products: await tx.inventoryItem.findMany({ where: { category: 'product' },
        select, orderBy: { id: 'asc' } }),
      online: await tx.onlineProductPolicy.findMany({ select: onlineSelect,
        orderBy: { id: 'asc' } }),
      channelFlags: await tx.inventoryItem.findMany({ where: { category: 'product' },
        select: { id: true, isActive: true, transferEnabled: true,
          partnerSupplyEnabled: true, partnerReplenishmentEnabled: true },
        orderBy: { id: 'asc' } }),
    }
  }, { isolationLevel: 'RepeatableRead' })
  process.stdout.write(JSON.stringify(snapshot) + '\n')
} catch {
  process.stderr.write('SKU_READONLY_SNAPSHOT_FAILED\n')
  process.exitCode = 1
} finally {
  try { await prisma?.$disconnect() } catch { process.exitCode = 1 }
}
