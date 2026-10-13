import { inspectAttachmentBytes, canonicalAttachmentMime, declaredPreviewMime } from '../shared/attachmentSafety.js'

function invalid(message) { const error = new Error(message); error.status = 400; throw error }
export function decodeAttachmentDataUrl(value, maxBytes = 9 * 1024 * 1024) {
  const match = /^data:([^;,]{2,80});base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(value || ''))
  if (!match || !match[2] || match[2].length % 4 === 1) invalid('文件数据格式不正确')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) invalid('附件内容为空、格式不正确或超过大小限制')
  return { bytes, declaredMime: canonicalAttachmentMime(match[1]) }
}
export function safeAttachment(bytes) {
  const safe = inspectAttachmentBytes(bytes)
  return { ...safe, bytes, dataUrl: `data:${safe.mimeType};base64,${bytes.toString('base64')}`, fileSize: bytes.length }
}
export function validateAttachmentUpload(dataUrl, declaredMime, maxBytes) {
  const decoded = decodeAttachmentDataUrl(dataUrl, maxBytes)
  const safe = safeAttachment(decoded.bytes)
  for (const declared of [decoded.declaredMime, canonicalAttachmentMime(declaredMime)]) {
    if (declaredPreviewMime(declared) && declared !== safe.mimeType) invalid('附件内容与声明的文件类型不一致，请重新选择文件')
  }
  return safe
}
export function setAttachmentDownloadHeaders(res, safe, name) {
  res.setHeader('Content-Type', safe.mimeType)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(name || 'file').replace(/[\r\n]/g, '').slice(0, 120))}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'")
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-Attachment-Preview', safe.previewKind)
}
