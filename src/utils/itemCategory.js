/**
 * 前端货品品类统一解析：展示、提交、导出都走这里，避免「物料被标成产品」。
 * 固定物料按名称强制归为 material；其余情况保留已有 category，缺失/非法回退 product。
 */
import { MATERIAL_NAMES } from './productCategories.js'

export const ALLOWED_CATEGORIES = ['product', 'material', 'other']

export function isMaterialName(name) {
  const n = String(name || '').trim()
  return MATERIAL_NAMES.includes(n) || n.startsWith('物料')
}

export function resolveItemCategory(name, category) {
  if (isMaterialName(name)) return 'material'
  return ALLOWED_CATEGORIES.includes(category) ? category : 'product'
}
