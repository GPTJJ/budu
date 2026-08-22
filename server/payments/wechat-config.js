// 微信支付配置读取（付款码支付 V2 MICROPAY）
//
// 安全约定：
// - APIv2 密钥与商户私钥只从 Secret 文件读取（WECHAT_PAY_API_V2_KEY_FILE 等），
//   不支持多行环境变量直接注入。
// - 本模块只对外暴露“已配置/未配置/是否启用”等布尔与安全元数据，
//   绝不暴露密钥、证书或私钥内容。
// - 默认 WECHAT_PAY_ENABLED=0：未显式开启时任何通道开关都返回关闭。
import fs from 'node:fs'

export const WECHAT_PAY_PROTOCOL = 'v2_micropay'

function readSecretFile(envName, label) {
  const filePath = String(process.env[envName] || '').trim()
  if (!filePath) return { ok: false, reason: `${label} 未配置（缺少 ${envName}）` }
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { ok: false, reason: `${label} 不是普通文件` }
    const content = fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '')
    if (!content) return { ok: false, reason: `${label} 文件为空` }
    return { ok: true, value: content }
  } catch (error) {
    return { ok: false, reason: `${label} 文件不可读：${error.code || error.message}` }
  }
}

/**
 * 读取完整微信支付配置。绝不返回密钥内容到调用方以外的任何输出。
 * @returns {{enabled:boolean, protocol:string, configured:boolean,
 *            mchId:string, appId:string, terminalIp:string,
 *            enabledStores:string[], apiV2Key:string, certPem:string, keyPem:string,
 *            reason:string}}
 */
export function wechatPayConfig() {
  const enabled = String(process.env.WECHAT_PAY_ENABLED || '0').trim() === '1'
  const protocol = String(process.env.WECHAT_PAY_PROTOCOL || WECHAT_PAY_PROTOCOL).trim()
  const mchId = String(process.env.WECHAT_PAY_MCHID || '').trim()
  const appId = String(process.env.WECHAT_PAY_APPID || '').trim()
  const terminalIp = String(process.env.WECHAT_PAY_TERMINAL_IP || '').trim()
  const enabledStores = String(process.env.WECHAT_PAY_ENABLED_STORES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  const keyFile = readSecretFile('WECHAT_PAY_API_V2_KEY_FILE', 'APIv2 密钥')
  const certFile = readSecretFile('WECHAT_PAY_CERT_FILE', '商户 API 证书')
  const privateKeyFile = readSecretFile('WECHAT_PAY_PRIVATE_KEY_FILE', '商户私钥')

  const problems = []
  if (!mchId) problems.push('商户号未配置')
  if (!appId) problems.push('AppID 未配置')
  if (!keyFile.ok) problems.push(keyFile.reason)
  if (!certFile.ok) problems.push(certFile.reason)
  if (!privateKeyFile.ok) problems.push(privateKeyFile.reason)
  if (protocol !== WECHAT_PAY_PROTOCOL) problems.push(`协议必须为 ${WECHAT_PAY_PROTOCOL}`)

  const configured = problems.length === 0
  return {
    enabled,
    protocol,
    configured,
    mchId,
    appId,
    terminalIp,
    enabledStores,
    apiV2Key: keyFile.ok ? keyFile.value : '',
    certPem: certFile.ok ? certFile.value : '',
    keyPem: privateKeyFile.ok ? privateKeyFile.value : '',
    reason: configured ? '' : problems.join('；'),
  }
}

/** 只读状态（供 /pos/config 等安全输出）：不包含任何密钥/证书内容。 */
export function wechatPayStatus() {
  const config = wechatPayConfig()
  return {
    configured: config.configured,
    enabled: config.enabled && config.configured,
    reason: config.configured ? '' : config.reason,
  }
}

/** 门店是否在授权灰度名单内：名单为空表示全部门店开放。 */
export function wechatPayStoreAllowed(storeId, config) {
  const enabledStores = config?.enabledStores
  if (!enabledStores || enabledStores.length === 0) return true
  return enabledStores.includes(String(storeId || ''))
}

/**
 * 前端通道状态（fail closed）：仅当支付模式为 live 且微信显式开启、配置完整、
 * 且门店在灰度名单内时才返回 enabled=true。绝不返回任何商户配置。
 * @param {string} [storeKey]
 * @param {'mock'|'live'} [paymentMode]
 */
export function wechatPayFrontendStatus(storeKey, paymentMode) {
  const status = wechatPayStatus()
  if (paymentMode !== 'live' || !status.enabled) return { enabled: false }
  const config = wechatPayConfig()
  return { enabled: wechatPayStoreAllowed(storeKey, config) }
}
