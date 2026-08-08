/**
 * 品类归一化单元测试（本地运行，循环 100 轮）：
 * node scripts/test-item-category.mjs
 */
import assert from 'node:assert/strict'
import { MATERIAL_NAMES as SRC_MATERIALS } from '../src/utils/productCategories.js'
import { resolveItemCategory } from '../src/utils/itemCategory.js'
import { MATERIAL_NAMES as SRV_MATERIALS, normalizeItemCategory } from '../server/productCategories.js'

const cases = [
  ['手提袋', 'product', 'material'],
  ['丝带-红', 'product', 'material'],
  ['酒精', undefined, 'material'],
  ['物料-8颗礼盒（长）', undefined, 'material'],
  ['8颗礼盒（长）', undefined, 'product'],
  ['8颗礼盒（长）', 'material', 'material'], // 手动设置的品类保留
  ['92%生巧', 'product', 'product'],
  ['自定义其他货品', 'other', 'other'],
  ['未知货品', 'bad', 'product'],
]

assert.deepEqual([...SRC_MATERIALS].sort(), [...SRV_MATERIALS].sort(), '前后端物料清单不一致，请同步 server/productCategories.js')

for (let round = 1; round <= 100; round += 1) {
  for (const name of SRC_MATERIALS) {
    assert.equal(resolveItemCategory(name, undefined), 'material', `resolve: ${name}`)
    assert.equal(normalizeItemCategory(name, 'product'), 'material', `normalize: ${name}`)
  }
  for (const [name, cat, expected] of cases) {
    assert.equal(resolveItemCategory(name, cat), expected, `resolve: ${name} / ${cat}`)
    assert.equal(normalizeItemCategory(name, cat), expected, `normalize: ${name} / ${cat}`)
  }
}

console.log('ITEM CATEGORY TEST OK (100 rounds)')
