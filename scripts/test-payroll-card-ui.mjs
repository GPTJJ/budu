// Gate 29J：工资卡只格式化 Gate29I 权威元数据，不在 UI 重算工资。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const {
  PayrollDailyList,
  PayrollMonthlySummary,
} = await vite.ssrLoadModule('/src/components/payroll/EmployeePayrollPresentation.jsx')

const monthly = {
  basePay: 1000,
  commission: 300,
  transferSubsidy: 20,
  bigBonus: 80,
  salaryAdjustment: 50,
  salary: 1450,
  workedDays: 12,
  hours: 88,
  workedRevenue: 12345,
}

const normal = {
  employeeId: 'emp-A',
  date: '2026-08-10',
  storeKey: 'tongying',
  storeName: '北京通盈中心店',
  hours: 8,
  baseRate: 30,
  basePay: 240,
  commissionRate: 5,
  commission: 40,
  transferSubsidyRate: 0,
  transferSubsidy: 0,
  bigBonus: 0,
  automaticPay: 280,
  salaryAdjustment: 0,
  finalPay: 280,
  explanation: {
    state: 'NORMAL', payableHours: 8, payableHoursSource: 'ACTUAL_HOURS', participantCount: 1,
    rawStoreRevenue: 2050, displayWorkedRevenue: 2050, commissionBasis: 2050,
    calculationDayPolicy: 'WORKDAY_POLICY', baseRate: 30, basePay: 240,
    commissionTarget: 2000, commissionRate: 5, commission: 40,
    transferSubsidyRate: 0, transferSubsidy: 0, bigOrderBonuses: [], adjustment: null,
  },
}

{
  const html = renderToStaticMarkup(React.createElement(PayrollMonthlySummary, {
    employee: monthly,
    monthText: '2026年08月',
  }))
  for (const text of ['本月最终工资', '¥1,450.00', '基础工资', '¥1,000.00', '业绩提成', '¥300.00', '大单奖', '¥80.00', '工资调整', '+¥50.00']) {
    assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal((html.match(/¥380\.00/g) || []).length, 0, '提成不得重新合并大单奖')
  console.log('  [月卡] 最终工资优先 + 组件分列 PASS')
}

{
  const html = renderToStaticMarkup(React.createElement(PayrollDailyList, { records: [normal] }))
  assert.match(html, /8月10日/)
  assert.match(html, /实际计薪 8h/)
  assert.match(html, /¥280\.00/)
  assert.match(html, /查看详情/)
  assert.doesNotMatch(html, /提成目标/, '默认折叠不堆叠详细字段')
  console.log('  [日卡] 默认折叠只显示日期/门店/工时/最终工资 PASS')
}

{
  const noData = renderToStaticMarkup(React.createElement(PayrollDailyList, { records: [] }))
  assert.match(noData, /暂无工资数据/)
  assert.doesNotMatch(noData, /¥0/)
  const legacy = renderToStaticMarkup(React.createElement(PayrollDailyList, {
    legacyLimited: true,
    legacyRows: [{ day: '08-10', stores: '通盈中心', hours: 12, pay: 420, hasData: true }],
  }))
  assert.match(legacy, /历史兼容数据，部分计算明细不可展示/)
  assert.doesNotMatch(legacy, /提成目标/)
  const ambiguous = renderToStaticMarkup(React.createElement(PayrollDailyList, { legacyAmbiguous: true }))
  assert.match(ambiguous, /同名员工工资归属无法确认/)
  console.log('  [空态/Legacy] 不造 ¥0 / 不猜稳定级明细 PASS')
}

{
  const presentationSource = fs.readFileSync(path.join(root, 'src/components/payroll/EmployeePayrollPresentation.jsx'), 'utf8')
  const personnelSource = fs.readFileSync(path.join(root, 'src/components/PersonnelPage.jsx'), 'utf8')
  assert.doesNotMatch(presentationSource, /baseRate\s*\*|commissionRate\s*\*|bonus\s*\/\s*0\.05|Math\.floor/)
  assert.doesNotMatch(presentationSource, /createdBy|updatedBy|operator|receipt image|POS订单/)
  assert.doesNotMatch(presentationSource, /fetch\s*\(|api\s*\(/)
  assert.match(personnelSource, /payrollDisplay\.byEmployeeId\.get\(d\.id\)/)
  assert.match(personnelSource, /dailyByEmployeeId\?\.get\(detailEmp\.id\)/)
  assert.doesNotMatch(personnelSource, /find\([^\n]*\.name\s*===/)
  console.log('  [安全] 无前端公式 / 无隐私字段 / 无展开请求 / Employee.id 路由 PASS')
}

console.log('GATE 29J EMPLOYEE PAYROLL CARD UI TEST OK')
await vite.close()
