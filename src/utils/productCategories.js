/** 产品二级分类：用于调货/采购申请中按品类挑选产品 */

export const PRODUCT_CATEGORIES = ['散糖', '礼盒', '生巧', '冰淇淋', '巧克力豆', '试吃', '其他']

/** 散糖分类下固定提供的 12 个编号口味 */
export const NO_CANDY_NAMES = [
  'NO.1树莓',
  'NO.2柠檬',
  'NO.3百香果',
  'NO.4橙子',
  'NO.5英式伯爵茶',
  'NO.6泰式奶茶',
  'NO.7抹茶',
  'NO.8榛子',
  'NO.9海盐焦糖',
  'NO.10香草',
  'NO.11生椰拿铁',
  'NO.12巧克力',
]

const RULES = [
  [/口味|冰淇淋|雪糕|甜筒|冰激凌/, '冰淇淋'],
  [/^NO\.\d/, '散糖'],
  [/试吃|赠品|品尝/, '试吃'],
  [/生巧|生巧克力/, '生巧'],
  [/礼盒|盒装|套装|伴手礼|礼袋/, '礼盒'],
  [/巧克力豆|爆酸豆/, '巧克力豆'],
  [/糖|太妃|棉花糖|软糖|硬糖/, '散糖'],
]

/** 按商品名称自动归类；无法识别时归入「其他」 */
export function classifyProduct(name) {
  for (const [re, cat] of RULES) {
    if (re.test(String(name || ''))) return cat
  }
  return '其他'
}
