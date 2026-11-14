/**
 * 线上目录媒体地址解析。
 *
 * 管理后端的档案里保存的是「小程序端可用的原始值」，有三种形态：
 *   1. cloud://...        —— 云存储 fileID，需要换取临时 https 链接才能被浏览器渲染；
 *   2. /images/xxx.jpg    —— 小程序包内路径，web 端会命中 SPA 回退 HTML，必须映射到镜像目录；
 *   3. data:image/... 或 https://... —— 本身可直接渲染。
 *
 * 本模块只负责「展示用」地址，绝不修改原始 media，避免把临时链接写回数据库/CloudBase。
 */

const PACKAGE_PREFIX = '/images/'
const MIRROR_PREFIX = '/mp-images/'
const TEMP_URL_TTL_MS = 90 * 60 * 1000
const BATCH_SIZE = 50
const CACHE_LIMIT = 800

const urlCache = new Map()
let clientPromise = null
let clientFactory = null

export function isCloudFileId(value) {
  return typeof value === 'string' && value.startsWith('cloud://')
}

/** /images/c1.jpg -> /mp-images/c1.jpg；仅接受单层文件名，拒绝路径穿越 */
export function packageImageMirror(value) {
  if (typeof value !== 'string' || !value.startsWith(PACKAGE_PREFIX)) return ''
  const name = value.slice(PACKAGE_PREFIX.length)
  if (!name || name.includes('/') || name.includes('..')) return ''
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return ''
  return `${MIRROR_PREFIX}${name}`
}

export function classifyMediaValue(value) {
  if (typeof value !== 'string' || !value) return 'empty'
  if (/^data:image\//i.test(value)) return 'inline'
  if (/^https?:\/\//i.test(value)) return 'remote'
  if (isCloudFileId(value)) return 'cloud'
  if (packageImageMirror(value)) return 'package'
  return 'other'
}

/** 单个值 -> 浏览器可渲染的地址；无法解析时返回空串（前端显示占位） */
export function displayValue(value, lookup = {}) {
  const kind = classifyMediaValue(value)
  if (kind === 'inline' || kind === 'remote') return value
  if (kind === 'package') return packageImageMirror(value)
  if (kind === 'cloud') return lookup[value] || ''
  return ''
}

export function buildDisplayMedia(media, lookup = {}) {
  const source = media && typeof media === 'object' ? media : {}
  const mapList = (value) => (Array.isArray(value) ? value : []).map((item) => displayValue(item, lookup))
  return {
    cover: displayValue(source.cover || '', lookup),
    gallery: mapList(source.gallery),
    detail: mapList(source.detail),
  }
}

export function __resetMediaResolverForTest(factory = null) {
  clientFactory = factory
  clientPromise = null
  urlCache.clear()
}

function cloudbaseConfigured() {
  return Boolean(process.env.TCB_ENV_ID && process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY)
}

async function getClient() {
  if (!cloudbaseConfigured() && !clientFactory) return null
  if (!clientPromise) {
    clientPromise = (async () => {
      if (clientFactory) return clientFactory()
      const mod = await import('@cloudbase/node-sdk')
      const CloudBase = mod.default || mod
      return CloudBase.init({
        env: process.env.TCB_ENV_ID,
        secretId: process.env.TCB_SECRET_ID,
        secretKey: process.env.TCB_SECRET_KEY,
      })
    })().catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

function trimCache() {
  while (urlCache.size > CACHE_LIMIT) {
    const oldest = urlCache.keys().next().value
    urlCache.delete(oldest)
  }
}

/** 供上传等场景复用同一个 CloudBase 客户端（未配置/初始化失败返回 null） */
export async function getCloudBaseClient() {
  try {
    return await getClient()
  } catch {
    return null
  }
}

/** 批量把 cloud:// 换成临时 https（上传后即时预览用） */
export async function resolveTempUrls(fileIds) {
  const list = (Array.isArray(fileIds) ? fileIds : [fileIds]).filter(isCloudFileId)
  if (!list.length) return {}
  return resolveCloudFileIds(list)
}

async function resolveCloudFileIds(fileIds) {
  const now = Date.now()
  const result = {}
  const pending = []
  for (const id of new Set(fileIds)) {
    const hit = urlCache.get(id)
    if (hit && hit.expiresAt > now) result[id] = hit.url
    else pending.push(id)
  }
  if (!pending.length) return result

  let client = null
  try {
    client = await getClient()
  } catch {
    // 凭据/网络异常时静默降级：列表照常返回，只是云图显示占位
    return result
  }
  if (!client) return result

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE)
    try {
      const response = await client.getTempFileURL({ fileList: chunk })
      for (const row of response?.fileList || []) {
        const fileId = row?.fileID || row?.fileid
        const url = row?.tempFileURL || row?.download_url
        if (row?.code === 'SUCCESS' && fileId && url) {
          result[fileId] = url
          urlCache.set(fileId, { url, expiresAt: now + TEMP_URL_TTL_MS })
        }
      }
    } catch {
      // 单批失败不影响其它批次
    }
  }
  trimCache()
  return result
}

/** 为序列化后的档案批量补 mediaDisplay 字段 */
export async function withDisplayMedia(profiles) {
  const list = Array.isArray(profiles) ? profiles : []
  if (!list.length) return list
  const fileIds = []
  for (const profile of list) {
    const media = profile?.media || {}
    for (const key of ['cover', 'gallery', 'detail']) {
      const value = media[key]
      for (const item of Array.isArray(value) ? value : [value]) {
        if (isCloudFileId(item)) fileIds.push(item)
      }
    }
  }
  const lookup = fileIds.length ? await resolveCloudFileIds(fileIds) : {}
  return list.map((profile) => ({ ...profile, mediaDisplay: buildDisplayMedia(profile?.media, lookup) }))
}

export async function withDisplayMediaOne(profile) {
  if (!profile) return profile
  const [row] = await withDisplayMedia([profile])
  return row
}
