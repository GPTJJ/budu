import { expect, test } from '@playwright/test'

for (const width of [320, 340, 375, 390, 430]) {
  test(`RC-6A operating cost completeness is readable at ${width}px WebKit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 })
    await page.goto('/tests/report-center-rc4-harness.html')
    await page.getByRole('button', { name: '经营利润' }).click()
    const panel = page.getByTestId('operating-profit-panel')
    await expect(panel).toContainText('预估经营利润')
    await expect(panel).toContainText('使用水电预估值')
    await expect(panel).toContainText('旧 DailyEntry 收入减 Expense 结果不是新经营利润权威')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

test('RC-6A missing COGS remains unavailable and explicit cost settings appear only for a selected store', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '经营利润' }).click()
  await page.getByLabel('报表门店').selectOption('guanshe')
  await expect(page.getByTestId('operating-profit-panel')).toContainText('缺少商品级销售与成本事实')
  await expect(page.getByTestId('operating-profit-panel')).toContainText('商品成本')
  await expect(page.getByTestId('operating-profit-panel')).toContainText('—')
  await expect(page.getByRole('heading', { name: /成本设置/ })).toBeVisible()
  await expect(page.getByLabel('社保分')).toHaveAttribute('placeholder', /0=确认零/)
})
