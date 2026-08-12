/**
 * 档案馆文件存储适配层：
 * - 默认存 PostgreSQL（data_url），行为与现状完全一致；
 * - 配置 COS_BUCKET / COS_REGION / COS_SECRET_ID / COS_SECRET_KEY 后自动切换为腾讯云 COS 对象存储，
 *   数据库只保留 storage_key，下载时按需从 COS 取回。
 */
import COS from 'cos-nodejs-sdk-v5'

let cosClient = null

export function isCosEnabled() {
  return Boolean(
    process.env.COS_BUCKET &&
      process.env.COS_REGION &&
      process.env.COS_SECRET_ID &&
      process.env.COS_SECRET_KEY,
  )
}

function getCos() {
  if (!isCosEnabled()) return null
  if (!cosClient) {
    cosClient = new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY,
    })
  }
  return cosClient
}

function cosCall(method, params) {
  const client = getCos()
  if (!client) return Promise.reject(new Error('COS 未配置'))
  return new Promise((resolve, reject) => {
    client[method](params, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

/** 返回 { provider, storageKey, dataUrl }：COS 开启时 dataUrl 为空串，否则保持本地存储 */
export async function storeAssetData(dataUrl, key) {
  const client = getCos()
  if (!client) return { provider: 'local', storageKey: '', dataUrl }
  const base64 = String(dataUrl || '').split(',')[1] || ''
  if (!base64) return { provider: 'local', storageKey: '', dataUrl }
  const mime = String(dataUrl || '').match(/^data:([^;,]+);/)?.[1] || 'application/octet-stream'
  await cosCall('putObject', {
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION,
    Key: key,
    Body: Buffer.from(base64, 'base64'),
    ContentType: mime,
  })
  return { provider: 'cos', storageKey: key, dataUrl: '' }
}

/** COS 开启且该版本存于 COS 时取回 dataUrl；否则返回本地 dataUrl */
export async function readAssetData(storageProvider, storageKey, localDataUrl) {
  const client = getCos()
  if (storageProvider !== 'cos' || !storageKey || !client) return localDataUrl
  const data = await cosCall('getObject', {
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION,
    Key: storageKey,
  })
  const mime = (data && data.headers && data.headers['content-type']) || 'application/octet-stream'
  return `data:${mime};base64,${Buffer.from(data.Body).toString('base64')}`
}

export function assetObjectKey(fileId, version) {
  return `budu-assets/${fileId}/v${version}`
}
