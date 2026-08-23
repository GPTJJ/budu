// 员工档案（EmployeeProfilePage）前端冒烟测试
// 覆盖：列表加载、详情 Tab、身份/银行卡掩码、reveal 二次确认 + 审计请求、
// 角色矩阵（developer 可 reveal；finance 可 reveal 银行卡但不可身份证；manager/staff 不可）、空态
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/employee-profile-harness.html?mode=developer')
})

test('列表展示员工卡片并可进入详情', async ({ page }) => {
  await expect(page.getByText('员工档案', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/BUDU-0001/)).toBeVisible()
  await expect(page.getByText(/隋晓/).first()).toBeVisible()
  await page.getByText(/隋晓/).first().click()
  await expect(page.getByRole('button', { name: '基本信息' })).toBeVisible()
  await expect(page.getByRole('button', { name: '身份信息' })).toBeVisible()
  await expect(page.getByRole('button', { name: '银行卡' })).toBeVisible()
  await expect(page.getByRole('button', { name: '履历时间线' })).toBeVisible()
  await expect(page.getByRole('button', { name: '附件' })).toBeVisible()
})

test('身份信息默认掩码，reveal 需确认并触发审计请求', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '身份信息' }).click()
  // 默认只显示掩码
  await expect(page.getByText('110101********1234', { exact: true })).toBeVisible()
  await expect(page.getByText('110101199001011234', { exact: true })).toHaveCount(0)
  // 点击查看完整号码 → 二次确认弹窗
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await expect(page.getByText('查看完整身份证号码')).toBeVisible()
  await expect(page.getByText(/记录一条审计日志/)).toBeVisible()
  await page.getByRole('button', { name: '确认查看' }).click()
  // 完整号码展示（内存中）
  await expect(page.getByText('110101199001011234', { exact: true })).toBeVisible()
  // reveal 请求已发出（即审计已在后端记录）
  const calls = await page.evaluate(() => window.__revealCalls)
  expect(calls).toContain('identity.reveal')
  // 可隐藏
  await page.getByRole('button', { name: '隐藏' }).click()
  await expect(page.getByText('110101199001011234', { exact: true })).toHaveCount(0)
})

test('银行卡掩码 + reveal 确认', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '银行卡' }).click()
  await expect(page.getByText('**** **** **** 3445', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await expect(page.getByText('查看完整银行卡号')).toBeVisible()
  await page.getByRole('button', { name: '确认查看' }).click()
  await expect(page.getByText('6222020200112233445', { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => window.__revealCalls)
  expect(calls).toContain('bank.reveal')
})

test('基本信息空字段显示「暂未填写」', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '基本信息' }).click()
  await expect(page.getByText('暂未填写', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('13800000000', { exact: true })).toBeVisible()
})

test('履历时间线展示入职与调薪记录', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '履历时间线' }).click()
  await expect(page.getByText(/入职/).first()).toBeVisible()
  await expect(page.getByText(/薪资调整/).first()).toBeVisible()
  await expect(page.getByText(/4000 → 4500/)).toBeVisible()
  await expect(page.getByText('操作人：budu')).toBeVisible()
})

test('工资考勤摘要展示只读数据', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '工资考勤' }).click()
  await expect(page.getByText('22 天', { exact: true })).toBeVisible()
  await expect(page.getByText('累计 176 小时')).toBeVisible()
  await expect(page.getByText('¥4500.00', { exact: true })).toBeVisible()
  await expect(page.getByText('已签收', { exact: true })).toBeVisible()
})

test('附件空态显示「暂未填写」', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '附件' }).click()
  await expect(page.getByText('暂未填写', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/上传附件（≤4MB）/).first()).toBeVisible()
})

test('角色矩阵：finance 可 reveal 银行卡、不可 reveal 身份证', async ({ page }) => {
  await page.goto('/tests/employee-profile-harness.html?mode=finance')
  await page.getByText(/隋晓/).first().click()
  // 身份证：无 reveal 按钮，显示无权限提示
  await page.getByRole('button', { name: '身份信息' }).click()
  await expect(page.getByText('110101********1234', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看完整号码' })).toHaveCount(0)
  await expect(page.getByText('无查看完整号码权限')).toBeVisible()
  // 银行卡：finance 可 reveal
  await page.getByRole('button', { name: '银行卡' }).click()
  await page.getByRole('button', { name: '查看完整号码' }).click()
  await page.getByRole('button', { name: '确认查看' }).click()
  await expect(page.getByText('6222020200112233445', { exact: true })).toBeVisible()
})

test('角色矩阵：manager 无 reveal 权限；staff 无模块访问', async ({ page }) => {
  // manager：可查看档案但不可 reveal
  await page.goto('/tests/employee-profile-harness.html?mode=manager')
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '身份信息' }).click()
  await expect(page.getByText('110101********1234', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看完整号码' })).toHaveCount(0)
  await expect(page.getByText('无查看完整号码权限')).toBeVisible()
  // staff：模块默认不开放，页面显示无权限
  await page.goto('/tests/employee-profile-harness.html?mode=staff')
  await expect(page.getByText('无权限访问员工档案')).toBeVisible()
})

test('开发者可发起离职操作（离职 ≠ 删除：确认弹窗提示档案保留）', async ({ page }) => {
  await page.getByText(/隋晓/).first().click()
  await page.getByRole('button', { name: '任职信息' }).click()
  await page.getByRole('button', { name: '离职' }).click()
  await expect(page.getByText('确认办理离职？')).toBeVisible()
  await expect(page.getByText(/离职 ≠ 删除/)).toBeVisible()
  await page.getByRole('button', { name: '确认离职' }).click()
  await expect(page.getByText(/已离职（履历已记录）/)).toBeVisible()
})
