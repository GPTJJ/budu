/** 美团餐饮开放平台配置 */

export function meituanConfig() {
  return {
    enabled: process.env.MEITUAN_ENABLED === '1',
    appId: process.env.MEITUAN_APP_ID || '',
    appSecret: process.env.MEITUAN_APP_SECRET || '',
    apiBase: process.env.MEITUAN_API_BASE || 'https://api-beijing.meituan.com',
    orderApi: process.env.MEITUAN_ORDER_API || '/api/v1/catering/order/daily',
    backfillDays: Math.max(0, Math.min(30, Number(process.env.MEITUAN_BACKFILL_DAYS) || 7)),
    pollMs: 5 * 60 * 1000,
  }
}

export function meituanReady(cfg = meituanConfig()) {
  return Boolean(cfg.enabled && cfg.appId && cfg.appSecret)
}
