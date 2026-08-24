import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIXED_STORES, FIXED_STORE_KEYS, isFixedStoreKey } from '../shared/storeDirectory.js'

const root = resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')

test('门店目录精确且只包含四家门店', () => {
  assert.deepEqual(FIXED_STORE_KEYS, ['tongying', 'guanshe', 'chaowai', 'xidan'])
  assert.deepEqual(FIXED_STORES.map((store) => store.name), [
    '北京通盈中心店',
    '北京官舍店',
    '北京朝外店',
    '北京西单店',
  ])
  assert.equal(isFixedStoreKey('multi'), false)
  assert.equal(isFixedStoreKey('custom-test'), false)
})

test('前后端禁止恢复自定义门店和多店支援', () => {
  const selectors = read('src/utils/selectors.js')
  const settings = read('src/components/SettingsPage.jsx')
  const inventory = read('src/components/InventoryRequestPage.jsx')
  const v2 = read('server/v2.js')
  const daily = read('server/daily-entry-upgrade.js')
  assert.doesNotMatch(selectors, /多店支援|key === 'multi'/)
  assert.doesNotMatch(settings, /新增门店|removeStore|addStore/)
  assert.doesNotMatch(inventory, /自定义门店|customSide|tempStores/)
  assert.match(v2, /isFixedStoreKey/)
  assert.match(daily, /isFixedStoreKey/)
})

test('旧生产 compose 部署入口被硬阻断', () => {
  const deploy = read('scripts/deploy-remote.sh')
  assert.match(deploy, /if \[ "\$ENV" = "prod" \]/)
  assert.match(deploy, /authority-aware green deployment/)
})
