/**
 * 原四家门店的初始化种子及历史名称回退。
 * PostgreSQL Store 是运行时门店目录权威；仅门店管理接口可以新增。
 * 语法校验不代表门店已存在，业务端还必须查询 PostgreSQL。
 */
export const FIXED_STORES = Object.freeze([
  Object.freeze({ key: 'tongying', name: '北京通盈中心店', district: '朝阳区 · 三里屯' }),
  Object.freeze({ key: 'guanshe', name: '北京官舍店', district: '朝阳区 · 亮马桥' }),
  Object.freeze({ key: 'chaowai', name: '北京朝外店', district: '朝阳区 · 朝外' }),
  Object.freeze({ key: 'xidan', name: '北京西单店', district: '西城区 · 西单' }),
])

export const FIXED_STORE_KEYS = Object.freeze(FIXED_STORES.map((store) => store.key))

const FIXED_STORE_KEY_SET = new Set(FIXED_STORE_KEYS)

export const RESERVED_STORE_KEYS = Object.freeze(['all', 'multi'])
const RESERVED_STORE_KEY_SET = new Set(RESERVED_STORE_KEYS)

/** Store keys fit the existing 30-character business references. */
export function isStoreKey(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,29}$/.test(value)
    && !RESERVED_STORE_KEY_SET.has(value)
}

export function isFixedStoreKey(value) {
  return FIXED_STORE_KEY_SET.has(String(value || '').trim())
}

export function fixedStoreName(key, fallback = '') {
  const store = FIXED_STORES.find((row) => row.key === key)
  return store ? store.name : fallback
}
