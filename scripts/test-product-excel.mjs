import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeProductMenuSheets } from '../src/utils/productExcel.js'

test('导出商品 ID 才允许更新，Excel SKU 不作为写入身份', () => {
  const result = analyzeProductMenuSheets([{
    name: '菜单',
    rows: [
      ['BUDU 2026 菜单'],
      ['商品ID', '菜品名称', '商品编码', '菜品分类', '售价（元）', '成本价（元）', '单位'],
      ['p-1', '卡皮巴拉布丁', ' bd-000001 ', '甜品', '72', '23.50', '份'],
      ['', '草莓蛋糕', 'CAKE-002', '蛋糕', '¥38.00', '18.2', '个'],
    ],
  }], [{ productId: 'p-1', name: '卡皮巴拉布丁', sku: 'BD-000001', version: 7 }])
  assert.equal(result.validRows.length, 2)
  assert.deepEqual(result.validRows.map((row) => ({ name: row.name, sku: row.sku, sale: row.salePriceCents, cost: row.costPriceCents, action: row.action })), [
    { name: '卡皮巴拉布丁', sku: 'BD-000001', sale: '7200', cost: '2350', action: 'update' },
    { name: '草莓蛋糕', sku: 'CAKE-002', sale: '3800', cost: '1820', action: 'create' },
  ])
  assert.equal(result.rows[0].matchedProductId, 'p-1')
  assert.equal(result.rows[0].matchedVersion, 7)
})

test('支持英文列名、工作表分类和分类行继承', () => {
  const result = analyzeProductMenuSheets([{
    name: 'Ice Cream',
    rows: [
      ['Name', 'SKU', 'Sale Price', 'Cost Price'],
      ['冰淇淋', '', '', ''],
      ['单球', 'ICE-01', '36', '12'],
    ],
  }])
  assert.equal(result.validRows.length, 1)
  assert.equal(result.validRows[0].posCategory, '冰淇淋')
  assert.equal(result.validRows[0].isActive, true)
})

test('缺失必填列值和 Excel 内重复 SKU 会标记并跳过', () => {
  const result = analyzeProductMenuSheets([{
    name: '糖果',
    rows: [
      ['菜品名', 'SKU', '售价', '成本价'],
      ['糖果 A', 'CANDY-1', '5', '3'],
      ['糖果 B', 'CANDY-1', 'abc', ''],
    ],
  }])
  assert.equal(result.validRows.length, 0)
  assert.match(result.rows[0].errors.join(','), /SKU 重复/)
  assert.match(result.rows[1].errors.join(','), /售价|成本价|SKU 重复/)
})

test('同名但不同 SKU 不会自动关联历史商品', () => {
  const result = analyzeProductMenuSheets([{
    name: '菜单',
    rows: [
      ['菜品名', 'SKU', '分类', '售价', '成本价'],
      ['历史商品', 'NEW-SKU', '甜品', '10', '3'],
    ],
  }], [{ productId: 'stable-history-id', name: '历史商品', sku: 'OLD-SKU' }])
  assert.equal(result.validRows.length, 0)
  assert.equal(result.rows[0].matchedProductId, '')
  assert.match(result.rows[0].errors.join(','), /禁止按名称或 SKU 自动关联/)
})

test('历史别名即使指向现有商品也不能自动关联导入行', () => {
  const result = analyzeProductMenuSheets([{ name: '菜单', rows: [
    ['菜品名', 'SKU', '售价', '成本价'],
    ['历史商品', 'OLD-SKU', '10', '3'],
  ] }], [{ productId: 'stable-id', name: '历史商品', sku: 'BD-000001', skuAliases: ['OLD-SKU'] }])
  assert.equal(result.validRows.length, 0)
  assert.equal(result.rows[0].matchedProductId, '')
})
