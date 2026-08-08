/**
 * 货品品类服务端归一化规则。
 * 注意：物料清单必须与 src/utils/productCategories.js 保持一致（新增物料时两处同步修改）。
 */

export const MATERIAL_NAMES = [
  '物料-8颗礼盒（长）',
  '物料8颗礼盒（方）',
  '物料12颗礼盒',
  '物料24颗礼盒',
  '丝带-红',
  '丝带-蓝',
  '手提袋',
  '散糖袋',
  '冰袋',
  '巧克力豆礼盒',
  '巧克力豆礼盒手提袋',
  '保温袋',
  '酒精',
  '手套',
  '纸巾',
  '湿巾',
  '背贴',
  '胶带',
  '糖果口味卡',
  '生巧保存提示卡',
  '封口贴',
  '试吃签',
  '冰淇淋小勺',
  '冰淇淋碗-圆',
  '冰淇淋碗内-方',
  '小票打印纸',
]

export const ALLOWED_CATEGORIES = ['product', 'material', 'other']

export function isMaterialName(name) {
  const n = String(name || '').trim()
  return MATERIAL_NAMES.includes(n) || n.startsWith('物料')
}

/**
 * 归一化货品品类：固定物料按名称强制归为 material；
 * 其余情况保留传入的合法 category，非法/缺失时回退 product。
 */
export function normalizeItemCategory(name, fallback = 'product') {
  if (isMaterialName(name)) return 'material'
  return ALLOWED_CATEGORIES.includes(fallback) ? fallback : 'product'
}
