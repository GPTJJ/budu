/**
 * OS 控制台 ↔ 线上结算运行时 的窄桥。
 *
 * 发货同步（微信「发货信息管理」）必须复用运行时里那一套 access_token 权威，
 * 不能在 OS 路由里另建客户端。这里只暴露一个注册函数，由 app 在装配时注入；
 * 未注入时调用方跳过同步，绝不影响发货事实本身。
 */
let shippingRegistrar = null

export function setShippingRegistrar(fn) {
  shippingRegistrar = typeof fn === 'function' ? fn : null
}

export async function registerWechatShipping(settlementId) {
  if (!shippingRegistrar) return { skipped: true }
  return shippingRegistrar(settlementId)
}
