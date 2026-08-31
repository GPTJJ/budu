import { expect, test } from '@playwright/test'

async function pullDown(locator) {
  await locator.evaluate((target) => {
    const touch = (clientY) => ({ identifier: 1, target, clientX: 160, clientY, pageX: 160, pageY: clientY, screenX: 160, screenY: clientY })
    const dispatch = (type, touches, changedTouches) => {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } })
      target.dispatchEvent(event)
    }
    const start = touch(160); const end = touch(340)
    dispatch('touchstart', [start], [start]); dispatch('touchmove', [end], [end]); dispatch('touchend', [], [end])
  })
}

for (const width of [320, 340, 375, 390, 430]) {
  test(`RC-5 dashboard preserves today's partial reality at ${width}px WebKit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/tests/report-center-rc4-harness.html')
    await expect(page.getByRole('heading', { name: '报表中心' })).toBeVisible()
    await expect(page.getByTestId('today-pending-close')).toContainText('今日实时数据部分覆盖')
    await expect(page.getByTestId('today-pending-close')).toContainText('待闭店确认，未按 0 计入')
    await expect(page.getByTestId('dashboard-metric-revenue')).toContainText('¥28,630.00')
    await expect(page.getByTestId('dashboard-metric-revenue')).toContainText('基于 3 家可比门店')
    await expect(page.getByText('最终模型暂未配置')).toBeVisible()
    await expect(page.getByTestId('dashboard-trend').locator('[data-coverage-state="PARTIAL"]')).toBeVisible()
    await expect(page.getByTestId('dashboard-trend')).toContainText('不制造人工门店小时走势')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

test('RC-5 comparison mode and product ranking remain one dashboard projection', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByLabel('对比周期').selectOption('year')
  await expect.poll(() => page.evaluate(() => window.__reportRequests.some((value) => value.includes('/report-center/dashboard?') && value.includes('compare=year')))).toBe(true)
  await page.getByTestId('dashboard-product-top').getByRole('button', { name: '销量', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__reportRequests.some((value) => value.includes('/report-center/dashboard?') && value.includes('topSort=salesQuantity')))).toBe(true)
  await expect(page.getByTestId('dashboard-product-top')).toContainText('卡皮巴拉布丁')
})

test('RC-5 no prior data and historical gaps use distinct business states', async ({ page }) => {
  await page.goto('/tests/report-center-rc4-harness.html?scenario=no-prior')
  await expect(page.getByTestId('dashboard-metric-revenue')).toContainText('暂无上期数据')
  await page.goto('/tests/report-center-rc4-harness.html?scenario=incomparable')
  await expect(page.getByTestId('dashboard-metric-revenue')).toContainText('数据覆盖不可比')
  await page.goto('/tests/report-center-rc4-harness.html?scenario=historical')
  await expect(page.getByTestId('historical-incomplete')).toContainText('历史经营数据不完整')
  await expect(page.getByTestId('historical-incomplete')).not.toContainText('待闭店确认')
})

test('RC-5 dashboard drill-down reuses RC-4 reports', async ({ page }) => {
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '查看营业收入明细' }).click()
  await expect(page.getByTestId('report-metric-revenue')).toBeVisible()
  await page.getByRole('button', { name: '经营看板', exact: true }).click()
  await page.getByRole('button', { name: '查看订单数明细' }).click()
  await expect(page.getByText('BUDU-20260831-MT001').filter({ visible: true })).toBeVisible()
  await page.getByRole('button', { name: '经营看板', exact: true }).click()
  await page.getByTestId('dashboard-product-top').getByText('商品 TOP 5').click()
  await expect(page.getByText('卡皮巴拉布丁').filter({ visible: true }).first()).toBeVisible()
})

test('RC-5 coverage overlay locks page PTR and restores it after close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByTestId('dashboard-metric-grossSales').getByRole('button', { name: '部分覆盖' }).click()
  const coverage = page.getByRole('dialog', { name: '数据覆盖说明' })
  await expect(coverage).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/budu-overlay-open/)
  await pullDown(coverage.locator('.budu-overlay-scroll'))
  await expect(page.getByTestId('page-refresh-count')).toHaveText('0')
  await coverage.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('html')).not.toHaveClass(/budu-overlay-open/)
})
