import test from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { createEmployeePayWorkbook, employeePayExcelFileName } from '../src/utils/employeePayExcel.js'

const options = {
  employeeName: '测试/员工',
  periodLabel: '本周 2026-08-10 ~ 2026-08-16',
  periodKey: '20260810',
  dayRows: [
    {
      day: '08-10',
      stores: '北京通盈中心店',
      revenue: 1234.56,
      orders: 18,
      hours: 8,
      basePay: 160,
      commission: 40.5,
      transferSubsidy: 16,
      bigBonus: 20,
      pay: 236.5,
    },
  ],
  totals: {
    revenue: 1234.56,
    orders: 18,
    hours: 8,
    basePay: 160,
    commission: 40.5,
    transferSubsidy: 16,
    bigBonus: 20,
    pay: 236.5,
  },
}

test('员工工资明细生成真正的 Excel 工作簿与数值单元格', () => {
  const workbook = createEmployeePayWorkbook(options)
  assert.deepEqual(workbook.SheetNames, ['工资明细'])
  const sheet = workbook.Sheets['工资明细']
  assert.equal(sheet.A1.v, 'BUDU 员工工资明细')
  assert.equal(sheet.B2.v, '测试/员工')
  assert.equal(sheet.C6.v, 1234.56)
  assert.equal(sheet.C6.t, 'n')
  assert.equal(sheet.C6.z, '¥#,##0.00')
  assert.equal(sheet.H6.v, 16)
  assert.equal(sheet.J6.v, 236.5)
  assert.equal(sheet.A7.v, '合计')
  assert.equal(sheet.H7.v, 16)
  assert.equal(sheet.J7.v, 236.5)
  assert.equal(sheet['!autofilter'].ref, 'A5:J7')

  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  assert.ok(bytes.length > 1000)
  const parsed = XLSX.read(bytes, { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json(parsed.Sheets['工资明细'], { header: 1, raw: true })
  assert.deepEqual(rows[4], ['日期', '值班门店', '营业额(元)', '订单', '工时(h)', '基础工资(元)', '业绩提成(元)', '调货补贴(元)', '大单奖(元)', '当日工资(元)'])
  assert.equal(rows[5][1], '北京通盈中心店')
  assert.equal(rows[5][7], 16)
  assert.equal(rows[5][9], 236.5)
})

test('员工姓名中的文件系统非法字符会被安全替换', () => {
  assert.equal(employeePayExcelFileName('测试/员工', '2026:08'), '工资明细-测试-员工-2026-08.xlsx')
})
