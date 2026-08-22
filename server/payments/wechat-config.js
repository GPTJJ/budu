// 微信支付配置读取与严格校验（付款码支付 V2 MICROPAY）
//
// 安全约定：
// - APIv2 密钥与商户私钥只从 Secret 文件读取，不支持多行环境变量直接注入。
// - 校验失败即 configured=false，真实微信支付保持不可用（fail closed）。
// - 本模块绝不打印/暴露 APIv2 密钥、私钥、证书私密材料；对外只暴露布尔与安全元数据。
// - 默认 WECHAT_PAY_ENABLED=0：未显式开启时任何通道开关都返回关闭。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { isValidPublicIpv4 } from './terminal-ip.js'

export const WECHAT_PAY_PROTOCOL = 'v2_micropay'

// APIv2 密钥：微信官方要求 32 位数字+字母
const API_V2_KEY_RE = /^[A-Za-z0-9]{32}$/
// 商户号：数字，8-16 位
const MCH_ID_RE = /^\d{8,16}$/
// AppID：wx + 16 位字母数字
const APP_ID_RE = /^wx[A-Za-z0-9]{16}$/

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

// 终端 IP 规则唯一权威实现见 terminal-ip.js（配置层与 Provider 边界共用）

export function validateCertificate(certPem, nowMs = Date.now()) {
  try {
    const cert = new crypto.X509Certificate(certPem)
    const now = nowMs
    const notBefore = Date.parse(cert.validFrom)
    const notAfter = Date.parse(cert.validTo)
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return { ok: false, reason: '证书日期无法解析' }
    if (now < notBefore) return { ok: false, reason: '证书尚未生效' }
    if (now > notAfter) return { ok: false, reason: '证书已过期' }
    return { ok: true, value: cert }
  } catch {
    return { ok: false, reason: '证书不是有效 X.509 PEM' }
  }
}

function validatePrivateKey(keyPem) {
  try {
    const key = crypto.createPrivateKey(keyPem)
    return { ok: true, value: key }
  } catch {
    return { ok: false, reason: '私钥无法解析' }
  }
}

function certificatesMatch(cert, key) {
  try {
    const certPublic = cert.publicKey.export({ type: 'spki', format: 'der' })
    // 私钥 KeyObject 需先派生公钥（Node 26 语义），再导出 SPKI 比较
    const keyPublic = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })
    return certPublic.equals(keyPublic)
  } catch {
    return false
  }
}

/**
 * 读取并严格校验微信支付配置。绝不输出密钥内容。
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
  else if (!MCH_ID_RE.test(mchId)) problems.push('商户号格式无效（须 8-16 位数字）')
  if (!appId) problems.push('AppID 未配置')
  else if (!APP_ID_RE.test(appId)) problems.push('AppID 格式无效（须 wx 开头共 18 位字母数字）')
  if (!terminalIp) problems.push('终端 IP 未配置（MICROPAY 必填）')
  else if (!isValidPublicIpv4(terminalIp)) problems.push('终端 IP 无效（须公网可路由 IPv4，拒绝回环/私网/保留段）')
  if (protocol !== WECHAT_PAY_PROTOCOL) problems.push(`协议必须为 ${WECHAT_PAY_PROTOCOL}`)

  let apiV2Key = ''
  if (!keyFile.ok) problems.push(keyFile.reason)
  else if (!API_V2_KEY_RE.test(keyFile.value)) problems.push('APIv2 密钥无效（须恰好 32 位数字+字母）')
  else apiV2Key = keyFile.value

  let certPem = ''
  let cert = null
  if (!certFile.ok) problems.push(certFile.reason)
  else {
    const certResult = validateCertificate(certFile.value)
    if (!certResult.ok) problems.push(certResult.reason)
    else {
      certPem = certFile.value
      cert = certResult.value
    }
  }

  let keyPem = ''
  let privateKey = null
  if (!privateKeyFile.ok) problems.push(privateKeyFile.reason)
  else {
    const keyResult = validatePrivateKey(privateKeyFile.value)
    if (!keyResult.ok) problems.push(keyResult.reason)
    else {
      keyPem = privateKeyFile.value
      privateKey = keyResult.value
    }
  }

  if (cert && privateKey && !certificatesMatch(cert, privateKey)) {
    problems.push('商户证书与私钥不匹配')
  }

  const configured = problems.length === 0
  return {
    enabled,
    protocol,
    configured,
    mchId,
    appId,
    terminalIp,
    enabledStores,
    apiV2Key,
    certPem,
    keyPem,
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
