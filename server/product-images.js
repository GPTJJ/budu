import crypto from 'node:crypto'
import sharp from 'sharp'

const THUMBNAIL_SIZE = 320
const MAX_CACHE_ENTRIES = 256
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const thumbnailCache = new Map()
const pendingThumbnails = new Map()
let thumbnailCacheBytes = 0

function imageError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

export function parseImageDataUrl(value) {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.*)$/i.exec(String(value || ''))
  if (!match) throw imageError('商品图片格式不正确')
  return {
    contentType: `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}`,
    buffer: Buffer.from(match[2], 'base64'),
  }
}

function rememberThumbnail(key, buffer) {
  if (thumbnailCache.has(key)) {
    thumbnailCacheBytes -= thumbnailCache.get(key).length
    thumbnailCache.delete(key)
  }
  thumbnailCache.set(key, buffer)
  thumbnailCacheBytes += buffer.length
  while (thumbnailCache.size > MAX_CACHE_ENTRIES || thumbnailCacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey === undefined) break
    thumbnailCacheBytes -= thumbnailCache.get(oldestKey).length
    thumbnailCache.delete(oldestKey)
  }
}

export async function createWebpThumbnail(dataUrl, cacheKey = '') {
  const key = String(cacheKey || '')
  if (key && thumbnailCache.has(key)) {
    const cached = thumbnailCache.get(key)
    thumbnailCache.delete(key)
    thumbnailCache.set(key, cached)
    return cached
  }
  if (key && pendingThumbnails.has(key)) return pendingThumbnails.get(key)

  const work = (async () => {
    const { buffer } = parseImageDataUrl(dataUrl)
    try {
      const thumbnail = await sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toBuffer()
      if (key) rememberThumbnail(key, thumbnail)
      return thumbnail
    } catch {
      throw imageError('商品图片无法生成缩略图')
    }
  })()

  if (key) pendingThumbnails.set(key, work)
  try {
    return await work
  } finally {
    if (key) pendingThumbnails.delete(key)
  }
}

export function imageVersion(updatedAt) {
  if (!updatedAt) return ''
  const value = updatedAt instanceof Date ? updatedAt : new Date(updatedAt)
  return Number.isNaN(value.getTime()) ? String(updatedAt) : value.toISOString()
}

function setImageCacheHeaders(req, res, version, identity, variant) {
  const requestedVersion = String(req.query?.v || '')
  const versioned = Boolean(version) && requestedVersion === version
  res.setHeader('Cache-Control', versioned
    ? 'private, max-age=31536000, immutable'
    : 'private, max-age=0, must-revalidate')
  res.setHeader('Vary', 'Cookie')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const etag = `"${crypto.createHash('sha256').update(`${identity}:${version}:${variant}`).digest('base64url')}"`
  res.setHeader('ETag', etag)
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end()
    return true
  }
  return false
}

export async function sendStoredImage(req, res, { dataUrl, updatedAt, identity, thumbnail = false }) {
  const version = imageVersion(updatedAt)
  const variant = thumbnail ? 'thumb-320-webp' : 'original'
  if (setImageCacheHeaders(req, res, version, identity, variant)) return
  if (thumbnail) {
    const buffer = await createWebpThumbnail(dataUrl, `${identity}:${version}:320`)
    res.setHeader('Content-Type', 'image/webp')
    res.send(buffer)
    return
  }
  const original = parseImageDataUrl(dataUrl)
  res.setHeader('Content-Type', original.contentType)
  res.send(original.buffer)
}

export function resetProductImageCacheForTests() {
  thumbnailCache.clear()
  pendingThumbnails.clear()
  thumbnailCacheBytes = 0
}
