import { hasModuleAccess, hasSweetCardProductionTestAccess, MODULE_KEYS } from '../shared/accountPermissions.js'
import { sweetCardEnabled } from './sweet-card-core.js'
import { httpError } from './pos-core.js'

export function sweetCardProductionAccess({
  user,
  storeEligible,
  globalEnabled = sweetCardEnabled(),
  requiredModule = MODULE_KEYS.STORE_POS,
}) {
  return Boolean(
    globalEnabled &&
      storeEligible === true &&
      hasSweetCardProductionTestAccess(user) &&
      hasModuleAccess(user, requiredModule),
  )
}

export function requireSweetCardProductionTestAccess(user) {
  if (!hasSweetCardProductionTestAccess(user)) {
    throw httpError('当前账号未进入甜意卡生产测试范围', 403)
  }
}

export function requireSweetCardProductionTestForOrder(user, order) {
  if (BigInt(order?.sweetCardAmount || 0) > 0n) requireSweetCardProductionTestAccess(user)
}
