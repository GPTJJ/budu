import { expect, test } from '@playwright/test'

async function selectDate(page, date) {
  await page.getByRole('button', { name: /2026年08月/ }).first().click()
  await page.getByRole('textbox', { name: '快速选择日期' }).fill(date)
}

test('Gate 29F DAY: 同店同名按 Employee.id 显示 A=264 / B=198', async ({ page }) => {
  await page.goto('/tests/gate29f-personnel-harness.html')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  await selectDate(page, '2026-08-10')
  await expect(page.getByText('按日', { exact: true })).toBeVisible()
  const cardA = page.locator('.card').filter({ hasText: 'A001' })
  const cardB = page.locator('.card').filter({ hasText: 'B001' })
  await expect(cardA).toContainText('当日工资')
  await expect(cardA).toContainText('¥264.00')
  await expect(cardA).toContainText('工时 8h')
  await expect(cardB).toContainText('¥198.00')
  await expect(cardB).toContainText('工时 6h')
})

test('Gate 29F WEEK: 8.31–9.6 同时加载两月且不重复', async ({ page }) => {
  await page.goto('/tests/gate29f-personnel-harness.html')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  await selectDate(page, '2026-08-31')
  await page.getByRole('button', { name: /2026年08月 · 08-31/ }).click()
  await page.getByRole('button', { name: '查看整周' }).click()
  await expect(page.getByText('按周', { exact: true })).toBeVisible()
  const cardA = page.locator('.card').filter({ hasText: 'A001' })
  const cardB = page.locator('.card').filter({ hasText: 'B001' })
  await expect(cardA).toContainText('周工资')
  await expect(cardA).toContainText('¥560.00')
  await expect(cardA).toContainText('工时 16h')
  await expect(cardB).toContainText('¥0.00')
  const calls = await page.evaluate(() => window.__attendanceCalls)
  expect(calls).toContain('2026-08')
  expect(calls).toContain('2026-09')
})

test('Gate 29G MONTH: 手工大单奖与提成分列，且同名 Employee.id 不串值', async ({ page }) => {
  await page.goto('/tests/gate29f-personnel-harness.html')
  await expect(page.getByText('稳定计算', { exact: true })).toBeVisible()
  const cardA = page.locator('.card').filter({ hasText: 'A001' })
  const cardB = page.locator('.card').filter({ hasText: 'B001' })
  await expect(cardA.locator('[data-stat-label="业绩提成"]')).toContainText('¥120.00')
  await expect(cardA.locator('[data-stat-label="大单奖"]')).toContainText('¥50.00')
  await expect(cardB.locator('[data-stat-label="业绩提成"]')).toContainText('¥30.00')
  await expect(cardB.locator('[data-stat-label="大单奖"]')).toContainText('¥0.00')
})
