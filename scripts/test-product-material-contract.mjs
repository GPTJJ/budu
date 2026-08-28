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
