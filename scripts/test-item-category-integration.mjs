/**
 * 服务端品类集成测试（需在服务器容器内运行，连接生产 PG）：
 * docker compose exec -T api node scripts/test-item-category-integration.mjs
 * 验证 itemRows 归一化、upsertItem 创建/修复行为，连续 3 轮，测试数据自动清理。
 */
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { itemRows, upsertItem } from '../server/v2.js'

const prisma = new PrismaClient()

async function main() {
  const rows = itemRows([
    { name: '手提袋', quantity: 1 },
    { name: '8颗礼盒（长）', quantity: 1, category: 'product' },
    { name: '集成测试-自定义其他', quantity: 1, category: 'other' },
  ])
  assert.equal(rows[0].category, 'material', '手提袋应归一化为 material')
  assert.equal(rows[1].category, 'product', '8颗礼盒（长）应保持 product')
  assert.equal(rows[2].category, 'other', '自定义其他应保持 other')

  const beforeBox = await prisma.inventoryItem.findUnique({ where: { name: '8颗礼盒（长）' } })
  const expectedBox = beforeBox && beforeBox.category !== 'product' ? beforeBox.category : 'product'

  for (let i = 0; i < 3; i += 1) {
    const material = await upsertItem('手提袋')
    assert.equal(material.category, 'material', `第 ${i + 1} 轮：手提袋应为 material`)
    const box = await upsertItem('8颗礼盒（长）', 'product')
    assert.equal(box.category, expectedBox, `第 ${i + 1} 轮：8颗礼盒（长）品类应保持 ${expectedBox}`)
    const temp = await upsertItem(`集成测试临时_${Date.now()}_${i}`, 'other')
    assert.equal(temp.category, 'other', `第 ${i + 1} 轮：临时货品应为 other`)
    await prisma.inventoryItem.delete({ where: { id: temp.id } })
  }

  // 修复行为：人为把手提袋改回 product，再走 upsertItem 应自动纠正
  await prisma.inventoryItem.update({ where: { name: '手提袋' }, data: { category: 'product' } })
  const repaired = await upsertItem('手提袋')
  assert.equal(repaired.category, 'material', 'upsertItem 应自动修复手提袋为 material')

  console.log('ITEM CATEGORY INTEGRATION OK (3 rounds)')
}

main()
  .catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    process.exit(process.exitCode || 0)
  })
