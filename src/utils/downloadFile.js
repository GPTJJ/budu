import { inspectAttachmentBytes } from '../../shared/attachmentSafety.js'
// 文件下载工具：兼容 iOS Safari / PWA 的「找不到下载文件」问题
//
// 根因：iOS Safari 与 iOS PWA（standalone）不支持 <a download> 属性，
// 点击 dataURL / blob URL 链接时不会保存文件（直接打开或空白）。
//
// 方案：
// - iOS：dataURL → Blob → File，优先用 Web Share API Level 2（navigator.share
//   with files）弹出系统分享面板，用户可「存储到文件」；不可用时只打开服务端
//   强制下载地址，没有该地址时使用不可执行的下载并明确提示兼容限制。
// - 非 iOS（桌面/Android Chrome）：保持原生 <a download> 触发下载。

export function isIOS() {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ Safari 桌面 UA 伪装：触屏 Mac
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function dataUrlToBlob(dataUrl, signal) {
  return fetch(dataUrl, { signal }).then((r) => r.blob())
}

function triggerAnchorDownload(href, name) {
  const link = document.createElement('a')
  link.href = href
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  setTimeout(() => link.remove(), 1000)
}

/**
 * 下载文件。
 * @param {object} p
 * @param {string} p.dataUrl data:...;base64 数据
 * @param {string} p.name 文件名（含扩展名）
 * @param {string} [p.mimeType] 兼容既有调用方；实际 MIME 按字节判定
 * @param {string} [p.downloadUrl] 同源且强制 attachment 的文件内容地址
 * @param {AbortSignal} [p.signal] 附件关闭或切换时取消尚未开始的下载
 * @returns {Promise<{method: 'anchor'|'share'|'open'|'share-cancelled'}>}
 */
export async function downloadFile({ dataUrl, name, mimeType, downloadUrl, signal }) {
  const input = await dataUrlToBlob(dataUrl, signal)
  const bytes = new Uint8Array(await input.arrayBuffer())
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError')
  const safe = inspectAttachmentBytes(bytes)
  const blob = new Blob([bytes], { type: safe.mimeType })
  const safeUrl = downloadUrl && new URL(downloadUrl, location.origin)
  if (safeUrl) {
    const assetDownload = /^\/api\/v2\/asset-center\/files\/[^/]+\/download$/.test(safeUrl.pathname) && safeUrl.searchParams.get('asFile') === '1'
    const employeeDownload = /^\/api\/v2\/employees\/[^/]+\/documents\/[^/]+\/content$/.test(safeUrl.pathname)
    if (safeUrl.origin !== location.origin || !(assetDownload || employeeDownload)) throw new Error('下载地址不正确')
  }
  if (!isIOS()) {
    const url = safeUrl?.href || URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    triggerAnchorDownload(url, name)
    if (!safeUrl) setTimeout(() => URL.revokeObjectURL(url), 60000)
    return { method: 'anchor' }
  }

  // iOS：转 File 后走 Web Share API（用户可选「存储到文件」）
  const mime = safe.mimeType
  const file = new File([blob], name || 'file', { type: mime })
  const nav = navigator
  if (typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name || '文件' })
      return { method: 'share' }
    } catch (e) {
      // AbortError = 用户取消分享面板，不算失败
      if (e && e.name === 'AbortError') return { method: 'share-cancelled' }
      // 其他错误（如某些 WebView 分享失败）→ 回退受保护的下载
    }
  }

  // Only the server's attachment response may be opened. Never navigate to untrusted Blob content.
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError')
  if (safeUrl) {
    window.open(safeUrl.href, '_blank', 'noopener,noreferrer')
    return { method: 'open' }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  triggerAnchorDownload(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  throw new Error('此浏览器无法打开系统保存面板，请使用支持文件分享的浏览器下载')
}
