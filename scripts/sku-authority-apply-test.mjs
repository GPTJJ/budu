import fs from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'
import { applyProductSkuPlanOnTestDatabase } from '../server/product-sku-migration.js'

const file = process.argv[2]
if (!file) throw new Error('用法：SKU_AUTHORITY_TEST_APPLY=YES DATABASE_URL=测试库 node scripts/sku-authority-apply-test.mjs 映射.json [--rollback]')
const plan = JSON.parse(await fs.readFile(file, 'utf8'))
const prisma = new PrismaClient()
try {
  const result = await applyProductSkuPlanOnTestDatabase(prisma, plan, { dryRollback: process.argv.includes('--rollback') })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await prisma.$disconnect()
}
