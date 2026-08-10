import { expect, test } from '@playwright/test'

test('iPad 横屏三栏、快速加购、购物车和搜索', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=layout-user')
  await expect(page.getByRole('heading', { name: '当前订单' })).toBeVisible()
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(layout).toEqual({ width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 })

  const product = page.getByRole('button', { name: /卡皮巴拉布丁/ })
  for (let i = 0; i < 30; i += 1) await product.click()
  await expect(page.getByText('合计 · 30 件', { exact: true })).toBeVisible()
  await expect(page.getByText('¥2,160.00', { exact: true }).last()).toBeVisible()

  await page.locator('button:has(svg.lucide-plus)').last().click()
  await page.locator('button:has(svg.lucide-minus)').last().click()
  await expect(page.getByText('合计 · 30 件', { exact: true })).toBeVisible()
  await page.getByPlaceholder('搜索商品名称 / SKU / 条码').fill('690000000002')
  await expect(page.getByRole('button', { name: /草莓奶油蛋糕/ })).toBeVisible()
  await expect(product).toHaveCount(0)
})

test('待支付、模拟支付和成功页刷新恢复', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=refresh-user')
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await expect(page.getByText('¥72.00', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '现金', exact: true }).click()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  await expect(page.getByText('POS-TEST-refresh-user', { exact: true })).toBeVisible()
})

test('两个员工浏览器上下文的购物车互不串单', async ({ browser }) => {
  const contextA = await browser.newContext({ viewport: { width: 1024, height: 768 } })
  const contextB = await browser.newContext({ viewport: { width: 1024, height: 768 } })
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  await Promise.all([
    pageA.goto('http://127.0.0.1:5198/tests/pos-harness.html?user=employee-a'),
    pageB.goto('http://127.0.0.1:5198/tests/pos-harness.html?user=employee-b'),
  ])
  await pageA.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await pageB.getByRole('button', { name: /草莓奶油蛋糕/ }).click()
  await pageB.getByRole('button', { name: /草莓奶油蛋糕/ }).click()
  await expect(pageA.getByText('合计 · 1 件', { exact: true })).toBeVisible()
  await expect(pageB.getByText('合计 · 2 件', { exact: true })).toBeVisible()
  await contextA.close()
  await contextB.close()
})
