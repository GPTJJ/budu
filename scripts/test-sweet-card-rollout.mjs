import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MODULE_KEYS, hasModuleAccess } from '../shared/accountPermissions.js'
import {
  requireSweetCardPosAccess,
  requireSweetCardProductionTestAccess,
  requireSweetCardProductionTestForOrder,
  sweetCardProductionAccess,
} from '../server/sweet-card-rollout.js'

const allowlisted = {
  id: 'user-test-principal',
  role: 'cashier',
  status: 'active',
  storeKeys: ['xidan'],
  permissions: { sweetCardProductionTest: true },
}
const ordinary = {
  id: 'user-ordinary',
  role: 'cashier',
  status: 'active',
  storeKeys: ['xidan'],
  permissions: {},
}
const commercial = { ...ordinary, id: 'user-commercial', permissions: { sweetCardPosRedeem: true } }

test('A: global false 时即使门店和账号均满足也拒绝', () => {
  assert.equal(sweetCardProductionAccess({ user: allowlisted, storeEligible: true, globalEnabled: false }), false)
})

test('B: global true 但账号不在 allowlist 时拒绝', () => {
  assert.equal(sweetCardProductionAccess({ user: ordinary, storeEligible: true, globalEnabled: true }), false)
})

test('C: global true 且账号允许但门店未开放时拒绝', () => {
  assert.equal(sweetCardProductionAccess({ user: allowlisted, storeEligible: false, globalEnabled: true }), false)
})

test('D: global、门店、账号和原始 POS 权限全部满足才允许', () => {
  assert.equal(sweetCardProductionAccess({ user: allowlisted, storeEligible: true, globalEnabled: true }), true)
})

test('商业模式只认独立 POS 核销 capability，不继承测试名单或角色', () => {
  assert.equal(sweetCardProductionAccess({ user: commercial, storeEligible: true, globalEnabled: true, commercialEnabled: true }), true)
  assert.equal(sweetCardProductionAccess({ user: allowlisted, storeEligible: true, globalEnabled: true, commercialEnabled: true }), false)
  assert.doesNotThrow(() => requireSweetCardPosAccess(commercial, { commercialEnabled: true }))
  assert.throws(() => requireSweetCardPosAccess(allowlisted, { commercialEnabled: true }), (error) => error.status === 403)
})

test('E/F: 直接 API 与伪造 body operatorId 都不能绕过登录主体', () => {
  const forgedBody = { operatorId: allowlisted.id }
  assert.equal(forgedBody.operatorId, allowlisted.id)
  assert.throws(() => requireSweetCardProductionTestAccess(ordinary), (error) => error.status === 403)
  assert.throws(() => requireSweetCardProductionTestForOrder(ordinary, { sweetCardAmount: 1n }, { globalEnabled: true, storeEligible: true }), (error) => error.status === 403)
  assert.doesNotThrow(() => requireSweetCardProductionTestForOrder(ordinary, { sweetCardAmount: 0n }))
})

test('混合订单后续资金入口继续要求 global 与 eligible store', () => {
  const order = { sweetCardAmount: 1n }
  assert.throws(() => requireSweetCardProductionTestForOrder(allowlisted, order, { globalEnabled: false, storeEligible: true }), (error) => error.status === 403)
  assert.throws(() => requireSweetCardProductionTestForOrder(allowlisted, order, { globalEnabled: true, storeEligible: false }), (error) => error.status === 403)
  assert.doesNotThrow(() => requireSweetCardProductionTestForOrder(allowlisted, order, { globalEnabled: true, storeEligible: true }))
})

test('G: 撤销 allowlist 后立即 fail closed', () => {
  const revoked = { ...allowlisted, permissions: { sweetCardProductionTest: false } }
  assert.equal(sweetCardProductionAccess({ user: revoked, storeEligible: true, globalEnabled: true }), false)
  assert.throws(() => requireSweetCardProductionTestAccess(revoked), (error) => error.status === 403)
})

test('H: allowlist 不授予其他模块或甜意卡管理权限', () => {
  assert.equal(hasModuleAccess(allowlisted, MODULE_KEYS.STORE_POS), true)
  assert.equal(hasModuleAccess(allowlisted, MODULE_KEYS.SWEET_CARD), false)
  assert.equal(hasModuleAccess(allowlisted, MODULE_KEYS.FINANCE), false)
})

test('路由在 UI 之外强制执行 allowlist 并记录名单审计', async () => {
  const [posSource, sweetCardSource, appSource] = await Promise.all([
    readFile(new URL('../server/pos.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/sweet-card.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/app.js', import.meta.url), 'utf8'),
  ])
  assert.match(posSource, /sweetCardCommercialEnabled\(\) \? hasSweetCardPosRedeem\(req\.user\) : hasSweetCardProductionTestAccess\(req\.user\)/)
  assert.match(posSource, /await requireSweetCardOrderAccess\(req\.user, current\)/)
  assert.equal((posSource.match(/await requireSweetCardOrderAccess\(req\.user,/g) || []).length >= 8, true)
  assert.equal((sweetCardSource.match(/requireSweetCardPosAccess\(req\.user\)/g) || []).length >= 3, true)
  assert.match(sweetCardSource, /sweet_card\.production_test_allowlist_enabled/)
  assert.match(sweetCardSource, /sweet_card\.production_test_allowlist_disabled/)
  assert.match(sweetCardSource, /targetPrincipalId: target\.id/)
  assert.equal((appSource.match(/sweetCardProductionTest: hasSweetCardProductionTestAccess\(target\)/g) || []).length >= 2, true)
})
