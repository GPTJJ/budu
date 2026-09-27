import { expect, test } from '@playwright/test'

test('Developer/Admin 售后处理记录安全说明与状态', async ({ page }) => {
  await page.goto('/tests/partner-after-sales-harness.html')
  await expect(page.getByRole('heading', { name: '售后处理' })).toBeVisible()
  await expect(page.getByText('秦皇岛合作商 · RPL-1')).toBeVisible()
  await page.getByLabel('AS-20260907-001处理说明').fill('照片已核验，开始处理')
  await page.getByRole('button', { name: '开始处理' }).click()
  await expect.poll(() => page.evaluate(() => window.__afterSalesTest.requests[0])).toEqual({ status: 'PROCESSING', reason: '照片已核验，开始处理', version: 1 })
  await expect(page.getByText('处理中')).toBeVisible()
  await expect(page.getByText('不会自动退款')).toBeVisible()
})

test('320px 售后处理页面无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 })
  await page.goto('/tests/partner-after-sales-harness.html')
  await expect(page.getByRole('heading', { name: '售后处理' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})
