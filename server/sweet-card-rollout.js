import { hasModuleAccess, hasSweetCardPosRedeem, hasSweetCardProductionTestAccess, MODULE_KEYS } from '../shared/accountPermissions.js'
import { sweetCardCommercialEnabled, sweetCardEnabled } from './sweet-card-core.js'
import { httpError } from './pos-core.js'

export function sweetCardProductionAccess({
  user,
  storeEligible,
  globalEnabled = sweetCardEnabled(),
  commercialEnabled = sweetCardCommercialEnabled(),
  requiredModule = MODULE_KEYS.STORE_POS,
}) {
  return Boolean(
    globalEnabled &&
      storeEligible === true &&
      (commercialEnabled ? hasSweetCardPosRedeem(user) : hasSweetCardProductionTestAccess(user)) &&
      hasModuleAccess(user, requiredModule),
  )
}

export function requireSweetCardPosAccess(user, { commercialEnabled = sweetCardCommercialEnabled() } = {}) {
  const allowed = commercialEnabled ? hasSweetCardPosRedeem(user) : hasSweetCardProductionTestAccess(user)
  if (!allowed) throw httpError(commercialEnabled ? '当前账号未获甜意卡 POS 核销授权' : '当前账号未进入甜意卡生产测试范围', 403)
}

export function requireSweetCardProductionTestAccess(user) {
  if (!hasSweetCardProductionTestAccess(user)) {
    throw httpError('当前账号未进入甜意卡生产测试范围', 403)
  }
}

export function requireSweetCardProductionTestForOrder(user, order, { globalEnabled = sweetCardEnabled(), commercialEnabled = sweetCardCommercialEnabled(), storeEligible = false } = {}) {
  if (BigInt(order?.sweetCardAmount || 0) > 0n && !sweetCardProductionAccess({ user, storeEligible, globalEnabled, commercialEnabled })) {
    throw httpError(commercialEnabled ? '当前账号或门店未获甜意卡商业核销授权' : '当前账号或门店未进入甜意卡生产测试范围', 403)
  }
}
