import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPartnerSupplyWorkbook } from '../src/utils/partnerSupply.js'
import {
  MODULE_KEYS,
  canConfirmPartnerSupply,
  canManagePartnerSupplyPartners,
  canOverridePartnerSupplyPrice,
  canRegisterPartnerReceipt,
  normalizeAccountPermissions,
} from '../shared/accountPermissions.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('合作商供货导航位置、独立模块与唯一产品分类权威', () => {
  const sidebar = read('src/components/Sidebar.jsx')
  const purchase = sidebar.indexOf("{ key: 'inventory-purchase', label: '申请采购' }")
  const supply = sidebar.indexOf("{ key: 'partner-supply', label: '合作商供货' }")
  const master = sidebar.indexOf("{ key: 'product-material-management', label: '物料管理' }")
  assert.ok(purchase >= 0 && supply > purchase && master > supply)
  assert.equal(MODULE_KEYS.PARTNER_SUPPLY, 'partner-supply')
  const server = read('server/partner-supply.js')
  assert.match(server, /inventoryItem\.findMany/)
  assert.match(server, /productCategory: true/)
  assert.match(server, /partnerSupplyEnabled: true/)
  assert.match(server, /salePriceCents: \{ gt: 0n \}/)
  assert.doesNotMatch(server, /partnerSupplyEnabled: true[^}]*transferEnabled/s)
  assert.doesNotMatch(server, /PartnerProductCategory|partnerCategories/)
  assert.doesNotMatch(server, /stockBalance|stockLedger|StockBalance|StockLedger/)
})

test('合作商供货操作权限区分查看、发货、收款、合作商与价格管理', () => {
  const modulePermissions = { modules: { [MODULE_KEYS.PARTNER_SUPPLY]: true } }
  const manager = { id: 'u-manager', username: 'manager', role: 'manager', status: 'active', storeKeys: ['guanshe'], permissions: modulePermissions }
  const staff = { id: 'u-staff', username: 'staff', role: 'staff', status: 'active', storeKeys: ['guanshe'], permissions: modulePermissions }
  const finance = { id: 'u-finance', username: 'finance', role: 'finance', status: 'active', storeKeys: [], permissions: modulePermissions }
  assert.equal(canConfirmPartnerSupply(manager, 'guanshe'), true)
  assert.equal(canConfirmPartnerSupply(manager, 'tongying'), false)
  assert.equal(canConfirmPartnerSupply(staff, 'guanshe'), false)
  assert.equal(canRegisterPartnerReceipt(staff), false)
  assert.equal(canOverridePartnerSupplyPrice(manager), false)
  assert.equal(canManagePartnerSupplyPartners(manager), false)
  assert.equal(canRegisterPartnerReceipt(finance), true)
  assert.equal(canOverridePartnerSupplyPrice(finance), true)
  assert.equal(canManagePartnerSupplyPartners(finance), true)
  assert.equal(normalizeAccountPermissions({}, 'staff').modules[MODULE_KEYS.PARTNER_SUPPLY], true)
})

test('Excel 对账严格生成合作商汇总、供货明细、收款明细三个可统计 Sheet', () => {
  const report = {
    summary: [{ partnerId: 'p1', partnerName: '秦皇岛合作商', orderCount: 1, supplyAmountCents: '32500', receivedAmountCents: '20000', outstandingAmountCents: '12500' }],
    orders: [{
      orderNo: 'PS-20260829-ABC123', businessDate: '2026-08-29', partnerName: '秦皇岛合作商', fromStoreName: '北京官舍店', status: 'shipped', paymentStatus: 'partial', note: '微信群订单', createdBy: 'creator', shippedBy: 'manager', shippedAt: '2026-08-29T08:20:00.000Z',
      items: [{ productCode: 'NO.1', productName: '树莓', productCategory: '糖果', quantity: 100, retailPriceCents: '500', discountBps: 6500, partnerUnitPriceCents: '325', subtotalCents: '32500' }],
    }],
    receipts: [{ receivedDate: '2026-08-29', partnerName: '秦皇岛合作商', orderNo: 'PS-20260829-ABC123', amountCents: '20000', createdBy: 'finance', note: '微信转账' }],
  }
  const result = createPartnerSupplyWorkbook(report)
  assert.deepEqual(result.workbook.SheetNames, ['合作商汇总', '供货明细', '收款明细'])
  assert.equal(result.summaryRows[0].供货金额, 325)
  assert.equal(result.detailRows[0].零售价快照, 5)
  assert.equal(result.detailRows[0].合作折扣快照, '65%')
  assert.equal(result.detailRows[0].合作单价, 3.25)
  assert.equal(result.receiptRows[0].本次收款, 200)
})

test('供货与收款日期口径在服务端报告中保持独立', () => {
  const source = read('server/partner-supply.js')
  assert.match(source, /where\.businessDate = \{.*gte/s)
  assert.match(source, /receivedDate: \{.*gte/s)
  assert.match(source, /scopedOrderWhere\(req\.user, req\.query, false\)/)
  assert.match(source, /status: 'active'/)
})
