import { meituanSign } from './sign.js'

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 归一化美团返回：统一为 { incCents, ord, refundCents, channels, dishes } */
export function normalizeMeituanResponse(json) {
  const d = json && json.data ? json.data : json || {}
  const inc = Number(d.realIncome ?? d.inc ?? d.turnover ?? d.amount ?? d.totalAmount) || 0
  const ord = Number(d.orderCount ?? d.ord ?? d.orders) || 0
  const refund = Number(d.refundAmount ?? d.refundCents ?? d.refund) || 0
  const channels = Array.isArray(d.channels)
    ? d.channels
    : []
  const dishes = Array.isArray(d.dishes) ? d.dishes : []
  return {
    incCents: Math.round(inc * 100),
    ord: Math.round(ord),
    refundCents: Math.round(refund * 100),
    channels,
    dishes,
  }
}

/** 真实模式：按日拉取美团门店汇总（字段映射以官方文档为准，实施时可在此调整） */
export async function fetchMeituanDay({ apiBase, appId, appSecret, orderApi, meituanStoreId, date }) {
  const params = {
    appId,
    storeId: meituanStoreId,
    date,
    timestamp: String(Date.now()),
  }
  params.sign = meituanSign(params, appSecret)
  const url = `${apiBase}${orderApi}?${new URLSearchParams(params)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`美团接口 HTTP ${res.status}`)
    const json = await res.json()
    return normalizeMeituanResponse(json)
  } finally {
    clearTimeout(timer)
  }
}

/** 模拟数据（仅用于联调/演示，不写库；通过 /meituan/sync-now 在未配置凭证时返回预览） */
export function mockMeituanDay(storeKey, date) {
  const seed =
    [...String(date)].reduce((s, c) => s + c.charCodeAt(0), 0) +
    [...String(storeKey)].reduce((s, c) => s + c.charCodeAt(0), 0)
  const inc = 3000 + (seed % 5000)
  const ord = 20 + (seed % 60)
  const dishes = [
    { name: '榛子生巧', sales: 4 + (seed % 10), amount: 138 },
    { name: '抹茶冰淇淋', sales: 3 + (seed % 8), amount: 32 },
    { name: '12颗礼盒', sales: 1 + (seed % 4), amount: 199 },
  ]
  return {
    incCents: inc * 100,
    ord,
    refundCents: (seed % 3) * 100,
    channels: [
      { name: '美团外卖', amountCents: Math.round(inc * 0.5) * 100 },
      { name: '店内销售', amountCents: Math.round(inc * 0.5) * 100 },
    ],
    dishes,
  }
}

export { uid }
