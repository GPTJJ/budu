import { STORE_PAY_CONFIG, isHoliday, normalizeStoreKey } from './payroll.js'
import { getWeekDays } from './schedule.js'

const CURRENCY_AMOUNT_RE = /(?:[+-]\s*)?(?:[¥￥]|(?:RMB|CNY)\s*)\s*\d[\d,]*(?:\.\d+)?(?:\s*万?元)?/gi
const YUAN_AMOUNT_RE = /(?:[+-]\s*)?(?<!\d)\d[\d,]*(?:\.\d+)?\s*万?元/g

/**
 * 对动态标题和正文中的金额文本（如 `1195.59 元`、`¥1,280.00`）进行自动脱敏。
 * 防窥态下统一渲染为 `•••• 元`，保留日期、时间、单量、件数等非金额数字。
 */
export function maskSensitiveAmounts(text, masked = true) {
  const source = String(text ?? '')
  if (!masked || !source) return source
  return source
    .replace(CURRENCY_AMOUNT_RE, '•••• 元')
    .replace(YUAN_AMOUNT_RE, '•••• 元')
}

/**
 * 单店单日基础业绩目标（元/日）。
 * 仅对 STORE_PAY_CONFIG 已明确配置的门店返回目标值；未知或未配置目标的门店返回 null，
 * 不套用默认保底值，以便前端优雅降级为「未设目标」。
 */
export function singleStoreDailyTarget(storeKey, dateStr, storeName = '') {
  const normKey = normalizeStoreKey(storeKey, storeName)
  const cfg = Object.prototype.hasOwnProperty.call(STORE_PAY_CONFIG, normKey)
    ? STORE_PAY_CONFIG[normKey]
    : null
  if (!cfg) return null
  const holiday = normKey === 'tongying' && isHoliday(dateStr)
  const rawTarget = holiday && cfg.holidayTarget ? cfg.holidayTarget : cfg.target
  const target = Number(rawTarget)
  return Number.isFinite(target) && target > 0 ? target : null
}

function monthDateList(monthKey) {
  const [year, month] = String(monthKey || '').split('-').map(Number)
  if (!year || !month) return []
  const totalDays = new Date(year, month, 0).getDate()
  const list = []
  for (let d = 1; d <= totalDays; d += 1) {
    list.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  return list
}

function normalizedFullDate(monthKey, day) {
  const d = String(day || '')
  const dd = d.includes('-') ? d.slice(-2) : d.padStart(2, '0')
  return `${monthKey}-${dd}`
}

/**
 * 计算指定门店集合在当前筛选周期（单日 / 自然周 / 整月）的目标总额（元）。
 * 若门店集合为空或均未配置有效目标，返回 null。
 */
export function periodTargetTotal(storeKeys, monthKey, day = null, weekStart = null) {
  const keys = Array.isArray(storeKeys) ? storeKeys : []
  if (keys.length === 0) return null
  const dates = weekStart
    ? getWeekDays(weekStart).map((item) => item.date)
    : day
      ? [normalizedFullDate(monthKey, day)]
      : monthDateList(monthKey)
  if (dates.length === 0) return null

  let total = 0
  let configuredCount = 0
  for (const dateStr of dates) {
    for (const storeKey of keys) {
      const dailyTarget = singleStoreDailyTarget(storeKey, dateStr)
      if (dailyTarget != null) {
        total += dailyTarget
        configuredCount += 1
      }
    }
  }
  return configuredCount > 0 && Number.isFinite(total) && total > 0 ? total : null
}

/**
 * 计算无金额刻度的目标达成率百分比（非负整数）。
 * 当未配置目标（targetTotal <= 0 或非有限数）时返回 null，绝不返回 NaN / Infinity。
 */
export function calcTargetProgressPct(actualIncome, targetTotal) {
  if (targetTotal == null) return null
  const target = Number(targetTotal)
  if (!Number.isFinite(target) || target <= 0) return null
  const income = Number(actualIncome)
  if (!Number.isFinite(income) || income <= 0) return 0
  const pct = Math.round((income / target) * 100)
  return Number.isFinite(pct) ? Math.max(0, pct) : null
}
