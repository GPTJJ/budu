/**
 * 新订单成交通知的纯呈现逻辑。
 *
 * 刻意零依赖（不 import prisma / 数据库 / 通知通道），这样「通知里到底会出现
 * 哪些信息」这条安全断言可以在任何环境下直接跑回归，而不需要数据库连接。
 *
 * 内容刻意不含收件人手机号、收件地址、openid 等不必要的信息：商家只需要知道
 * 「哪家店、哪个渠道、哪一单、买了什么、多少钱、怎么交付、什么时候下的」。
 */
const SUMMARY_LIMIT = 3

const CHANNEL_LABELS = { 'cloudbase-miniprogram': '小程序' }

export function formatBeijingNotificationTime(value) {
  // A missing time must render as nothing. `new Date(null)` is the epoch, which
  // would otherwise surface as a confident, wrong "1970/01/01 08:00".
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function toCentsText(value) {
  const digits = String(value ?? '0').replace(/[^0-9]/g, '') || '0'
  const padded = digits.padStart(3, '0')
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`
}

export function buildOrderPaidNotice({ settlement, snapshot = {}, storeName = '' }) {
  const lines = Array.isArray(snapshot.lines) ? snapshot.lines : []
  const summary = lines
    .slice(0, SUMMARY_LIMIT)
    .map(line => `${String(line.name || '').trim().slice(0, 40)}×${Math.max(1, Number(line.quantity) || 1)}`)
    .join('、')
  const amount = toCentsText(settlement.totalCents)
  const fulfillment = snapshot.fulfillment === 'PICKUP' ? '门店自提' : '快递配送'
  const channel = CHANNEL_LABELS[settlement.namespace] || '线上'
  const store = String(storeName || '').trim() || '未知门店'
  const orderNo = String(settlement.externalOrderId || settlement.id)
  return {
    orderNo,
    title: `【BUDU 新成交订单】¥${amount}`,
    content: [
      `${channel} · ${store} · ${fulfillment}`,
      `订单号：${orderNo}`,
      `商品：${summary || '（商品明细待同步）'}${lines.length > SUMMARY_LIMIT ? ` 等 ${lines.length} 件` : ''}`,
      `金额：¥${amount}`,
      `下单时间：${formatBeijingNotificationTime(settlement.createdAt)}`,
    ].join('\n'),
  }
}
