import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeProductMenuSheets } from '../src/utils/productExcel.js'

test('自动识别中文菜单列、金额、分类并匹配现有 SKU', () => {
  const result = analyzeProductMenuSheets([{
    name: '菜单',
    rows: [
      ['BUDU 2026 菜单'],
      ['菜品名称', '商品编码', '菜品分类', '售价（元）', '成本价（元）', '单位'],
      ['卡皮巴拉布丁', ' budu-001 ', '甜品', '72', '23.50', '份'],
      ['草莓蛋糕', 'CAKE-002', '蛋糕', '¥38.00', '18.2', '个'],
    ],
  }], [{ productId: 'p-1', name: '卡皮巴拉布丁', sku: 'BUDU-001' }])
  assert.equal(result.validRows.length, 2)
  assert.deepEqual(result.validRows.map((row) => ({ name: row.name, sku: row.sku, sale: row.salePriceCents, cost: row.costPriceCents, action: row.action })), [
    { name: '卡皮巴拉布丁', sku: 'BUDU-001', sale: '7200', cost: '2350', action: 'update' },
    { name: '草莓蛋糕', sku: 'CAKE-002', sale: '3800', cost: '1820', action: 'create' },
  ])
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

