// Byte classification shared by upload/read boundaries and the browser. Unknown files are download-only.
const starts = (b, values) => values.every((value, i) => b[i] === value)
const ascii = (b, start, end) => String.fromCharCode(...b.subarray(start, end))
export function inspectAttachmentBytes(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (b.length >= 54 && ascii(b,0,2) === 'BM' && new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(2,true) === b.length) return { mimeType: 'image/bmp', previewKind: 'image' }
  if (b.length >= 16 && ascii(b, 0, 5) === '%PDF-' && /%%EOF\s*$/.test(ascii(b, Math.max(0, b.length - 1024), b.length))) return { mimeType: 'application/pdf', previewKind: 'pdf' }
  if (b.length >= 32 && starts(b, [137,80,78,71,13,10,26,10]) && ascii(b, 12, 16) === 'IHDR' && ascii(b, b.length - 8, b.length - 4) === 'IEND') return { mimeType: 'image/png', previewKind: 'image' }
  if (b.length >= 4 && starts(b, [255,216,255]) && b[b.length - 2] === 255 && b[b.length - 1] === 217) return { mimeType: 'image/jpeg', previewKind: 'image' }
  if (b.length >= 14 && ['GIF87a','GIF89a'].includes(ascii(b,0,6)) && b[b.length-1] === 59) return { mimeType: 'image/gif', previewKind: 'image' }
  if (b.length >= 16 && ascii(b,0,4) === 'RIFF' && ascii(b,8,12) === 'WEBP' && ['VP8 ','VP8L','VP8X'].includes(ascii(b,12,16))) return { mimeType: 'image/webp', previewKind: 'image' }
  return { mimeType: 'application/octet-stream', previewKind: 'download' }
}
export function canonicalAttachmentMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase()
  return ({pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp','image/jpg':'image/jpeg'})[mime] || mime
}
export function declaredPreviewMime(value) {
  return /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp))$/.test(canonicalAttachmentMime(value))
}
