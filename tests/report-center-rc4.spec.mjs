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
  test(`RC-4 core reports remain coverage-aware and usable at ${width}px WebKit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 })
    await page.goto('/tests/report-center-rc4-harness.html')
    await expect(page.getByRole('heading', { name: '报表中心' })).toBeVisible()
    await page.getByRole('button', { name: '综合营业', exact: true }).click()
    await expect(page.getByTestId('report-metric-revenue')).toContainText('¥28,630.00')
    await expect(page.getByTestId('report-metric-grossSales')).toContainText('部分覆盖')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

    await page.getByTestId('report-metric-grossSales').getByRole('button', { name: '部分覆盖' }).click()
    const coverage = page.getByRole('dialog', { name: '数据覆盖说明' })
    await expect(coverage).toContainText('北京通盈中心店')
    await expect(coverage).toContainText('北京官舍店')
    await expect(page.locator('html')).toHaveClass(/budu-overlay-open/)
    await pullDown(coverage.locator('.budu-overlay-scroll'))
    await expect(page.getByTestId('page-refresh-count')).toHaveText('0')
    await expect(page.getByText('下拉刷新')).toHaveCount(0)
    await coverage.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/budu-overlay-open/)

    await page.getByRole('button', { name: '订单明细', exact: true }).click()
    const orderCard = page.getByRole('button').filter({ hasText: 'BUDU-20260831-MT001' }).first()
    await expect(orderCard).toBeVisible()
    await orderCard.click()
    const orderDetail = page.getByRole('dialog', { name: '订单明细' })
    await expect(orderDetail).toContainText('平台结算')
    await expect(orderDetail).not.toContainText('costPriceSnapshot')
    await orderDetail.getByRole('button', { name: '完成' }).click()

    await page.getByRole('button', { name: '商品销售', exact: true }).click()
    await expect(page.getByRole('button').filter({ hasText: '卡皮巴拉布丁' }).first()).toBeVisible()
    await page.getByRole('button').filter({ hasText: '卡皮巴拉布丁' }).first().click()
    const productDetail = page.getByRole('dialog', { name: '商品销售详情' })
    await expect(productDetail).toContainText('赠送金额')
    await expect(productDetail).toContainText('产品点单率')
    await productDetail.getByRole('button', { name: '关闭', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })
}

test('RC-4 unavailable is rendered as missing rather than zero', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '综合营业', exact: true }).click()
  await page.getByLabel('报表门店').selectOption('guanshe')
  await expect(page.getByTestId('report-metric-grossSales')).toContainText('暂无订单级数据')
  await expect(page.getByTestId('report-metric-grossSales')).toContainText('—')
  await expect(page.getByTestId('report-metric-grossSales')).not.toContainText('¥0.00')
})

test('RC-4 orders use server pagination and filters; product search/ranking stay server-side', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '订单明细', exact: true }).click()
  await page.getByLabel('订单来源').selectOption('MEITUAN')
  await page.getByLabel('结算方式').selectOption('PLATFORM')
  await expect.poll(() => page.evaluate(() => window.__reportRequests.some((value) => value.includes('orderSource=MEITUAN') && value.includes('settlementType=PLATFORM')))).toBe(true)
  await page.getByRole('button', { name: '下一页' }).click()
  await expect.poll(() => page.evaluate(() => window.__reportRequests.some((value) => value.includes('/report-center/orders?') && value.includes('page=2')))).toBe(true)

  await page.getByRole('button', { name: '商品销售', exact: true }).click()
  await page.getByLabel('搜索商品').fill('卡皮巴拉')
  await page.getByLabel('商品排序').selectOption('salesQuantity')
  await expect.poll(() => page.evaluate(() => window.__reportRequests.some((value) => value.includes('/report-center/products?') && value.includes('search=%E5%8D%A1%E7%9A%AE%E5%B7%B4%E6%8B%89') && value.includes('sort=salesQuantity')))).toBe(true)
  await expect(page.locator('table').last()).toContainText('产品点单率')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})

test('RC-4 preserved operational report entries navigate without rebuilding them', async ({ page }) => {
  await page.goto('/tests/report-center-rc4-harness.html')
  await page.getByRole('button', { name: '调拨报表' }).click()
  expect(await page.evaluate(() => window.__reportNavigate)).toBe('inventory-transfer')
  await page.getByRole('button', { name: '经营利润', exact: true }).click()
  await expect(page.getByRole('heading', { name: '经营利润（历史能力）' })).toBeVisible()
  await expect(page.getByText(/不是新经营利润权威/)).toBeVisible()
})
