import { expect, test } from '@playwright/test'

async function openAtScrollPosition(page, name = '打开长弹层') {
  await page.goto('/tests/overlay-scroll-harness.html')
  await page.evaluate(() => window.scrollTo(0, 640))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(640)
  await page.getByRole('button', { name }).click()
  await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe('fixed')
}

for (const width of [320, 340, 375, 390, 430]) {
  test(`${width}px WebKit 顶部/底部 overscroll 不穿透且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openAtScrollPosition(page)
    const scroll = page.getByTestId('overlay-scroll')
    const header = page.getByTestId('overlay-header')
    const headerTop = (await header.boundingBox()).y
    await expect(scroll).toHaveCSS('overscroll-behavior-y', 'contain')
    await expect(scroll).toHaveCSS('touch-action', 'pan-y')
    await expect(page.getByTestId('overlay-root')).toHaveCSS('overflow', 'hidden')

    await scroll.evaluate((element) => { element.scrollTop = 0 })
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0)
    await scroll.hover()
    await page.mouse.wheel(0, -1800)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0)
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const bottom = await scroll.evaluate((element) => element.scrollHeight - element.clientHeight)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(bottom)
    await page.mouse.wheel(0, 1800)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(bottom)

    expect((await header.boundingBox()).y).toBe(headerTop)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    expect(await page.evaluate(() => document.body.style.top)).toBe('-640px')
    await page.getByRole('button', { name: '关闭父弹层' }).click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(640)
  })
}

test('嵌套 Dialog 关闭子层后父层继续锁定并保留内部位置', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await openAtScrollPosition(page)
  const scroll = page.getByTestId('overlay-scroll')
  await scroll.evaluate((element) => { element.scrollTop = 420 })
  await page.getByRole('button', { name: '打开子确认' }).click()
  await expect(page.getByRole('dialog', { name: '子确认' })).toBeVisible()
  await page.getByRole('button', { name: '关闭子确认' }).click()
  await expect(page.getByRole('dialog', { name: '子确认' })).toHaveCount(0)
  expect(await page.evaluate(() => document.body.style.position)).toBe('fixed')
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(420)
  await page.getByRole('button', { name: '完成' }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(640)
})

test('输入聚焦与 viewport 收缩后 header/footer/close 仍可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await openAtScrollPosition(page)
  await page.getByLabel('键盘输入测试').focus()
  await page.setViewportSize({ width: 390, height: 480 })
  await expect(page.getByRole('button', { name: '关闭父弹层' })).toBeVisible()
  await expect(page.getByRole('button', { name: '完成' })).toBeVisible()
  const footer = await page.getByTestId('overlay-footer').boundingBox()
  expect(footer.y + footer.height).toBeLessThanOrEqual(480)
  await page.getByRole('button', { name: '完成' }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(640)
})

test('legacy fixed overlay 接入共享锁，连续 20 次无残留状态', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await page.goto('/tests/overlay-scroll-harness.html')
  await page.evaluate(() => window.scrollTo(0, 640))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(640)
  for (let index = 0; index < 20; index += 1) {
    await page.getByRole('button', { name: '打开旧弹层' }).click()
    await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe('fixed')
    await page.getByRole('button', { name: '关闭旧弹层' }).click()
    await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe('')
  }
  expect(await page.evaluate(() => ({ classOpen: document.documentElement.classList.contains('budu-overlay-open'), overflow: document.body.style.overflow, top: document.body.style.top, y: window.scrollY }))).toEqual({ classOpen: false, overflow: '', top: '', y: 640 })
})

test('桌面居中与短内容弹层保持正常', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openAtScrollPosition(page, '打开短弹层')
  const dialog = page.getByRole('dialog', { name: '短内容弹层' })
  const box = await dialog.boundingBox()
  expect(box.width).toBeLessThanOrEqual(512)
  expect(Math.abs((box.x + box.width / 2) - 640)).toBeLessThan(2)
  await expect(dialog).toContainText('短内容仍保持单一滚动契约')
  await page.getByRole('button', { name: '完成' }).click()
})
