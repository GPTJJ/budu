export const REPORT_TABS = Object.freeze([
  { key: 'dashboard', label: '经营看板' },
  { key: 'summary', label: '综合营业' },
  { key: 'orders', label: '订单明细' },
  { key: 'products', label: '商品销售' },
])

export const ORDER_SOURCE_OPTIONS = Object.freeze([
  ['', '全部来源'],
  ['STORE_POS', '店内 POS'],
  ['MEITUAN', '美团外卖'],
  ['TAOBAO_FLASH', '淘宝闪购'],
  ['JD_INSTANT', '京东秒送'],
  ['OTHER', '其他平台'],
])

export const SETTLEMENT_OPTIONS = Object.freeze([
  ['', '全部结算'],
  ['WECHAT', '微信'],
  ['ALIPAY', '支付宝'],
  ['CASH', '现金'],
  ['SWEET_CARD', 'budu 甜意卡'],
  ['MIXED', '混合支付'],
  ['PLATFORM', '平台结算'],
  ['CUSTOM', '其他'],
])

const SOURCE_LABELS = Object.freeze(Object.fromEntries(ORDER_SOURCE_OPTIONS.filter(([key]) => key)))
const SETTLEMENT_LABELS = Object.freeze(Object.fromEntries(SETTLEMENT_OPTIONS.filter(([key]) => key)))
const STATUS_LABELS = Object.freeze({
  completed: '已结账',
  paid: '已结账',
  partially_refunded: '部分退款',
  refunded: '已退款',
  pending_payment: '未结账',
})

function isoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDate(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function reportDateRange(preset, custom = {}, now = new Date()) {
  const today = isoParts(now)
  if (preset === 'yesterday') {
    const day = shiftDate(today, -1)
    return { from: day, to: day }
  }
  if (preset === 'week') {
    const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay() || 7
    return { from: shiftDate(today, 1 - weekday), to: today }
  }
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today }
  if (preset === 'custom') return { from: custom.from || today, to: custom.to || today }
  return { from: today, to: today }
}

export function formatReportCents(value, { empty = '—', signed = false } = {}) {
  if (value === null || value === undefined || value === '') return empty
  const cents = BigInt(value)
  const negative = cents < 0n
  const absolute = negative ? -cents : cents
  const integer = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  const prefix = negative ? '-' : signed && cents > 0n ? '+' : ''
  return `${prefix}¥${integer}.${fraction}`
}

export function formatReportInteger(value, { suffix = '', empty = '—' } = {}) {
  if (value === null || value === undefined || value === '') return empty
  return `${BigInt(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${suffix}`
}

export function formatReportBps(value) {
  if (value === null || value === undefined || value === '') return '—'
  const bps = BigInt(value)
  const negative = bps < 0n
  const absolute = negative ? -bps : bps
  const integer = absolute / 100n
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${integer}.${fraction}%`
}

export function formatComparisonBps(value) {
  if (value === null || value === undefined || value === '') return '—'
  const bps = BigInt(value)
  return `${bps > 0n ? '+' : ''}${formatReportBps(bps)}`
}

export function shareWidth(value) {
  if (value === null || value === undefined || value === '') return 0
  const bps = BigInt(value)
  const bounded = bps < 0n ? 0n : bps > 10_000n ? 10_000n : bps
  return Number(bounded) / 100
}

export function orderSourceText(value) {
  return SOURCE_LABELS[String(value || '').toUpperCase()] || '店内 POS'
}

export function settlementText(value) {
  return SETTLEMENT_LABELS[String(value || '').toUpperCase()] || '—'
}

export function orderStatusText(value) {
  return STATUS_LABELS[String(value || '')] || value || '—'
}

export function localReportTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function coverageText(coverage) {
  if (coverage?.state === 'PARTIAL') return '部分覆盖'
  if (coverage?.state === 'UNAVAILABLE') return '暂无订单级数据'
  return ''
}
