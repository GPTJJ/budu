/** 内置门店的中文名称（与前端静态报表 STORES 保持一致） */
export const STATIC_STORE_NAMES = {
  tongying: '北京通盈中心店',
  xidan: '北京西单店',
  chaowai: '北京朝外店',
  guanshe: '北京官舍店',
  multi: '多店支援',
}

export function resolveStoreName(key, fallback = '') {
  if (!key) return fallback
  return STATIC_STORE_NAMES[key] || fallback || key
}
