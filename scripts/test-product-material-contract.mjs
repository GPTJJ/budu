import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultModuleKeys, MODULE_KEYS } from '../shared/accountPermissions.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('产品物料管理位于申请采购正下方且默认只向管理角色开放', () => {
  const sidebar = read('src/components/Sidebar.jsx')
  const transfer = sidebar.indexOf("{ key: 'inventory-transfer', label: '门店调拨' }")
  const purchase = sidebar.indexOf("{ key: 'inventory-purchase', label: '申请采购' }")
  const master = sidebar.indexOf("{ key: 'product-material-management', label: '产品物料管理' }")
  assert.ok(transfer >= 0 && transfer < purchase && purchase < master)
  assert.ok(defaultModuleKeys('manager').includes(MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT))
  assert.ok(!defaultModuleKeys('staff').includes(MODULE_KEYS.PRODUCT_MATERIAL_MANAGEMENT))
})

test('调拨选择器读取启用主数据且不再导入写死产品物料列表', () => {
  const source = read('src/components/StoreTransferPage.jsx')
  assert.match(source, /\/v2\/transfer-master-items\?active=true/)
  assert.doesNotMatch(source, /NO_CANDY_NAMES|MATERIAL_NAMES/)
  assert.match(source, /transfer-submit-bar/)
  assert.match(source, /env\(safe-area-inset-bottom\)/)
})

test('主数据 API 没有物理删除路径且服务端拒绝停用货品新调拨', () => {
  const source = read('server/v2.js')
  assert.doesNotMatch(source, /delete\('\/transfer-master-items/)
  assert.match(source, /!existing\.transferEnabled/)
  assert.match(source, /货品已停用或不存在，请刷新后重试/)
})

test('产品管理与调拨选择器共同读取 PostgreSQL 产品分类且没有写死分类', () => {
  const management = read('src/components/ProductMaterialManagementPage.jsx')
  const transfer = read('src/components/StoreTransferPage.jsx')
  const server = read('server/v2.js')
  assert.match(management, /\/v2\/product-categories/)
  assert.match(transfer, /\/v2\/product-categories\?active=true/)
  assert.match(server, /prisma\.productCategory/)
  assert.doesNotMatch(`${management}\n${transfer}`, /\[['"]糖果|\[['"]礼盒|const\s+PRODUCT_CATEGORIES/)
})

test('分类和产品均无物理删除，批量归类与历史分类快照由服务端保护', () => {
  const source = read('server/v2.js')
  assert.doesNotMatch(source, /delete\('\/product-categories/)
  assert.match(source, /transfer-master-items\/bulk-category/)
  assert.match(source, /productCategoryNameSnapshot/)
  assert.match(source, /item\.productCategory\?\.name \|\| ''/)
})

test('调拨 Excel 使用已发货、发货时间、门店方向并生成汇总和明细 Sheet', () => {
  const source = read('src/utils/storeTransferExport.js')
  assert.match(source, /transferViewStatus\(record\.status\) !== 'shipped'/)
  assert.match(source, /record\.shippedAt/)
  assert.match(source, /调入数量/)
  assert.match(source, /调出数量/)
  assert.match(source, /净调拨/)
  assert.match(source, /append_sheet\(workbook, summarySheet, '调拨汇总'\)/)
  assert.match(source, /append_sheet\(workbook, detailSheet, '调拨明细'\)/)
})
