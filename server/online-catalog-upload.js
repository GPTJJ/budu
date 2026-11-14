/**
 * 线上目录图片上传。
 *
 * 历史实现是「浏览器压缩成 base64 data URL 直接存库」——单张最大 600KB，
 * 一个商品堆 20 张详情图就会把 Postgres 行和 CloudBase 文档推向上限。
 * 现在改为：服务端解码 base64 → 校验 → 上传云存储 → 只把 cloud:// 文件 ID
 * 存进 media（与既有 56 张官方详情图同一套契约，小程序端无需改动）。
 */
import crypto from 'node:crypto'
import { httpError } from './pos-core.js'
import { getCloudBaseClient } from './online-catalog-media.js'

const ALLOWED_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

export const MAX_UPLOAD_BYTES = 1_500_000

const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i

/** 用文件头确认真实类型，防止把 HTML/SVG 之类伪装成图片塞进云存储 */
function sniffExt(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return ''
}

export function parseImageDataUrl(value, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw httpError('缺少图片内容', 400)
  const match = DATA_URL_RE.exec(value.trim())
  if (!match) throw httpError('图片格式不支持，请重新选择', 400)
  const mime = match[1].toLowerCase()
  if (!ALLOWED_TYPES.has(mime)) throw httpError('只支持 JPG / PNG / WebP 图片', 400)
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length) throw httpError('图片内容为空', 400)
  if (buffer.length > maxBytes) {
    throw httpError(`图片过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），请压缩后重试`, 413)
  }
  const ext = sniffExt(buffer)
  if (!ext) throw httpError('文件内容不是有效图片', 400)
  return { mime, ext, buffer }
}

export function buildCloudPath(ext, now = new Date()) {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `online-catalog/media/${year}${month}/${crypto.randomUUID()}.${ext}`
}

export async function uploadCatalogImage(dataUrl, { client = null, now = new Date() } = {}) {
  const { buffer, ext } = parseImageDataUrl(dataUrl)
  const cloudPath = buildCloudPath(ext, now)

  const cloudbase = client || await getCloudBaseClient()
  if (!cloudbase) throw httpError('云存储未配置，暂时无法上传图片', 503)

  let response
  try {
    response = await cloudbase.uploadFile({ cloudPath, fileContent: buffer })
  } catch {
    throw httpError('图片上传失败，请稍后重试', 502)
  }
  const fileId = response?.fileID || response?.fileId || ''
  if (!fileId) throw httpError('云存储未返回文件标识', 502)
  return { fileId, cloudPath, size: buffer.length, ext }
}
