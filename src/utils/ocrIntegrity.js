function bytesFromBase64(base64) {
  const binary = globalThis.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境无法安全校验图片，请更换浏览器后重试')
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function fingerprintImageDataUrl(dataUrl) {
  const source = String(dataUrl || '')
  const separator = source.indexOf(',')
  if (separator < 0 || !source.slice(0, separator).includes(';base64')) {
    throw new Error('图片数据格式不正确')
  }
  return sha256Hex(bytesFromBase64(source.slice(separator + 1)))
}

export function createOcrRequestId(generation, fingerprint) {
  const random = globalThis.crypto?.randomUUID?.()
    || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `ocr-${generation}-${fingerprint.slice(0, 12)}-${random}`
}

export function isMatchingOcrResponse(current, expected, response) {
  return Boolean(
    current
    && current.generation === expected.generation
    && current.fileFingerprint === expected.fileFingerprint
    && current.requestId === expected.requestId
    && response?.fileFingerprint === expected.fileFingerprint
    && response?.requestId === expected.requestId,
  )
}
