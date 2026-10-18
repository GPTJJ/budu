import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIXED_STORES, FIXED_STORE_KEYS, isFixedStoreKey, isStoreKey } from '../shared/storeDirectory.js'

const root = resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')

test('原四家门店种子身份保持稳定；动态 key 语法不等同于已登记身份', () => {
  assert.deepEqual(FIXED_STORE_KEYS, ['tongying', 'guanshe', 'chaowai', 'xidan'])
  assert.deepEqual(FIXED_STORES.map((store) => store.name), [
    '北京通盈中心店',
    '北京官舍店',
    '北京朝外店',
    '北京西单店',
  ])
  assert.equal(isFixedStoreKey('multi'), false)
  assert.equal(isFixedStoreKey('custom-test'), false)
  assert.equal(isStoreKey('store-0123456789abcdef0123'), true)
  for (const key of ['multi', 'all', ' name', 'store-A', 'x'.repeat(31), '仓库']) assert.equal(isStoreKey(key), false)
})

test('正式门店通过受控 PG 管理新增；普通业务与调货临时地点不得自动造店', () => {
  const selectors = read('src/utils/selectors.js')
  const settings = read('src/components/SettingsPage.jsx')
  const storeManagement = read('src/components/settings/StoreManagementPage.jsx')
  const inventory = read('src/components/InventoryRequestPage.jsx')
  const v2 = read('server/v2.js')
  const daily = read('server/daily-entry-upgrade.js')
  assert.doesNotMatch(selectors, /多店支援|key === 'multi'/)
  assert.match(settings, /StoreManagementPage/)
  assert.match(storeManagement, /新增门店/)
  assert.match(storeManagement, /requestKey/)
  assert.doesNotMatch(inventory, /自定义门店|tempStores|\/v2\/stores.*POST/)
  assert.match(inventory, /添加临时地点/)
  assert.match(inventory, /fromLocationName/)
  assert.match(v2, /fromLocationName/)
  assert.doesNotMatch(v2, /ensureStore\(fromLocationName\)|ensureStore\(toLocationName\)/)
  assert.doesNotMatch(v2, /isFixedStoreKey|\.store\.(?:create|upsert)\(/)
  assert.doesNotMatch(daily, /isFixedStoreKey|\.store\.(?:create|upsert)\(/)
  assert.match(v2, /assertExistingStore/)
  assert.match(daily, /assertExistingStore/)
  const backfill = read('scripts/store-backfill.mjs')
  assert.doesNotMatch(backfill, /\.store\.update(?:Many)?\(/)
})

test('旧生产 compose 部署入口被硬阻断', () => {
  const deploy = read('scripts/deploy-remote.sh')
  assert.match(deploy, /if \[ "\$ENV" = "prod" \]/)
  assert.match(deploy, /authority-aware green deployment/)
})
