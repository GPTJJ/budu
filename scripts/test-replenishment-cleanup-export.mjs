import test from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { replenishmentReviewWhere } from '../server/replenishment-review-service.js'
import { replenishmentQuickRange } from '../src/utils/replenishmentFilters.js'
import { createReplenishmentWorkbook } from '../src/utils/replenishmentExport.js'

const order = {
  orderNo: 'RPL-TEST-1', partnerNameSnapshot: '秦皇岛合作商', partnerStore: { name: '秦皇岛一店' },
  submittedAt: '2026-09-27T16:30:00.000Z', status: 'PARTIALLY_SHIPPED', requestedTotalAmountCents: '149500',
  items: [
    { productNameSnapshot: '公斤糖', skuSnapshot: 'KG-1', orderUnitSnapshot: 'KG', nativeUnitSnapshot: '', basePriceSnapshotCents: '18000', discountBpsSnapshot: 6500, requestedQuantityBase: 10000, shippedQuantityBase: 6000, remainingQuantityBase: 4000, requestedLineAmountCents: '117000' },
    { productNameSnapshot: '单颗糖', skuSnapshot: 'PCS-1', orderUnitSnapshot: 'PCS', nativeUnitSnapshot: '', basePriceSnapshotCents: '500', discountBpsSnapshot: 6500, requestedQuantityBase: 100, shippedQuantityBase: 30, remainingQuantityBase: 70, requestedLineAmountCents: '32500' },
  ],
}

test('申请日期按北京时间闭区间转换，状态使用现有枚举，合作商与门店同时限定', () => {
  const where = replenishmentReviewWhere({ status: 'PARTIALLY_SHIPPED', startDate: '2026-09-28', endDate: '2026-09-28', partnerId: 'p1', partnerStoreId: 's1' })
  assert.equal(where.submittedAt.gte.toISOString(), '2026-09-27T16:00:00.000Z')
  assert.equal(where.submittedAt.lt.toISOString(), '2026-09-28T16:00:00.000Z')
  assert.deepEqual({ status: where.status, partnerId: where.partnerId, partnerStoreId: where.partnerStoreId }, { status: 'PARTIALLY_SHIPPED', partnerId: 'p1', partnerStoreId: 's1' })
  assert.throws(() => replenishmentReviewWhere({ status: 'UNKNOWN' }), /状态筛选/)
  assert.throws(() => replenishmentReviewWhere({ startDate: '2026-02-30' }), /日期/)
  assert.throws(() => replenishmentReviewWhere({ startDate: '2026-09-29', endDate: '2026-09-28' }), /开始日期/)
})

test('六个快捷日期按北京时间和周一边界计算', () => {
  const now = new Date('2026-09-27T16:30:00.000Z')
  assert.deepEqual(replenishmentQuickRange('today', now), { startDate: '2026-09-28', endDate: '2026-09-28' })
  assert.deepEqual(replenishmentQuickRange('yesterday', now), { startDate: '2026-09-27', endDate: '2026-09-27' })
  assert.deepEqual(replenishmentQuickRange('week', now), { startDate: '2026-09-28', endDate: '2026-10-04' })
  assert.deepEqual(replenishmentQuickRange('lastWeek', now), { startDate: '2026-09-21', endDate: '2026-09-27' })
  assert.deepEqual(replenishmentQuickRange('month', now), { startDate: '2026-09-01', endDate: '2026-09-30' })
  assert.deepEqual(replenishmentQuickRange('lastMonth', now), { startDate: '2026-08-01', endDate: '2026-08-31' })
})

test('Excel 两个 Sheet 使用订单快照、供货价和全量行', () => {
  const workbook = createReplenishmentWorkbook([order, { ...order, orderNo: 'RPL-TEST-2' }])
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  const reread = XLSX.read(bytes, { type: 'buffer' })
  assert.deepEqual(reread.SheetNames, ['订单汇总', '商品明细'])
  const summary = XLSX.utils.sheet_to_json(reread.Sheets['订单汇总'])
  const detail = XLSX.utils.sheet_to_json(reread.Sheets['商品明细'])
  assert.equal(summary.length, 2)
  assert.equal(detail.length, 4)
  assert.equal(summary[0].申请日期, '2026/09/28 00:30')
  assert.equal(summary[0].订单金额, 1495)
  assert.equal(summary[0].申请总数量, '10 kg + 100 颗')
  assert.equal(detail[0].供货价, 117)
  assert.equal(detail[0].申请数量, 10)
  assert.equal(detail[0].已发数量, 6)
  assert.equal(detail[0].待发数量, 4)
  assert.equal(detail[0].小计, 1170)
  assert.equal(detail[1].供货价, 3.25)
  assert.equal(detail[1].小计, 325)
})

test('已驳回订单无待发数量，审核后按获批未发数量展示', () => {
  const rejected = createReplenishmentWorkbook([{ ...order, status: 'REJECTED', items: [{ ...order.items[0], remainingQuantityBase: null }] }])
  const approved = createReplenishmentWorkbook([{ ...order, status: 'PARTIALLY_SHIPPED', items: [{ ...order.items[0], approvedQuantityBase: 7000, remainingQuantityBase: 1000 }] }])
  assert.equal(XLSX.utils.sheet_to_json(rejected.Sheets['商品明细'])[0].待发数量, 0)
  assert.equal(XLSX.utils.sheet_to_json(approved.Sheets['商品明细'])[0].待发数量, 1)
})
