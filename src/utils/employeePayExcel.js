import * as XLSX from 'xlsx'

const PAY_NOTE = '基础工资=基础时薪×工时；提成=提成时薪×工时；调货补贴=2026-08-01起官舍值班工时×2元；大单奖=订单金额×5%；当日工资=基础工资+提成+调货补贴+大单奖；1人值班按门店标准工时，2人及以上各8h；节假日/调休按2026年规则计算；未录入日期计0。'

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function safeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
}

function applyNumberFormat(sheet, range, columns, format) {
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (const column of columns) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell && cell.t === 'n') cell.z = format
    }
  }
}

export function createEmployeePayWorkbook({ employeeName, periodLabel, dayRows, totals }) {
  const header = ['日期', '值班门店', '营业额(元)', '订单', '工时(h)', '基础工资(元)', '业绩提成(元)', '调货补贴(元)', '大单奖(元)', '当日工资(元)']
  const detailRows = dayRows.map((row) => [
    row.day,
    row.stores || '',
    money(row.revenue),
    money(row.orders),
    money(row.hours),
    money(row.basePay),
    money(row.commission),
    money(row.transferSubsidy),
    money(row.bigBonus),
    money(row.pay),
  ])
  const totalRow = [
    '合计',
    '',
    money(totals.revenue),
    money(totals.orders),
    money(totals.hours),
    money(totals.basePay),
    money(totals.commission),
    money(totals.transferSubsidy),
    money(totals.bigBonus),
    money(totals.pay),
  ]
  const sheet = XLSX.utils.aoa_to_sheet([
    ['BUDU 员工工资明细'],
    ['员工', employeeName],
    ['期间', periodLabel],
    [],
    header,
    ...detailRows,
    totalRow,
    [],
    ['计算说明', PAY_NOTE],
  ])
  const headerRow = 4
  const totalRowIndex = headerRow + 1 + detailRows.length
  const tableRange = { s: { r: headerRow + 1, c: 0 }, e: { r: totalRowIndex, c: header.length - 1 } }
  sheet['!cols'] = [
    { wch: 13 }, { wch: 24 }, { wch: 13 }, { wch: 10 }, { wch: 10 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
  ]
  sheet['!rows'] = [{ hpt: 26 }, { hpt: 20 }, { hpt: 20 }, { hpt: 8 }, { hpt: 22 }]
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
    { s: { r: totalRowIndex + 2, c: 1 }, e: { r: totalRowIndex + 2, c: 9 } },
  ]
  sheet['!autofilter'] = { ref: `A${headerRow + 1}:J${totalRowIndex + 1}` }
  applyNumberFormat(sheet, tableRange, [2, 5, 6, 7, 8, 9], '¥#,##0.00')
  applyNumberFormat(sheet, tableRange, [3, 4], '0.00')

  const workbook = XLSX.utils.book_new()
  workbook.Props = {
    Title: `BUDU 员工工资明细 - ${employeeName}`,
    Subject: periodLabel,
    Author: 'BUDU Operating System',
    CreatedDate: new Date(),
  }
  XLSX.utils.book_append_sheet(workbook, sheet, '工资明细')
  return workbook
}

export function employeePayExcelFileName(employeeName, periodKey) {
  return `工资明细-${safeFilePart(employeeName)}-${safeFilePart(periodKey)}.xlsx`
}

export function downloadEmployeePayExcel(options) {
  const workbook = createEmployeePayWorkbook(options)
  XLSX.writeFile(workbook, employeePayExcelFileName(options.employeeName, options.periodKey))
}
