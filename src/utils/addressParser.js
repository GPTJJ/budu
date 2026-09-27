// 门店邮寄收件信息的唯一解析入口。
// 粘贴、OCR 与语音识别只负责提供原始文本，字段判断统一在这里完成。

const PHONE_LABEL_RE = /(?:联系电话|联系方式|手机号|电话|手机|号码|tel)[:：]?\s*/gi
const NAME_LABEL_RE = /(?:收件人|收货人|联系人|姓名|名字|称呼)[:：]?\s*/gi
const ADDRESS_LABEL_RE = /(?:收货地址|收件地址|邮寄地址|送货地址|地址|位置)[:：]?\s*/gi
const NOTE_LABEL_RE = /(?:商品信息|商品|备注|附言|说明)[:：]?\s*/gi
const ANY_LABEL_RE = /(^|[\n，,；;])\s*(?:收件人|收货人|联系人|姓名|名字|称呼|联系电话|联系方式|手机号|电话|手机|号码|tel|收货地址|收件地址|邮寄地址|送货地址|地址|位置|商品信息|商品|备注|附言|说明)[:：]?\s*/gim

const ADDRESS_HINT_RE = /(?:省|自治区|特别行政区|市|区|县|自治州|盟|街道|镇|乡|村|路|街|巷|小区|社区|大厦|广场|花园|城|园|号楼|楼|栋|单元|室|号|弄)/
const STRONG_ADDRESS_RE = /(?:省|自治区|特别行政区|市|区|县|街道|镇|乡|小区|社区|号楼|栋|单元|室|号)/g
const NAME_REJECT_RE = /(?:省|市|区|县|镇|乡|村|街|路|道|巷|小区|社区|大厦|广场|花园|单元|地址|电话|手机|备注|商品|生巧|麻薯|赠|蛋糕|巧克力|快递|顺丰)/
const HONORIFIC_RE = /(?:先生|女士|小姐|师傅|同学|老师|哥|姐)$/
const MOBILE_CANDIDATE_RE = /(^|[^\d])((?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8})(?!\d)/g
const LANDLINE_CANDIDATE_RE = /(^|[^\d])((?:\(0\d{2,3}\)|0\d{2,3})[\s-]?\d{7,8})(?!\d)/g

export function normalizeRecipientText(text) {
  return String(text || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  return digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits
}

function phoneCandidates(text) {
  const candidates = []
  for (const pattern of [MOBILE_CANDIDATE_RE, LANDLINE_CANDIDATE_RE]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text))) {
      const raw = match[2]
      const index = match.index + match[1].length
      const phone = normalizePhone(raw)
      const context = text.slice(Math.max(0, index - 12), index).toLowerCase()
      const lineStart = text.lastIndexOf('\n', index - 1) + 1
      const lineEndAt = text.indexOf('\n', index)
      const lineEnd = lineEndAt < 0 ? text.length : lineEndAt
      const line = text.slice(lineStart, lineEnd).replace(PHONE_LABEL_RE, '').trim()
      let score = phone.startsWith('1') && phone.length === 11 ? 20 : 8
      if (/(?:电话|手机|手机号|联系电话|联系方式|号码|tel)[:：]?\s*$/i.test(context)) score += 30
      if (normalizePhone(line) === phone) score += 10
      candidates.push({ raw, phone, index, score })
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.index - b.index)
}

function cleanName(value) {
  return String(value || '').replace(HONORIFIC_RE, '').trim()
}

function isPlausibleName(value) {
  const name = cleanName(value)
  return /^[\u3400-\u9fff·]{2,6}$/.test(name) && !NAME_REJECT_RE.test(name)
}

function addressScore(value) {
  const text = String(value || '').trim()
  if (text.length < 5 || !ADDRESS_HINT_RE.test(text)) return -1
  const strong = text.match(STRONG_ADDRESS_RE)?.length || 0
  let score = strong * 10 + Math.min(text.length, 60)
  if (/(?:省|自治区|特别行政区)/.test(text)) score += 20
  if (/(?:市|区|县)/.test(text)) score += 12
  if (/(?:号楼|栋|单元|室|号|小区|社区)/.test(text)) score += 15
  return score
}

function addressStart(value) {
  const patterns = [
    /[\u3400-\u9fff]{2,10}(?:省|自治区|特别行政区)/,
    /[\u3400-\u9fff]{2,10}市/,
    /[\u3400-\u9fff]{2,12}(?:区|县|街道|镇|乡|小区|社区)/,
  ]
  const indexes = patterns.map((pattern) => value.search(pattern)).filter((index) => index >= 0)
  if (indexes.length) return Math.min(...indexes)
  const hint = value.search(ADDRESS_HINT_RE)
  if (hint < 0) return -1
  const preceding = value.slice(0, hint)
  const boundary = Math.max(preceding.lastIndexOf(' '), preceding.lastIndexOf('，'), preceding.lastIndexOf(','))
  return boundary + 1
}

function trimAddress(value) {
  let address = String(value || '').replace(ADDRESS_LABEL_RE, '').trim()
  const labelIndex = address.search(/(?:收件人|收货人|联系人|姓名|名字|称呼|电话|手机|手机号|联系电话|联系方式|备注|商品信息|附言)[:：]?/)
  if (labelIndex > 0) address = address.slice(0, labelIndex)
  const phone = phoneCandidates(address)[0]
  if (phone && phone.index > 0) address = address.slice(0, phone.index)
  return address
    .replace(/\s+[\u3400-\u9fff·]{2,6}(?:先生|女士|小姐|师傅|同学|老师|哥|姐)?\s*$/, '')
    .replace(/[。.，,、;；\s]+$/, '')
    .trim()
}

function extractAddress(text, selectedPhone) {
  const labeled = text.match(/(?:收货地址|收件地址|邮寄地址|送货地址|地址|位置)[:：]?\s*([^\n；;]+)/i)
  if (labeled?.[1]) {
    const candidate = trimAddress(labeled[1])
    if (addressScore(candidate) >= 0) return candidate
  }

  const lines = text.split(/\n+|[；;]+/).map((line) => line.trim()).filter(Boolean)
  const candidates = []
  for (const line of lines) {
    let source = line
    if (selectedPhone?.raw) source = source.replace(selectedPhone.raw, ' ')
    const start = addressStart(source)
    if (start < 0) continue
    let candidate = source.slice(start)
    const commaIndex = candidate.search(/[，,]/)
    if (commaIndex > 0) candidate = candidate.slice(0, commaIndex)
    candidate = trimAddress(candidate)
    const score = addressScore(candidate)
    if (score >= 0) candidates.push({ candidate, score })
  }
  candidates.sort((a, b) => b.score - a.score || b.candidate.length - a.candidate.length)
  return candidates[0]?.candidate || ''
}

function extractName(text, selectedPhone, address) {
  const labeled = text.match(
    /(?:收件人|收货人|联系人|姓名|名字|称呼)[:：]?\s*([\u3400-\u9fff·]{2,6}?)(?:先生|女士|小姐|师傅|同学|老师|哥|姐)?(?=\s*(?:联系电话|联系方式|手机号|电话|手机|号码|地址|收货地址|收件地址|邮寄地址|送货地址|\d|\n|$))/i,
  )?.[1] || ''
  if (isPlausibleName(labeled)) return cleanName(labeled)
  if (!selectedPhone && !address) return ''

  const lines = text.split(/\n+|[，,；;、]+/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    let candidate = line
      .replace(NAME_LABEL_RE, '')
      .replace(PHONE_LABEL_RE, '')
      .replace(ADDRESS_LABEL_RE, '')
      .replace(NOTE_LABEL_RE, '')
    if (selectedPhone?.raw) candidate = candidate.replace(selectedPhone.raw, ' ')
    if (address) candidate = candidate.replace(address, ' ')
    candidate = candidate.replace(/[：:\s]+/g, ' ').trim()
    if (isPlausibleName(candidate)) return cleanName(candidate)
    for (const token of candidate.split(' ')) {
      if (isPlausibleName(token)) return cleanName(token)
    }
  }
  return ''
}

function cleanResidual(text, selectedPhone, recipientName, address) {
  let residual = text
  if (address) residual = residual.replace(address, ' ')
  if (selectedPhone?.raw) residual = residual.replace(selectedPhone.raw, ' ')
  if (recipientName) residual = residual.replace(recipientName, ' ')
  return residual
    .replace(ANY_LABEL_RE, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^[\s，,、；;。.]+|[\s，,、；;。.]+$/g, '')
    .trim()
}

function looksLikeBusinessNote(value) {
  if (!value) return false
  if (/\d{7,}/.test(value)) return true
  if (/[，,、；;]/.test(value)) return true
  if (/(?:备注|商品|赠|送|盒|件|份|包|袋|个|瓶|生巧|麻薯|蛋糕|巧克力|到店|配送|下午|上午|晚上|时间)/.test(value)) return true
  return value.length > 6
}

/**
 * @returns {{recipientName: string, phone: string, address: string, note: string,
 *   confidence: {recipientName: string, phone: string, address: string, note: string},
 *   unparsedText: string, matched: boolean}}
 */
export function parseRecipientText(text) {
  const normalized = normalizeRecipientText(text)
  if (!normalized) {
    return {
      recipientName: '', phone: '', address: '', note: '',
      confidence: { recipientName: 'none', phone: 'none', address: 'none', note: 'none' },
      unparsedText: '', matched: false,
    }
  }

  const phones = phoneCandidates(normalized)
  const selectedPhone = phones[0] || null
  const phone = selectedPhone?.phone || ''
  const address = extractAddress(normalized, selectedPhone)
  const recipientName = extractName(normalized, selectedPhone, address)
  const residual = cleanResidual(normalized, selectedPhone, recipientName, address)
  const explicitNote = /(?:^|[\n；;])\s*(?:商品信息|商品|备注|附言|说明)[:：]?\s*([^\n]+)/i.exec(normalized)?.[1]?.trim() || ''
  const noteCandidate = explicitNote || residual
  const note = looksLikeBusinessNote(noteCandidate) ? noteCandidate : ''
  const unparsedText = note ? '' : residual
  const matched = Boolean(recipientName || phone || address || note)

  return {
    recipientName,
    phone,
    address,
    note,
    confidence: {
      recipientName: recipientName ? 'high' : 'none',
      phone: phone ? 'high' : 'none',
      address: address ? 'high' : 'none',
      note: note ? (explicitNote ? 'high' : 'medium') : 'none',
    },
    unparsedText,
    matched,
  }
}

export function mergeRecipientFields(existing, parsed) {
  return {
    recipientName: String(existing?.recipientName || '').trim() || parsed.recipientName || '',
    phone: String(existing?.phone || '').trim() || parsed.phone || '',
    address: String(existing?.address || '').trim() || parsed.address || '',
    note: String(existing?.note || '').trim() || parsed.note || '',
  }
}
