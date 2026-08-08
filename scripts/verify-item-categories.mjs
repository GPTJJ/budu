/**
 * 校验数据库品类：所有记录品类合法，且不存在「固定物料被标成 product」。
 * 用法（服务器容器内）：node scripts/verify-item-categories.mjs
 */
import { PrismaClient } from '@prisma/client'
import { isMaterialName } from '../server/productCategories.js'

const prisma = new PrismaClient()

async function main() {
  const rows = await prisma.inventoryItem.findMany()
  const invalid = rows.filter((r) => !['product', 'material', 'other'].includes(r.category))
  if (invalid.length > 0) {
    throw new Error(`存在非法品类：${invalid.map((r) => `${r.name}:${r.category}`).join('、')}`)
  }
  const products = rows.filter((r) => r.category === 'product')
  const leftover = products.filter((r) => isMaterialName(r.name))
  if (leftover.length > 0) {
    throw new Error(`物料被标成 product：${leftover.map((r) => r.name).join('、')}`)
  }
  console.log(`verify-item-categories: total=${rows.length} material=${rows.filter((r) => r.category === 'material').length} OK`)
}

main()
  .catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
