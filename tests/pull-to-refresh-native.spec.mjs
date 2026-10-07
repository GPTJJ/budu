import { expect, test } from '@playwright/test'

// CDP sends trusted touch input, so this verifies actual scrolling rather than
// treating synthetic TouchEvents/defaultPrevented assertions as a native drag.
async function swipe(session, x, y, dy) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy * step / 12 }] })
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('native Sidebar and main drags scroll independently without refresh', async ({ page, context }) => {
  await page.route('**/api/**', (route) => route.abort())
  await page.goto('/tests/pull-to-refresh-harness.html')
  await expect(page.getByTestId('current-view')).toHaveText('asset-center')
  const session = await context.newCDPSession(page)
  for (const name of ['人员管理', '门店经营', '库存调拨', '合作商管理']) {
    await page.locator('aside').getByRole('button', { name, exact: true }).tap()
  }
  const nav = page.locator('aside nav')
  await nav.evaluate((element) => { element.scrollTop = 0 })
  await swipe(session, 140, 550, -280)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const sidebarPosition = await nav.evaluate((element) => element.scrollTop)
  await swipe(session, 140, 250, 280)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeLessThan(sidebarPosition)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await page.evaluate(() => window.__refreshCount)).toBe(0)

  await swipe(session, 600, 700, -300)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  const mainPosition = await page.evaluate(() => window.scrollY)
  await swipe(session, 600, 300, 180)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(mainPosition)
  expect(await page.evaluate(() => window.__refreshCount)).toBe(0)

  await session.detach()
})

test('native fresh main-top pull refreshes once', async ({ page, context }) => {
  await page.route('**/api/**', (route) => route.abort())
  await page.goto('/tests/pull-to-refresh-harness.html')
  await expect(page.getByTestId('current-view')).toHaveText('asset-center')
  const session = await context.newCDPSession(page)
  await swipe(session, 600, 200, 220)
  await expect.poll(() => page.evaluate(() => window.__refreshCount)).toBe(1)
  await expect(page.getByText('刷新中…', { exact: true })).toBeVisible()
  await page.evaluate(() => window.__finishRefresh())
  await expect(page.getByText('刷新中…', { exact: true })).toHaveCount(0)
  await session.detach()
})
