/** 工资计算单测（含大单奖与「卡皮巴拉」不计工资规则）：node scripts/test-payroll.mjs */
import { monthlyPayrollFromEntries, isNoPayStaff, calcDailyPay } from '../src/utils/payroll.js'

if (!isNoPayStaff('卡皮巴拉') || isNoPayStaff('叶芷辰')) {
  throw new Error('卡皮巴拉特殊员工规则错误')
}

const daily = calcDailyPay({
  storeKey: 'tongying',
  storeName: '北京通盈中心店',
  revenue: 2500,
  date: '2026-08-07',
  staffCount: 2,
})
if (daily.basePay !== 224 || daily.commission !== 40 || daily.total !== 264) {
  throw new Error(`普通员工日薪计算错误: ${JSON.stringify(daily)}`)
}

const entries = {
  '2026-08|tongying|08-07': { inc: 2500, ord: 10, staff: ['卡皮巴拉', '叶芷辰'] },
}
const map = monthlyPayrollFromEntries(entries, '2026-08', { tongying: '北京通盈中心店' })
const capybara = map.get('卡皮巴拉')
const normal = map.get('叶芷辰')
console.log('卡皮巴拉:', JSON.stringify(capybara))
console.log('叶芷辰:', JSON.stringify(normal))
if (!capybara || capybara.salary !== 0 || capybara.basePay !== 0 || capybara.commission !== 0 || capybara.hours !== 8) {
  throw new Error('卡皮巴拉应只统计工时、不计算工资')
}
if (!normal || normal.salary !== 264 || normal.hours !== 8) {
  throw new Error('普通员工工资计算错误')
}

console.log('payroll OK')
