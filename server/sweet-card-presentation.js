const escapeXml = (value) => String(value || '').replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char])

/** Replaceable renderer hook. Business services pass only the published presentation contract. */
export function renderMinimalSweetCard({ publicCardNo, faceValueText, expiryCopy, recipient, qrDataUrl }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff8fb"/><stop offset="1" stop-color="#f7d7e5"/></linearGradient></defs>
  <rect width="1200" height="760" rx="64" fill="url(#bg)"/><circle cx="1060" cy="100" r="220" fill="#be4679" opacity=".08"/>
  <text x="80" y="110" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#ad3769">budu 甜意卡</text>
  <text x="80" y="158" font-family="Arial,sans-serif" font-size="20" letter-spacing="5" fill="#ad3769">A LITTLE SWEETNESS.</text>
  <text x="80" y="330" font-family="Arial,sans-serif" font-size="82" font-weight="800" fill="#1e293b">${escapeXml(faceValueText)}</text>
  <text x="80" y="405" font-family="Arial,sans-serif" font-size="24" fill="#64748b">${escapeXml(recipient)}</text>
  <text x="80" y="630" font-family="monospace" font-size="22" fill="#64748b">${escapeXml(publicCardNo)}</text>
  <text x="80" y="676" font-family="Arial,sans-serif" font-size="20" fill="#94a3b8">${escapeXml(expiryCopy)}</text>
  <rect x="820" y="250" width="290" height="290" rx="28" fill="#fff"/><image href="${escapeXml(qrDataUrl)}" x="835" y="265" width="260" height="260"/>
  </svg>`
}
