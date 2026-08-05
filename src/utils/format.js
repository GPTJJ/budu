/** 金额格式化：1286540 -> "1,286,540" */
export function formatNumber(value) {
  return value.toLocaleString('zh-CN')
}

/** 金额简写：1286540 -> "128.65"（万） */
export function formatWan(value) {
  return (value / 10000).toFixed(2)
}

/** 环比增减样式：正数为绿色上升，负数为红色下降 */
export function changeStyle(change) {
  const up = String(change).startsWith('+') || Number(change) > 0
  return up
    ? 'bg-emerald-50 text-emerald-600'
    : 'bg-rose-50 text-rose-500'
}

/** 排名徽章样式 */
export function rankStyle(index) {
  if (index === 0) return 'bg-gradient-to-br from-amber-400 to-orange-500'
  if (index === 1) return 'bg-gradient-to-br from-slate-300 to-slate-400'
  if (index === 2) return 'bg-gradient-to-br from-orange-300 to-amber-600'
  return 'bg-slate-100 text-slate-400'
}

/** 金额格式化：千分位 + 保留两位小数 */
export function formatMoney(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}