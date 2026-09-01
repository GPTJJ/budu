// 支付宝当面付（商家扫顾客付款码）配置。
// 私钥和支付宝公钥只允许从只读文件加载；未显式开启或配置不完整时 fail closed。
import fs from 'node:fs'
import crypto from 'node:crypto'

export const ALIPAY_PROTOCOL = 'openapi_v3_barcode'
const APP_ID_RE = /^\d{16}$/
const SELLER_ID_RE = /^\d{16}$/
const ALLOWED_ENDPOINTS = new Set([
  'https://openapi.alipay.com',
  'https://openapi-sandbox.dl.alipaydev.com',
])

function readKeyFile(envName, label, createKey) {
  const path = String(process.env[envName] || '').trim()
  if (!path) return { ok: false, reason: `${label}未配置（缺少 ${envName}）` }
  try {
    const stat = fs.statSync(path)
    if (!stat.isFile()) return { ok: false, reason: `${label}不是普通文件` }
    const value = fs.readFileSync(path, 'utf8').trim()
    if (!value) return { ok: false, reason: `${label}文件为空` }
    createKey(value)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, reason: `${label}文件不可读或格式无效：${error.code || error.message}` }
  }
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

export function alipayConfig() {
  const enabled = String(process.env.ALIPAY_ENABLED || '0').trim() === '1'
  const protocol = String(process.env.ALIPAY_PROTOCOL || ALIPAY_PROTOCOL).trim()
  const appId = String(process.env.ALIPAY_APP_ID || '').trim()
  const sellerId = String(process.env.ALIPAY_SELLER_ID || '').trim()
  const endpoint = String(process.env.ALIPAY_ENDPOINT || 'https://openapi.alipay.com').trim().replace(/\/$/, '')
  const notifyUrl = String(process.env.ALIPAY_NOTIFY_URL || '').trim()
  const enabledStores = String(process.env.ALIPAY_ENABLED_STORES || '').split(',').map((item) => item.trim()).filter(Boolean)
  const requestTimeoutMs = boundedInt(process.env.ALIPAY_REQUEST_TIMEOUT_MS, 10000, 1000, 30000)
  const privateKey = readKeyFile('ALIPAY_PRIVATE_KEY_FILE', '支付宝应用私钥', (value) => crypto.createPrivateKey(value))
  const publicKey = readKeyFile('ALIPAY_PUBLIC_KEY_FILE', '支付宝公钥', (value) => crypto.createPublicKey(value))
  const problems = []
  if (!APP_ID_RE.test(appId)) problems.push('AppID 格式无效（须 16 位数字）')
  if (!SELLER_ID_RE.test(sellerId)) problems.push('Seller ID 格式无效（须 16 位数字）')
  if (protocol !== ALIPAY_PROTOCOL) problems.push(`协议必须为 ${ALIPAY_PROTOCOL}`)
  if (!ALLOWED_ENDPOINTS.has(endpoint)) problems.push('支付宝 endpoint 不在正式/沙箱允许列表')
  if (!/^https:\/\//i.test(notifyUrl)) problems.push('异步通知地址必须为 HTTPS')
  if (!privateKey.ok) problems.push(privateKey.reason)
  if (!publicKey.ok) problems.push(publicKey.reason)
  if (/(^|[,\s])alipay-sdk($|[,\s])/i.test(String(process.env.NODE_DEBUG || ''))) problems.push('NODE_DEBUG 不得启用 alipay-sdk（会泄露支付请求字段）')
  const configured = problems.length === 0
  return {
    enabled, configured, protocol, appId, sellerId, endpoint, notifyUrl, enabledStores, requestTimeoutMs,
    privateKey: privateKey.ok ? privateKey.value : '',
    alipayPublicKey: publicKey.ok ? publicKey.value : '',
    reason: configured ? '' : problems.join('；'),
  }
}

export function alipayStatus() {
  const config = alipayConfig()
  return { configured: config.configured, enabled: config.enabled && config.configured, reason: config.configured ? '' : config.reason }
}

export function alipayStoreAllowed(storeId, config) {
  if (!config?.enabledStores?.length) return true
  return config.enabledStores.includes(String(storeId || ''))
}

export function alipayFrontendStatus(storeId, mode) {
  const status = alipayStatus()
  if (mode !== 'live' || !status.enabled) return { enabled: false }
  return { enabled: alipayStoreAllowed(storeId, alipayConfig()) }
}
