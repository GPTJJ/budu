import { expect, test } from '@playwright/test'

async function enterPayment(page, url) {
  await page.goto(url)
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
}

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
  await page.getByPlaceholder('搜索商品名称 / SKU / 条码').fill('')
  await page.getByRole('button', { name: '蛋糕', exact: true }).click()
  await expect(page.getByRole('button', { name: /草莓奶油蛋糕/ })).toBeVisible()
  await expect(product).toHaveCount(0)
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await expect(product).toBeVisible()
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByText('合计 · 0 件', { exact: true })).toBeVisible()
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

test('iPad 横屏扫码窗口、连续识别与同码防重复提交', async ({ page }) => {
  const authCode = '134567890123456789'
  await enterPayment(page, `/tests/pos-harness.html?user=scanner-layout&codes=${authCode}&duplicate=1`)
  await page.getByRole('button', { name: '微信扫码', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '微信付款码扫码' })
  await expect(dialog).toBeVisible()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const scannerBox = await dialog.locator(':scope > div').boundingBox()
  expect(viewport).toEqual({ width: 1024, height: 768 })
  expect(scannerBox.width).toBeLessThanOrEqual(992)
  expect(scannerBox.height).toBeLessThanOrEqual(736)
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__paymentRequestCount)).toBe(1)
  expect(await page.evaluate(() => window.__cameraTrackStops)).toBeGreaterThan(0)
  expect(await page.evaluate((code) => JSON.stringify(sessionStorage).includes(code), authCode)).toBe(false)
})

test('相机权限拒绝时显示中文提示并可取消', async ({ page }) => {
  await enterPayment(page, '/tests/pos-harness.html?user=camera-denied&camera=denied')
  await page.getByRole('button', { name: '支付宝扫码', exact: true }).click()
  await expect(page.getByText(/相机权限被拒绝/)).toBeVisible()
  await page.getByRole('button', { name: '重新扫码', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__cameraStarts)).toBe(2)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('扫码时切后台会释放相机，返回后重新扫码', async ({ page }) => {
  await enterPayment(page, '/tests/pos-harness.html?user=camera-background&scanDelay=800')
  await page.getByRole('button', { name: '微信扫码', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByText(/页面已进入后台，摄像头已关闭/)).toBeVisible()
  expect(await page.evaluate(() => window.__cameraTrackStops)).toBeGreaterThan(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.getByRole('button', { name: '重新扫码', exact: true }).click()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__cameraStarts)).toBe(2)
})

test('模拟支付失败后可重新扫描新付款码', async ({ page }) => {
  await enterPayment(page, '/tests/pos-harness.html?user=camera-retry&codes=FAIL00000001,134567890123456789')
  await page.getByRole('button', { name: '微信扫码', exact: true }).click()
  await expect(page.getByText('模拟支付失败，请重新扫码', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '微信扫码', exact: true }).click()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__paymentRequestCount)).toBe(2)
})

test('支付处理中提示勿重复付款，关闭后可重新选择支付方式', async ({ page }) => {
  await enterPayment(page, '/tests/pos-harness.html?user=pending-close&paymode=pending')
  await page.getByRole('button', { name: '微信扫码', exact: true }).click()
  await expect(page.getByText('正在确认支付，请勿重复付款', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭当前支付', exact: true }).click()
  await expect(page.getByText('当前支付已关闭，可以重新选择支付方式', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '现金', exact: true }).click()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__paymentRequestCount)).toBe(2)
})
