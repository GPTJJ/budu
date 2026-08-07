import crypto from 'node:crypto'

/**
 * 美团餐饮开放平台签名（默认按「appSecret + 排序参数串 + appSecret」MD5 大写；
 * 若官方文档使用 SHA1/其他规则，仅需改这里，勿动其他模块）。
 */
export function meituanSign(params, appSecret) {
  const keys = Object.keys(params).sort()
  const qs = keys.map((k) => `${k}=${params[k]}`).join('')
  return crypto.createHash('md5').update(`${appSecret}${qs}${appSecret}`).digest('hex').toUpperCase()
}
