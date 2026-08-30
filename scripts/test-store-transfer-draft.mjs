import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initialTransferDraft, materialDraftItems, mergeTransferItems, productDraftRows,
  setDraftMaterialQuantity, setDraftProductQuantity, setDraftProductUnitQuantity, toggleDraftProduct,
  transferEstimatedWeightLabel, transferQuantityLabel, transferStatusLabel, transferViewStatus,
  validTransferItemQuantity, validTransferQuantity,
} from '../src/utils/storeTransfer.js'
import { buildTransferExportData } from '../src/utils/storeTransferExport.js'

const masters = [
  { id: 'ordinary', category: 'product', name: '普通巧克力' },
  { id: 'candy', category: 'product', name: 'NO.2 柠檬', transferBoxEnabled: true, transferBoxWeightGrams: 2500, transferPieceEnabled: true, transferPieceWeightGrams: 6 },
  { id: 'box-only', category: 'product', name: '整箱商品', transferBoxEnabled: true, transferBoxWeightGrams: 1200 },
  { id: 'ice-bag', category: 'material', name: '冰袋' },
]

test('普通产品草稿与物料草稿完全隔离', () => {
  let draft = initialTransferDraft()
  draft = toggleDraftProduct(draft, 'ordinary')
  draft = setDraftProductQuantity(draft, '6')
  draft = setDraftMaterialQuantity(draft, 'ice-bag', '3')
  assert.deepEqual(draft.product, { selectedIds: ['ordinary'], batchQuantity: '6', unitQuantities: {} })
  assert.deepEqual(productDraftRows(draft, masters), [{ itemId: 'ordinary', category: 'product', productName: '普通巧克力', quantity: 6, note: '' }])
  assert.deepEqual(materialDraftItems(draft, masters), [{ itemId: 'ice-bag', category: 'material', productName: '冰袋', quantity: 3, note: '' }])
  const productChanged = toggleDraftProduct(setDraftMaterialQuantity(draft, 'ice-bag', '9'), 'candy')
  assert.deepEqual(productChanged.material, { quantities: { 'ice-bag': '9' } })
})

test('仅整箱、仅散颗和混合数量分别保存，估算重量标记约', () => {
  let draft = toggleDraftProduct(initialTransferDraft(), 'candy')
  draft = setDraftProductUnitQuantity(draft, 'candy', 'box', '1')
  assert.equal(transferQuantityLabel(productDraftRows(draft, masters)[0]), '1箱')
  draft = setDraftProductUnitQuantity(draft, 'candy', 'box', '')
  draft = setDraftProductUnitQuantity(draft, 'candy', 'piece', '166')
  assert.equal(transferQuantityLabel(productDraftRows(draft, masters)[0]), '166颗')
  draft = setDraftProductUnitQuantity(draft, 'candy', 'box', '1')
  const mixed = productDraftRows(draft, masters)[0]
  assert.equal(transferQuantityLabel(mixed), '1箱 + 166颗')
  assert.equal(transferEstimatedWeightLabel(mixed), '约3.50kg')
  assert.equal(validTransferItemQuantity(mixed), true)
})

test('0箱0颗不可加入，不同商品单位数量相互独立', () => {
  let draft = toggleDraftProduct(initialTransferDraft(), 'candy')
  draft = toggleDraftProduct(draft, 'box-only')
  draft = setDraftProductUnitQuantity(draft, 'candy', 'piece', '50')
  draft = setDraftProductUnitQuantity(draft, 'box-only', 'box', '2')
  assert.deepEqual(productDraftRows(draft, masters).map((row) => [row.itemId, row.boxQuantity, row.pieceQuantity]), [['candy', 0, 50], ['box-only', 2, 0]])
  assert.deepEqual(productDraftRows(toggleDraftProduct(initialTransferDraft(), 'candy'), masters), [])
  assert.equal(validTransferItemQuantity({ quantity: null, boxQuantity: 0, pieceQuantity: 0 }), false)
})

test('普通数量与清单合并合同保持兼容', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', '1000000']) assert.equal(validTransferQuantity(value), false)
  for (const value of ['1', 12, '999999']) assert.equal(validTransferQuantity(value), true)
  const merged = mergeTransferItems(
    [{ itemId: 'ordinary', category: 'product', productName: '普通巧克力', quantity: 2 }],
    [{ itemId: 'ordinary', category: 'product', productName: '普通巧克力', quantity: 7 }, { category: 'material', productName: '冰袋', quantity: 1 }],
  )
  assert.deepEqual(merged.map((item) => item.quantity), [7, 1])
})

test('可靠历史状态只在展示层映射', () => {
  assert.equal(transferViewStatus('completed'), 'shipped')
  assert.equal(transferStatusLabel('rejected'), '已驳回')
})

test('Excel 明细保留旧数量及箱颗真实单位', () => {
  const { detailRows: rows } = buildTransferExportData([{
    id: 'tr-1', status: 'shipped', fromStoreKey: 'from', storeKey: 'to', createdAt: '2026-08-29T00:00:00.000Z',
    createdBy: '申请人', shippedBy: '发货人', shippedAt: '2026-08-29T01:00:00.000Z', note: '整单备注',
    items: [
      { category: 'product', productName: 'NO.2 柠檬', itemCode: 'NO.2', quantity: null, boxQuantity: 1, pieceQuantity: 166, boxWeightGrams: 2500, pieceWeightGrams: 6 },
      { category: 'material', productName: '冰袋', itemCode: 'MAT-ICE', quantity: 3 },
    ],
  }], { storeKeys: ['from', 'to'], storeLabel: (key) => key === 'from' ? '调出门店' : '调入门店' })
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[0].箱数, rows[0].散颗数, rows[0]['估算重量（约kg）']], [1, 166, 3.496])
  assert.equal(rows[1]['历史数量（件）'], 3)
})
