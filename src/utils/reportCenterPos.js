export const platformOrderOptions = Object.freeze([
  { source: 'MEITUAN', label: '美团外卖', settlementType: 'PLATFORM' },
  { source: 'TAOBAO_FLASH', label: '淘宝闪购', settlementType: 'PLATFORM' },
  { source: 'JD_INSTANT', label: '京东秒送', settlementType: 'PLATFORM' },
  { source: 'OTHER', label: '其他平台', settlementType: 'CUSTOM' },
])

const sourceLabels = Object.freeze({
  STORE_POS: '店内',
  MEITUAN: '美团外卖',
  TAOBAO_FLASH: '淘宝闪购',
  JD_INSTANT: '京东秒送',
  OTHER: '其他平台',
})

export function orderSourceLabel(source) {
  return sourceLabels[String(source || '').trim().toUpperCase()] || '店内'
}

export function isExternalOrder(order) {
  return order?.settlementAuthority === 'EXTERNAL'
}

export function settlementLabel(order) {
  if (isExternalOrder(order)) return '平台结算'
  return '店内收款'
}

export function entryModeLabel(entryMode) {
  return entryMode === 'MANUAL_POS' ? 'budu POS 人工记录' : 'budu POS'
}

/**
 * Parses a user-entered Yuan amount into an exact decimal-cent string.
 * No floating-point conversion is used, so the returned value is safe to
 * submit to the BigInt authority on the server.
 */
export function parseYuanToCents(value) {
  const normalized = String(value ?? '').trim()
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match) return null
  const yuan = BigInt(match[1])
  const fraction = String(match[2] || '').padEnd(2, '0')
  const cents = yuan * 100n + BigInt(fraction || '0')
  return cents > 0n && cents <= 99_999_999_999n ? cents.toString() : null
}

export function currentLocalDateTimeInputValue(now = new Date()) {
  const pad = (number) => String(number).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}
