/**
 * Gate 29G: Personnel 月度卡片只消费 resolver 已给出的金额字段。
 * 这里不计算工资，只读取 resolver 的精确字段；LEGACY 重名无法归属时
 * 继续返回 null，由卡片显示「—」。
 */
export function personnelMonthlyComponents(record = {}, { legacyAmbiguous = false } = {}) {
  if (legacyAmbiguous) {
    return {
      basePay: null,
      commission: null,
      transferSubsidy: null,
      bigBonus: null,
      salaryAdjustment: null,
      salary: null,
    }
  }

  return {
    basePay: record.basePay ?? 0,
    commission: record.commission ?? 0,
    transferSubsidy: record.transferSubsidy ?? 0,
    bigBonus: record.bigBonus ?? 0,
    salaryAdjustment: record.salaryAdjustment ?? 0,
    salary: record.salary ?? 0,
  }
}
