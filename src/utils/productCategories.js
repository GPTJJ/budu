/** 产品二级分类：用于门店调拨/采购申请中按品类挑选产品 */

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

export const GIFT_BOX_NAMES = ['8颗礼盒（长）', '8颗礼盒（方）', '12颗礼盒', '24颗礼盒']

export const CHOCOLAT_NAMES = ['92%生巧', '榛子生巧', '柚子生巧', '茉莉花茶生巧', '抹茶生巧']

export const ICE_CREAM_NAMES = [
  '黑巧冰淇淋',
  '草莓冰淇淋',
  '香草冰淇淋',
  '柚子冰淇淋',
  '茉莉花茶冰淇淋',
  '泰奶冰淇淋',
  '芒果冰淇淋',
  '海盐焦糖冰淇淋',
  '朗姆葡萄冰淇淋',
]

export const CHOCO_BEAN_NAMES = ['原粒杏仁', '爆酸豆', '泰奶麻薯', '百香果', '青苹果益生菌', '山核桃']

export const TASTING_NAMES = ['92%试吃', '榛子试吃', '柚子试吃', '茉莉花茶试吃', '抹茶试吃']

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

export const FIXED_BY_CATEGORY = {
  散糖: NO_CANDY_NAMES,
  礼盒: GIFT_BOX_NAMES,
  生巧: CHOCOLAT_NAMES,
  冰淇淋: ICE_CREAM_NAMES,
  巧克力豆: CHOCO_BEAN_NAMES,
  试吃: TASTING_NAMES,
  其他: [],
}

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
