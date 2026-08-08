/** 图片工具：加载与压缩转 JPG（解决 HEIC/大图/方向问题） */

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片读取失败'))
    img.src = src
  })
}

export async function normalizeImage(dataUrl, fileType, maxSide = 2000, quality = 0.86) {
  const plain = /^image\/(jpe?g|png|webp|bmp)$/i.test(fileType || '')
  if (plain && dataUrl.length < 1.5 * 1024 * 1024) return dataUrl
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', quality)
}
