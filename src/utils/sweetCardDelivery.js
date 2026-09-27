import JSZip from 'jszip'

// Local export only: never persist proof, upload it, or create another credential.
export async function createDeliveryPackage(png, proof) {
  if (!proof) throw new Error('PROOF_UNAVAILABLE')
  const zip = new JSZip()
  zip.file('电子卡.png', await png.arrayBuffer())
  zip.file('领取凭证.txt', `独立领取凭证：\r\n${proof}\r\n\r\n管理员保存包，请妥善保管。向顾客交付时，请将图片与凭证分渠道发送。\r\n`)
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip' })
}

export function svgToPng(svgBase64) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(2, 4096 / Math.max(img.naturalWidth, img.naturalHeight))
        canvas.width = Math.round(img.naturalWidth * scale)
        canvas.height = Math.round(img.naturalHeight * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx || !canvas.width || !canvas.height) throw new Error('PNG_FAILED')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG_FAILED')), 'image/png')
      } catch { reject(new Error('PNG_FAILED')) }
    }
    img.onerror = () => reject(new Error('PNG_FAILED'))
    img.src = `data:image/svg+xml;base64,${svgBase64}`
  })
}

// File is prepared before the click; share() is invoked in that click's gesture.
export async function saveDeliveryFile(file) {
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    await navigator.share({ files: [file], title: file.name })
    return '已交给系统，请确认已保存到所选位置。'
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return '已请求下载；若未保存，请在 Safari 中打开后台后重试。'
}
