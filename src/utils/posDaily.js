const centsToYuan = (value) => Number(value || 0) / 100

/** 将 POS 每日分单位汇总转换为首页使用的元单位指标。 */
export function posDailyMetrics(row) {
  const inc = centsToYuan(row.incCents)
  const dis = centsToYuan(row.discountCents)
  const refund = centsToYuan(row.refundCents)
  const rev = row.originalSalesCents == null
    ? inc + dis + refund
    : centsToYuan(row.originalSalesCents)
  return { inc, dis, rev, ord: Number(row.ord) || 0 }
}

