function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

/** 将数据库中的“最终工资覆盖”应用到自动工资；金额输入/输出均为元。 */
export function applyDailyPayOverride(automaticPay, adjustment) {
  const auto = money(automaticPay)
  if (!adjustment) {
    return {
      automaticPay: auto,
      pay: auto,
      salaryAdjustment: 0,
      payAdjustment: null,
    }
  }
  const adjustedPay = money((Number(adjustment.adjustedPayCents) || 0) / 100)
  const snapshotPay = money((Number(adjustment.autoPayCentsSnapshot) || 0) / 100)
  return {
    automaticPay: auto,
    pay: adjustedPay,
    salaryAdjustment: money(adjustedPay - auto),
    payAdjustment: {
      ...adjustment,
      autoPaySnapshot: snapshotPay,
      adjustedPay,
      recordedDifference: money(adjustedPay - snapshotPay),
    },
  }
}
