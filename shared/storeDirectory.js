/**
 * budu 唯一门店目录。
 *
 * 门店不是运行时可扩展配置：前端选择器、API 校验和 PostgreSQL 查询都必须
 * 以这里的四个 key 为准，避免旧缓存、导入数据或错误请求重新创建幽灵门店。
 */
export const FIXED_STORES = Object.freeze([
  Object.freeze({ key: 'tongying', name: '北京通盈中心店', district: '朝阳区 · 三里屯' }),
  Object.freeze({ key: 'guanshe', name: '北京官舍店', district: '朝阳区 · 亮马桥' }),
  Object.freeze({ key: 'chaowai', name: '北京朝外店', district: '朝阳区 · 朝外' }),
  Object.freeze({ key: 'xidan', name: '北京西单店', district: '西城区 · 西单' }),
])

export const FIXED_STORE_KEYS = Object.freeze(FIXED_STORES.map((store) => store.key))

const FIXED_STORE_KEY_SET = new Set(FIXED_STORE_KEYS)

export function isFixedStoreKey(value) {
  return FIXED_STORE_KEY_SET.has(String(value || '').trim())
}

export function fixedStoreName(key, fallback = '') {
  const store = FIXED_STORES.find((row) => row.key === key)
  return store ? store.name : fallback
}
