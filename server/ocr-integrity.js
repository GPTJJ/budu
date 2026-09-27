import { createHash } from 'node:crypto'

function bad(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

export function fingerprintOcrImage(imageBase64) {
  const raw = String(imageBase64 || '')
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
}

export function correlateOcrRequest(body = {}) {
  const requestId = String(body.requestId || '').trim()
  const suppliedFingerprint = String(body.fileFingerprint || '').trim().toLowerCase()
  if (requestId && !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) throw bad('OCR 请求标识不正确')
  if (suppliedFingerprint && !/^[a-f0-9]{64}$/.test(suppliedFingerprint)) throw bad('图片指纹格式不正确')
  const fileFingerprint = fingerprintOcrImage(body.imageBase64)
  if (suppliedFingerprint && suppliedFingerprint !== fileFingerprint) throw bad('图片指纹校验失败，请重新选择图片')
  return { requestId, fileFingerprint }
}
