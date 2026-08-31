import { expect, test } from '@playwright/test'

for (const width of [320, 340, 375, 390, 430]) {
  test(`RC-6B estimated operating profit stays truthful at ${width}px WebKit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.goto('/tests/report-center-rc4-harness.html')
    await expect(page.getByTestId('dashboard-profit')).toContainText('预估经营利润')
    await page.getByTestId('dashboard-profit').click()
    const panel = page.getByTestId('operating-profit-panel')
    await expect(panel).toContainText('管理口径 · 不等同于财务会计利润')
    await expect(panel).toContainText('含预估成本')
    await expect(panel).toContainText('数据完整性')
    await expect(panel).toContainText('数据口径不可比')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

test('manual store COGS remains unavailable while known costs remain visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 })
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '经营利润' }).click()
  await page.getByLabel('报表门店').selectOption('guanshe')
  const panel = page.getByTestId('operating-profit-panel')
  await expect(panel).toContainText('暂不可计算')
  await expect(panel).toContainText('缺少商品级销售与成本事实')
  await expect(panel).toContainText('关键成本缺失时不会猜算经营利润')
  await expect(panel).toContainText('PAYROLL_ACTUAL_HOURS_ALLOCATION')
  await expect(panel).toContainText('STORE_RENT_HISTORY')
})

test('profit export uses the bounded server export endpoint', async ({ page }) => {
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '经营利润' }).click()
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__reportRequests.some((value) => value.includes('/report-center/operating-costs/export?')))).toBe(true)
})
