import { expect, test } from '@playwright/test'

test('订单记录页展示列表、筛选、明细与导出', async ({ page }) => {
  await page.goto('/tests/order-records-harness.html')
  await expect(page.getByText('共 2 笔订单', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-001', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-002', { exact: true })).toBeVisible()

  await page.getByLabel('支付方式').selectOption('cash')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await expect(page.getByText('共 1 笔订单', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-001', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-ORDER-002', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: /明细/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('卡皮巴拉布丁', { exact: true })).toBeVisible()
  await expect(dialog.getByText('PAY-TEST-1', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 Excel', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/budu订单记录_.+\.xlsx/)
})
