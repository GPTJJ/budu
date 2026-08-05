// ============================================================
// BUDU 运营系统 · 首页概览模拟数据
// ============================================================

// 门店经营排行榜
export const storeRanking = [
  { rank: 1, name: '北京通盈中心店', city: '朝阳区 · 三里屯', revenue: 1286540, margin: 26.8, efficiency: 2186, change: '+12.4%' },
  { rank: 2, name: '北京官舍店', city: '朝阳区 · 亮马桥', revenue: 1152300, margin: 24.1, efficiency: 1972, change: '+9.8%' },
  { rank: 3, name: '北京西单店', city: '西城区 · 西单', revenue: 986720, margin: 22.6, efficiency: 1865, change: '+7.2%' },
  { rank: 4, name: '北京朝外店', city: '朝阳区 · 朝外大街', revenue: 864190, margin: 20.4, efficiency: 1642, change: '-2.1%' },
  { rank: 5, name: '成都大悦城okay店', city: '武侯区 · 大悦城', revenue: 752460, margin: 19.8, efficiency: 1528, change: '+5.6%' },
]

// 营业额趋势：近 12 个月
export const revenueTrend = [
  { month: '8月', revenue: 86, orders: 5200 },
  { month: '9月', revenue: 92, orders: 5600 },
  { month: '10月', revenue: 88, orders: 5400 },
  { month: '11月', revenue: 103, orders: 6400 },
  { month: '12月', revenue: 118, orders: 7300 },
  { month: '1月', revenue: 132, orders: 8100 },
  { month: '2月', revenue: 128, orders: 7900 },
  { month: '3月', revenue: 121, orders: 7500 },
  { month: '4月', revenue: 134, orders: 8300 },
  { month: '5月', revenue: 118, orders: 7600 },
  { month: '6月', revenue: 124, orders: 7900 },
  { month: '7月', revenue: 128.6, orders: 8642 },
]

// 成本结构分析
export const costStructure = [
  { name: '产品成本', value: 35.0, color: '#F43F5E' },
  { name: '房租水电', value: 16.4, color: '#A855F7' },
  { name: '人工成本', value: 13.6, color: '#F472B6' },
  { name: '商场费用', value: 12.0, color: '#FBBF24' },
  { name: '营销费用', value: 9.2, color: '#34D399' },
  { name: '物料损耗', value: 7.4, color: '#60A5FA' },
  { name: '其他', value: 6.4, color: '#CBD5E1' },
]

// 员工绩效 TOP5
export const employeeTop5 = [
  { rank: 1, name: '林小满', store: '北京通盈中心店', revenue: 428600, salary: 42800, roi: 10.0, hours: 178 },
  { rank: 2, name: '周甜甜', store: '北京官舍店', revenue: 396200, salary: 39600, roi: 10.0, hours: 171 },
  { rank: 3, name: '陈一诺', store: '北京西单店', revenue: 368900, salary: 38200, roi: 9.7, hours: 165 },
  { rank: 4, name: '赵安安', store: '北京朝外店', revenue: 342700, salary: 36500, roi: 9.4, hours: 169 },
  { rank: 5, name: '孙悦然', store: '成都大悦城okay店', revenue: 318500, salary: 34900, roi: 9.1, hours: 162 },
]

// 商品销售 TOP10
export const productTop10 = [
  { rank: 1, name: '白桃乌龙千层', category: '蛋糕甜品', emoji: '🍑', sales: 3286, amount: 147870, price: 45 },
  { rank: 2, name: '芋泥波波舒芙蕾', category: '现制甜品', emoji: '🍠', sales: 2942, amount: 132390, price: 45 },
  { rank: 3, name: '草莓生巧大福', category: '日式和菓子', emoji: '🍓', sales: 2871, amount: 129195, price: 45 },
  { rank: 4, name: '芒果椰椰雪顶', category: '茶饮鲜果', emoji: '🥭', sales: 2634, amount: 105360, price: 40 },
  { rank: 5, name: '提拉米苏盒子', category: '蛋糕甜品', emoji: '☕', sales: 2488, amount: 104496, price: 42 },
  { rank: 6, name: '抹茶红豆华夫', category: '现烤烘焙', emoji: '🍵', sales: 2146, amount: 96570, price: 45 },
  { rank: 7, name: '桂花酒酿圆子', category: '中式糖水', emoji: '🌼', sales: 2215, amount: 88600, price: 40 },
  { rank: 8, name: '焦糖海盐泡芙', category: '现烤烘焙', emoji: '🧁', sales: 1982, amount: 79280, price: 40 },
  { rank: 9, name: '巴斯克芝士蛋糕', category: '蛋糕甜品', emoji: '🧀', sales: 1743, amount: 78435, price: 45 },
  { rank: 10, name: '黑糖珍珠奶茶', category: '茶饮鲜果', emoji: '🧋', sales: 1865, amount: 67140, price: 36 },
]

// 重要提醒
export const notifications = [
  {
    id: 1,
    tag: '库存',
    tagStyle: 'bg-rose-50 text-rose-500',
    bg: 'bg-rose-100',
    fg: 'text-rose-500',
    time: '10 分钟前',
    text: '「北京通盈中心店」草莓库存低于安全水位（剩余 12%），建议今日完成补货。',
  },
  {
    id: 2,
    tag: '财务',
    tagStyle: 'bg-amber-50 text-amber-600',
    bg: 'bg-amber-100',
    fg: 'text-amber-600',
    time: '1 小时前',
    text: '6 月商场费用账单已生成，请在 3 日内完成对账确认，避免影响次月结算。',
  },
  {
    id: 3,
    tag: '活动',
    tagStyle: 'bg-blue-50 text-blue-600',
    bg: 'bg-blue-100',
    fg: 'text-blue-600',
    time: '2 小时前',
    text: '「会员双倍积分周」活动将于本周五 20:00 自动上线，覆盖全部门店。',
  },
  {
    id: 4,
    tag: '人员',
    tagStyle: 'bg-purple-50 text-purple-600',
    bg: 'bg-purple-100',
    fg: 'text-purple-600',
    time: '4 小时前',
    text: '3 名员工本月排班尚未确认，请提醒对应店长在今日下班前提交。',
  },
  {
    id: 5,
    tag: '系统',
    tagStyle: 'bg-emerald-50 text-emerald-600',
    bg: 'bg-emerald-100',
    fg: 'text-emerald-600',
    time: '昨天 22:00',
    text: 'BUDU Operating System V1.0 已于今日完成例行更新，运行状态正常。',
  },
]