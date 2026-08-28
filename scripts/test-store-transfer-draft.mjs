import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initialTransferDraft, materialDraftItems, mergeTransferItems, productDraftRows,
  setDraftMaterialQuantity, setDraftProductQuantity, toggleDraftProduct,
  transferStatusLabel, transferViewStatus, validTransferQuantity,
} from '../src/utils/storeTransfer.js'
import { buildTransferExportData } from '../src/utils/storeTransferExport.js'

test('产品草稿与物料草稿完全隔离', () => {
  let draft = initialTransferDraft()
  draft = toggleDraftProduct(draft, 'NO.1树莓')
  draft = setDraftProductQuantity(draft, '6')
  draft = setDraftMaterialQuantity(draft, '冰袋', '3')

  assert.deepEqual(draft.product, { selectedNames: ['NO.1树莓'], batchQuantity: '6' })
  assert.deepEqual(draft.material, { quantities: { 冰袋: '3' } })
  assert.deepEqual(productDraftRows(draft), [{ category: 'product', productName: 'NO.1树莓', quantity: 6, note: '' }])
  assert.deepEqual(materialDraftItems(draft), [{ category: 'material', productName: '冰袋', quantity: 3, note: '' }])

  const materialChanged = setDraftMaterialQuantity(draft, '冰袋', '9')
  assert.deepEqual(materialChanged.product, draft.product)
  const productChanged = toggleDraftProduct(materialChanged, 'NO.2柠檬')
  assert.deepEqual(productChanged.material, materialChanged.material)
})

test('数量与清单合并合同', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', '1000000']) assert.equal(validTransferQuantity(value), false)
  for (const value of ['1', 12, '999999']) assert.equal(validTransferQuantity(value), true)
  const merged = mergeTransferItems(
    [{ category: 'product', productName: 'NO.1树莓', quantity: 2 }],
    [{ category: 'product', productName: 'NO.1树莓', quantity: 7 }, { category: 'material', productName: '冰袋', quantity: 1 }],
  )
  assert.deepEqual(merged.map((item) => item.quantity), [7, 1])
})

test('可靠历史状态只在展示层映射', () => {
  assert.equal(transferViewStatus('completed'), 'shipped')
  assert.equal(transferViewStatus('in_transit'), 'shipped')
  assert.equal(transferStatusLabel('rejected'), '已驳回')
  assert.equal(transferStatusLabel('unknown-legacy'), '—')
})

test('Excel 明细只使用已发货记录且包含正式调拨审计字段', () => {
  const { detailRows: rows } = buildTransferExportData([{
    id: 'tr-1', status: 'shipped', fromStoreKey: 'from', storeKey: 'to', createdAt: '2026-08-29T00:00:00.000Z',
    createdBy: '申请人', shippedBy: '发货人', shippedAt: '2026-08-29T01:00:00.000Z', note: '整单备注',
    items: [
      { category: 'product', productName: 'NO.1树莓', itemCode: 'NO.1', quantity: 2 },
      { category: 'material', productName: '冰袋', itemCode: 'MAT-ICE', quantity: 3 },
    ],
  }], { storeKeys: ['from', 'to'], storeLabel: (key) => key === 'from' ? '调出门店' : '调入门店' })
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]), ['调拨单号', '发货时间', '调出门店', '调入门店', '类型', '产品分类', '编号', '名称', '数量', '申请人', '发货确认人', '备注'])
  assert.deepEqual(rows.map((row) => [row.类型, row.名称, row.编号, row.数量]), [
    ['产品', 'NO.1树莓', 'NO.1', 2],
    ['物料', '冰袋', 'MAT-ICE', 3],
  ])
})
