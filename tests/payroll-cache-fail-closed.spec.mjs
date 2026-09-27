import { expect, test } from '@playwright/test'

test('P0 Personnel month load failure does not masquerade as valid zero payroll', async ({ page }) => {
  await page.goto('/tests/payroll-cache-fail-closed-harness.html')
  const card = page.locator('.card').filter({ hasText: '缓存测试员工' }).first()
  await expect(card).toBeVisible()
  await expect(card.getByText('工资数据暂不可用', { exact: true })).toBeVisible()
  await expect(card.getByText('出勤 —')).toBeVisible()
  await expect(card.getByText('ROI —')).toBeVisible()
  await expect(card).not.toContainText('¥0.00')
  await expect(card.getByRole('button', { name: '查看每日工资明细' })).toHaveCount(0)

  const before = await page.evaluate(() => window.__monthRequestCount)
  await card.getByRole('button', { name: '重新加载' }).click()
  await expect.poll(() => page.evaluate(() => window.__monthRequestCount)).toBeGreaterThan(before)
  await expect(card.getByText('工资数据暂不可用', { exact: true })).toBeVisible()
})
