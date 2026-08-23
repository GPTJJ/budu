// 文件下载工具：兼容 iOS Safari / PWA 的「找不到下载文件」问题
//
// 根因：iOS Safari 与 iOS PWA（standalone）不支持 <a download> 属性，
// 点击 dataURL / blob URL 链接时不会保存文件（直接打开或空白）。
//
// 方案：
// - iOS：dataURL → Blob → File，优先用 Web Share API Level 2（navigator.share
//   with files）弹出系统分享面板，用户可「存储到文件」；不可用时回退在新窗口
//   打开 blob URL（可预览/长按保存）。
// - 非 iOS（桌面/Android Chrome）：保持原生 <a download> 触发下载。

export function isIOS() {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ Safari 桌面 UA 伪装：触屏 Mac
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob())
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
 * @param {string} [p.mimeType] 文件 MIME（iOS 分享需要；缺省从 dataUrl 解析）
 * @returns {Promise<{method: 'anchor'|'share'|'open'|'share-unsupported'}>}
 */
export async function downloadFile({ dataUrl, name, mimeType }) {
  if (!isIOS()) {
    triggerAnchorDownload(dataUrl, name)
    return { method: 'anchor' }
  }

  // iOS：转 File 后走 Web Share API（用户可选「存储到文件」）
  const mime = mimeType || (String(dataUrl).match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream'
  const blob = await dataUrlToBlob(dataUrl)
  const file = new File([blob], name || 'file', { type: mime })
  const nav = navigator
  if (typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name || '文件' })
      return { method: 'share' }
    } catch (e) {
      // AbortError = 用户取消分享面板，不算失败
      if (e && e.name === 'AbortError') return { method: 'share-cancelled' }
      // 其他错误（如某些 WebView 分享失败）→ 回退打开预览
    }
  }

  // 回退：新窗口打开 blob URL（iOS 可预览，部分格式可长按保存）
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  return { method: 'open' }
}
