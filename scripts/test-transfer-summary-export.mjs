import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransferExportData, createTransferExportWorkbook } from '../src/utils/storeTransferExport.js'

const names = { guanshe: '官舍店', tongying: '通盈店', xidan: '西单店' }
const storeLabel = (key, legacy = '') => legacy || names[key] || key
const records = [
  {
    id: 'shipped-1', status: 'shipped', shippedAt: '2026-08-10T01:00:00.000Z',
    fromStoreKey: 'guanshe', storeKey: 'tongying', createdBy: '申请甲', shippedBy: '发货甲', note: '第一单',
    items: [
      { category: 'product', productCategory: '糖果', itemCode: 'NO.1', productName: '树莓', quantity: 50 },
      { category: 'material', productCategory: '', itemCode: '', productName: '冰袋', quantity: 5 },
    ],
  },
  {
    id: 'legacy-completed', status: 'completed', shippedAt: '2026-08-11T02:00:00.000Z',
    fromStoreKey: 'xidan', storeKey: 'tongying', createdBy: '申请乙', shippedBy: '发货乙', note: '',
    items: [{ category: 'product', productCategory: '糖果', itemCode: 'NO.1', productName: '树莓', quantity: 100 }],
  },
  {
    id: 'pending', status: 'pending', shippedAt: '2026-08-11T03:00:00.000Z',
    fromStoreKey: 'guanshe', storeKey: 'tongying', items: [{ category: 'product', productCategory: '糖果', itemCode: 'NO.1', productName: '树莓', quantity: 999 }],
  },
  {
    id: 'outside', status: 'shipped', shippedAt: '2026-07-31T03:00:00.000Z',
    fromStoreKey: 'guanshe', storeKey: 'tongying', items: [{ category: 'product', productCategory: '', itemCode: 'OLD', productName: '历史未分类', quantity: 7 }],
  },
]

test('汇总只使用已发货与发货确认时间，并按门店拆分调入调出和净调拨', () => {
  const result = buildTransferExportData(records, { dateFrom: '2026-08-01', dateTo: '2026-08-31', storeKeys: ['guanshe', 'tongying'], itemType: 'all', storeLabel })
  assert.equal(result.detailRows.length, 3)
  assert.equal(result.detailRows.some((row) => row.调拨单号 === 'pending' || row.调拨单号 === 'outside'), false)
  const guansheProduct = result.summaryRows.find((row) => row.门店 === '官舍店' && row.类型 === '产品')
  const tongyingProduct = result.summaryRows.find((row) => row.门店 === '通盈店' && row.类型 === '产品')
  assert.deepEqual([guansheProduct.调入数量, guansheProduct.调出数量, guansheProduct.净调拨], [0, 50, -50])
  assert.deepEqual([tongyingProduct.调入数量, tongyingProduct.调出数量, tongyingProduct.净调拨], [150, 0, 150])
  assert.equal(result.summaryRows.find((row) => row.门店 === '通盈店' && row.类型 === '物料').分类, '—')
})

test('单门店、多门店、产品、物料与全部筛选保持门店维度', () => {
  const single = buildTransferExportData(records, { dateFrom: '2026-08-01', dateTo: '2026-08-31', storeKeys: ['tongying'], itemType: 'all', storeLabel })
  assert.deepEqual([...new Set(single.summaryRows.map((row) => row.门店))], ['通盈店'])
  const products = buildTransferExportData(records, { dateFrom: '2026-08-01', dateTo: '2026-08-31', storeKeys: ['guanshe', 'tongying'], itemType: 'product', storeLabel })
  assert.equal(products.summaryRows.every((row) => row.类型 === '产品'), true)
  assert.equal(products.detailRows.length, 2)
  const materials = buildTransferExportData(records, { dateFrom: '2026-08-01', dateTo: '2026-08-31', storeKeys: ['guanshe', 'tongying'], itemType: 'material', storeLabel })
  assert.equal(materials.summaryRows.every((row) => row.类型 === '物料'), true)
  assert.equal(materials.detailRows.length, 1)
})

test('Excel 同时包含调拨汇总与调拨明细并保留追溯字段', () => {
  const { workbook, summaryRows, detailRows } = createTransferExportWorkbook(records, { dateFrom: '2026-08-01', dateTo: '2026-08-31', storeKeys: ['guanshe', 'tongying'], itemType: 'all', storeLabel })
  assert.deepEqual(workbook.SheetNames, ['调拨汇总', '调拨明细'])
  assert.deepEqual(Object.keys(summaryRows[0]), ['门店', '类型', '分类', '编号', '名称', '调入数量', '调出数量', '净调拨'])
  assert.deepEqual(Object.keys(detailRows[0]), ['调拨单号', '发货时间', '调出门店', '调入门店', '类型', '产品分类', '编号', '名称', '数量', '申请人', '发货确认人', '备注'])
})
