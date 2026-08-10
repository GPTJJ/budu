/** 内置门店的中文名称（与前端静态报表 STORES 保持一致） */
export const STATIC_STORE_NAMES = {
  tongying: '通盈中心店',
  xidan: '西单店',
  chaowai: '北京朝外店',
  guanshe: '官舍店',
}

export function resolveStoreName(key, fallback = '') {
  if (!key) return fallback
  return STATIC_STORE_NAMES[key] || fallback || key
}
