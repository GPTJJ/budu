/**
 * 现行员工主档的轻量兜底配置。
 *
 * 这些是人员身份与全职/兼职设置，不是历史工资或经营报表。
 * 云端员工主档存在同名记录时，以云端记录为准；删除员工仍由 removedStaff 生效。
 */
export const BASE_EMPLOYEES = [
  { name: '隋晓', type: 'fulltime', storeKey: 'guanshe', storeName: '北京官舍店' },
  { name: '叶芷辰', type: 'fulltime', storeKey: 'tongying', storeName: '北京通盈中心店' },
  { name: '李飞燕', type: 'fulltime', storeKey: 'tongying', storeName: '北京通盈中心店' },
  { name: '左可翠', type: 'parttime', storeKey: 'chaowai', storeName: '北京朝外店' },
  { name: '陈文慧', type: 'parttime', storeKey: 'xidan', storeName: '北京西单店' },
  { name: '舒敏', type: 'parttime', storeKey: 'chaowai', storeName: '北京朝外店' },
  { name: '史璐璐', type: 'parttime', storeKey: 'chaowai', storeName: '北京朝外店' },
  { name: '马婧欣', type: 'parttime', storeKey: 'tongying', storeName: '北京通盈中心店' },
  { name: '龚艺锦', type: 'parttime', storeKey: 'guanshe', storeName: '北京官舍店' },
  { name: '王红云', type: 'parttime', storeKey: 'xidan', storeName: '北京西单店' },
]
