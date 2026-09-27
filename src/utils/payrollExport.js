const r2 = (value) => Math.round((Number(value) || 0) * 100) / 100

/** Export rows are projections of the resolver result; no salary formula runs here. */
export function buildPayrollExportRows(resolverResult, employees, selectedIds) {
  const empById = new Map(employees.map((employee) => [employee.id, employee]))
  const periodColumns = {
    周期类型: resolverResult.periodTypeCode,
    周期开始: resolverResult.periodStart,
    周期结束: resolverResult.periodEnd,
  }
  const selected = new Set(selectedIds)
  const records = (resolverResult.payroll.employees || []).filter((record) => selected.has(record.employeeId))
  const detailRows = records.flatMap((record) => {
    const employee = empById.get(record.employeeId)
    return (record.dailyExplanations || []).map((row) => ({
      ...periodColumns,
      日期: row.date,
      'Employee.id': record.employeeId,
      员工编号: employee?.employeeNo || '',
      员工姓名: employee?.name || record.displayName || '',
      门店: row.storeName || row.storeKey || '',
      '门店营业额(元)': r2(row.explanation?.rawStoreRevenue),
      '个人业绩分摊(元)': r2(row.explanation?.displayWorkedRevenue),
      参与人数: row.explanation?.participantCount ?? '',
      '计薪工时(h)': r2(row.payableHours ?? row.hours),
      工时来源: row.payableHoursSource || row.explanation?.payableHoursSource || '',
      '基础时薪(元/h)': row.baseRate == null ? '' : r2(row.baseRate),
      '基础工资(元)': r2(row.basePay),
      '提成时薪(元/h)': row.commissionRate == null ? '' : r2(row.commissionRate),
      '业绩提成(元)': r2(row.commission),
      '调货补贴(元)': r2(row.transferSubsidy),
      '大单奖(元)': r2(row.bigBonus),
      '自动工资(元)': r2(row.automaticPay),
      '薪资调整(元)': r2(row.salaryAdjustment),
      调整原因: row.explanation?.adjustment?.reason || '',
      '最终工资(元)': r2(row.finalPay),
    }))
  })
  const summaryRows = records.map((record) => {
    const employee = empById.get(record.employeeId)
    return {
      ...periodColumns,
      'Employee.id': record.employeeId,
      员工编号: employee?.employeeNo || '',
      员工姓名: employee?.name || record.displayName || '',
      类型: employee ? (employee.type === 'fulltime' ? '全职人员' : '兼职人员') : '',
      期间值班门店: (record.storesWorked || []).join('、'),
      出勤天数: record.days || 0,
      '营业额(元)': r2(record.workedRevenue),
      订单: r2(record.orders),
      '计薪工时(h)': r2(record.payableHours),
      '基础工资(元)': r2(record.basePay),
      '业绩提成(元)': r2(record.commission),
      '调货补贴(元)': r2(record.transferSubsidy),
      '大单奖(元)': r2(record.bigBonus),
      '自动工资(元)': r2(record.salary - record.salaryAdjustment),
      '薪资调整(元)': r2(record.salaryAdjustment),
      '工资合计(元)': r2(record.salary),
    }
  })
  return { detailRows, summaryRows }
}
