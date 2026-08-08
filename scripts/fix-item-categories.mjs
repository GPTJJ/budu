/**
 * 修复历史数据：固定物料被错误存成 product 时批量纠正为 material。
 * 幂等，可重复执行；执行完后自动校验零残留。
 * 用法（服务器容器内）：node scripts/fix-item-categories.mjs
 */
import { PrismaClient } from '@prisma/client'
import { isMaterialName } from '../server/productCategories.js'

const prisma = new PrismaClient()

async function main() {
  const rows = await prisma.inventoryItem.findMany()
  let fixed = 0
  const invalid = []
  for (const r of rows) {
    if (!['product', 'material', 'other'].includes(r.category)) invalid.push(`${r.name}:${r.category}`)
    if (r.category === 'product' && isMaterialName(r.name)) {
      await prisma.inventoryItem.update({ where: { id: r.id }, data: { category: 'material' } })
      fixed += 1
    }
  }
  console.log(`fix-item-categories: total=${rows.length} fixed=${fixed} invalid=${invalid.length}`)
  if (invalid.length > 0) console.log(`invalid categories: ${invalid.join(', ')}`)

  const products = await prisma.inventoryItem.findMany({ where: { category: 'product' } })
  const leftover = products.filter((r) => isMaterialName(r.name))
  if (leftover.length > 0) {
    throw new Error(`仍有物料被标成 product：${leftover.map((r) => r.name).join('、')}`)
  }
  console.log('FIX OK')
}

main()
  .catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
