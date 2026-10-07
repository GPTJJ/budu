import { expect, test } from '@playwright/test'

const refreshUI = (page) => page.getByText(/^(下拉刷新|释放刷新|刷新中…)$/)
const refreshCount = (page) => page.evaluate(() => window.__refreshCount)

// Playwright WebKit exposes native tap, but no native touch-drag API. Dispatch
// TouchEvents in the real engine to test gesture ownership/default prevention;
// use browser wheel input separately to verify the real Sidebar scroll container.
async function startTouch(page, { x, y, selector } = {}) {
  await page.evaluate(({ x, y, selector }) => {
    const target = selector ? document.querySelector(selector) : document.elementFromPoint(x, y)
    if (!target) throw new Error('Missing gesture target')
    const rect = target.getBoundingClientRect()
    window.__pullTouch = { target, x: x ?? rect.x + rect.width / 2, y: y ?? rect.y + rect.height / 2 }
  }, { x, y, selector })
  return dispatchTouch(page, 'touchstart')
}

async function dispatchTouch(page, type, point) {
  return page.evaluate(({ type, point }) => {
    const state = window.__pullTouch
    if (point) Object.assign(state, point)
    const touch = {
      identifier: 1, target: state.target,
      clientX: state.x, clientY: state.y,
      pageX: state.x + window.scrollX, pageY: state.y + window.scrollY,
      screenX: state.x, screenY: state.y,
    }
    const event = new TouchEvent(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [touch] },
      changedTouches: { value: [touch] },
    })
    state.target.dispatchEvent(event)
    return event.defaultPrevented
  }, { type, point })
}

async function drag(page, { x, y, dx = 0, dy = 200, selector }, { ignored = false } = {}) {
  await startTouch(page, { x, y, selector })
  const origin = await page.evaluate(() => ({ x: window.__pullTouch.x, y: window.__pullTouch.y }))
  for (let step = 1; step <= 6; step += 1) {
    const prevented = await dispatchTouch(page, 'touchmove', {
      x: origin.x + dx * step / 6, y: origin.y + dy * step / 6,
    })
    if (ignored) {
      expect(prevented, 'Native scrolling must retain the gesture').toBe(false)
      await expect(refreshUI(page)).toHaveCount(0)
    }
  }
  await dispatchTouch(page, 'touchend')
}

async function expectNoRefresh(page) {
  expect(await refreshCount(page)).toBe(0)
  await expect(refreshUI(page)).toHaveCount(0)
}

async function openSidebar(page) {
  if (page.viewportSize().width < 1024) await page.getByRole('button', { name: '切换侧栏' }).tap()
  await expect.poll(() => page.locator('aside').evaluate((element) => element.getBoundingClientRect().x)).toBe(0)
}

async function scrollableSidebar(page) {
  await openSidebar(page)
  for (const name of ['人员管理', '门店经营', '库存调拨', '合作商管理']) {
    await page.locator('aside').getByRole('button', { name, exact: true }).tap()
  }
  const nav = page.locator('aside nav')
  await expect.poll(() => nav.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200)
  await nav.evaluate((element) => { element.scrollTop = 0 })
  return nav
}

async function mainOrigin(page) {
  const origin = { x: page.viewportSize().width < 1024 ? 70 : 320, y: 180 }
  // Wait for any mobile Sidebar close animation before starting on the page.
  await expect.poll(() => page.evaluate(({ x, y }) => Boolean(
    document.elementFromPoint(x, y)?.closest('[data-testid="main-page"]'),
  ), origin)).toBe(true)
  return origin
}

async function finishRefresh(page) {
  await page.evaluate(() => window.__finishRefresh())
  await expect(refreshUI(page)).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  // Keep the harness isolated even if a child component starts an API request.
  await page.route('**/api/**', (route) => route.abort())
  await page.goto('/tests/pull-to-refresh-harness.html')
  await expect(page.getByTestId('current-view')).toHaveText('asset-center')
  await expect(page.locator('aside')).toHaveAttribute('data-pull-to-refresh-ignore', 'true')
  expect(await page.evaluate(() => 'ontouchstart' in window)).toBe(true)
})

test('Sidebar top drag never starts refresh or prevents menu scrolling', async ({ page }) => {
  const nav = await scrollableSidebar(page)
  await expect(nav).toHaveCSS('overflow-y', 'auto')
  await expect(nav).toHaveCSS('overscroll-behavior-y', 'contain')
  const box = await nav.boundingBox()
  await drag(page, { x: 120, y: box.y + 45 }, { ignored: true })
  await nav.hover()
  await page.mouse.wheel(0, -400)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBe(0)
  await page.mouse.wheel(0, 200)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expectNoRefresh(page)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('Sidebar middle scrolls both directions without background refresh', async ({ page }) => {
  const nav = await scrollableSidebar(page)
  await nav.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2 })
  const before = await nav.evaluate((element) => element.scrollTop)
  const box = await nav.boundingBox()
  await drag(page, { x: 120, y: box.y + 260, dy: -180 }, { ignored: true })
  await nav.hover()
  await page.mouse.wheel(0, 100)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(before)
  const after = await nav.evaluate((element) => element.scrollTop)
  await drag(page, { x: 120, y: box.y + 60 }, { ignored: true })
  await nav.hover()
  await page.mouse.wheel(0, -100)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeLessThan(after)
  await expectNoRefresh(page)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('Sidebar bottom overscroll never refreshes the background', async ({ page }) => {
  const nav = await scrollableSidebar(page)
  const bottom = await nav.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    return element.scrollHeight - element.clientHeight
  })
  const box = await nav.boundingBox()
  await drag(page, { x: 120, y: box.y + 260, dy: -180 }, { ignored: true })
  await nav.hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBe(bottom)
  await drag(page, { x: 120, y: box.y + 60 }, { ignored: true })
  await expectNoRefresh(page)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('exclusion covers menu SVG, text, blank space, brand and account area', async ({ page }) => {
  await scrollableSidebar(page)
  for (const selector of [
    'aside nav button svg', 'aside nav p', 'aside nav',
    'aside [data-testid="brand-slot"]', 'aside button[aria-label="打开账号菜单"]',
  ]) {
    await drag(page, { selector }, { ignored: true })
    await expectNoRefresh(page)
  }
  // Moving out of the Sidebar must not transfer ownership mid-gesture.
  await drag(page, { x: 120, y: 180, dx: 200, dy: 240 }, { ignored: true })
  await expectNoRefresh(page)
})

test('main page top still shows pull/release/refresh and refreshes exactly once', async ({ page }) => {
  const origin = await mainOrigin(page)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await startTouch(page, origin)
  expect(await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y + 60 })).toBe(true)
  await expect(page.getByText('下拉刷新', { exact: true })).toBeVisible()
  await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y + 200 })
  await expect(page.getByText('释放刷新', { exact: true })).toBeVisible()
  await dispatchTouch(page, 'touchend')
  expect(await refreshCount(page)).toBe(1)
  await expect(page.getByText('刷新中…', { exact: true })).toBeVisible()
  await drag(page, origin)
  expect(await refreshCount(page)).toBe(1)
  await finishRefresh(page)
})

test('main page below top does not refresh', async ({ page }) => {
  await page.evaluate(() => window.scrollTo(0, 400))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400)
  await drag(page, await mainOrigin(page), { ignored: true })
  await expectNoRefresh(page)
})

test('horizontal swipe cancels pull without refreshing', async ({ page }) => {
  await drag(page, { ...await mainOrigin(page), dx: 220, dy: 40 })
  await expectNoRefresh(page)
})

test('overlay blocks pulls and opening overlay cancels an active pull', async ({ page }) => {
  await page.evaluate(() => document.documentElement.classList.add('budu-overlay-open'))
  await drag(page, await mainOrigin(page), { ignored: true })
  await openSidebar(page)
  await drag(page, { selector: 'aside nav' }, { ignored: true })
  await expectNoRefresh(page)
  if (page.viewportSize().width < 1024) await page.getByRole('button', { name: '切换侧栏' }).tap()
  await page.evaluate(() => document.documentElement.classList.remove('budu-overlay-open'))
  const origin = await mainOrigin(page)
  await startTouch(page, origin)
  await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y + 200 })
  await expect(page.getByText('释放刷新', { exact: true })).toBeVisible()
  await page.evaluate(() => document.documentElement.classList.add('budu-overlay-open'))
  await expect(refreshUI(page)).toHaveCount(0)
  await dispatchTouch(page, 'touchend')
  await expectNoRefresh(page)
  await page.evaluate(() => document.documentElement.classList.remove('budu-overlay-open'))
  await drag(page, origin)
  expect(await refreshCount(page)).toBe(1)
  await finishRefresh(page)
})

for (const distance of [60, 200]) {
  test(`touchcancel at ${distance}px clears pull and next gesture works`, async ({ page }) => {
    const origin = await mainOrigin(page)
    await startTouch(page, origin)
    await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y + distance })
    await expect(refreshUI(page)).toBeVisible()
    await dispatchTouch(page, 'touchcancel')
    await expectNoRefresh(page)
    // A late move/end from the cancelled gesture cannot restart or refresh it.
    await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y + 240 })
    await dispatchTouch(page, 'touchend')
    await expectNoRefresh(page)
    await drag(page, origin)
    expect(await refreshCount(page)).toBe(1)
    await finishRefresh(page)
  })
}

test('real Sidebar navigation and mobile open/close remain usable', async ({ page }) => {
  await openSidebar(page)
  await page.locator('aside').getByRole('button', { name: '首页概览', exact: true }).tap()
  await expect(page.getByTestId('current-view')).toHaveText('overview')
  expect(await page.evaluate(() => window.__navigations)).toEqual(['overview'])
  if (page.viewportSize().width < 1024) {
    await expect.poll(() => page.locator('aside').evaluate((element) => element.getBoundingClientRect().right)).toBe(0)
    await openSidebar(page)
    await page.getByRole('button', { name: '关闭侧栏' }).tap({ position: { x: page.viewportSize().width - 20, y: 300 } })
    await expect.poll(() => page.locator('aside').evaluate((element) => element.getBoundingClientRect().right)).toBe(0)
  } else {
    expect(await page.locator('aside').evaluate((element) => element.getBoundingClientRect().x)).toBe(0)
  }
  await expectNoRefresh(page)
})

test('responsive Sidebar keeps scroll and has no horizontal overflow', async ({ page }) => {
  for (const width of [320, 340, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await page.reload()
    const nav = await scrollableSidebar(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    await drag(page, { selector: 'aside nav' }, { ignored: true })
    await nav.hover()
    await page.mouse.wheel(0, 150)
    await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expectNoRefresh(page)
  }
})

test('header and nested content scrolling never become page refresh', async ({ page }) => {
  await page.evaluate(() => {
    const main = document.querySelector('main')
    const header = document.createElement('header')
    header.id = 'gesture-header'
    header.textContent = 'Page header'
    main.before(header)
    const scroll = document.createElement('div')
    scroll.id = 'nested-scroll'
    scroll.style.cssText = 'height:160px;overflow-y:auto'
    scroll.innerHTML = '<div style="height:900px">Scrollable content</div>'
    main.append(scroll)
  })
  for (const selector of ['#gesture-header', '#nested-scroll div']) {
    await drag(page, { selector }, { ignored: true })
    await expectNoRefresh(page)
  }
  await page.locator('#nested-scroll').evaluate((element) => { element.scrollTop = 300 })
  await drag(page, { selector: '#nested-scroll div' }, { ignored: true })
  await expectNoRefresh(page)
})

test('upward scroll then reversal cannot hijack the same gesture for refresh', async ({ page }) => {
  const origin = await mainOrigin(page)
  await startTouch(page, origin)
  expect(await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y - 60 })).toBe(false)
  expect(await dispatchTouch(page, 'touchmove', { x: origin.x, y: origin.y + 220 })).toBe(false)
  await dispatchTouch(page, 'touchend')
  await expectNoRefresh(page)
})

test('right content scrolls in both directions after Sidebar gestures', async ({ page }) => {
  await scrollableSidebar(page)
  await drag(page, { selector: 'aside nav' }, { ignored: true })
  if (page.viewportSize().width < 1024) await page.getByRole('button', { name: '切换侧栏' }).tap()
  const origin = await mainOrigin(page)
  await drag(page, { ...origin, dy: -160 }, { ignored: true })
  await page.mouse.move(origin.x, origin.y)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
  const before = await page.evaluate(() => window.scrollY)
  await drag(page, origin, { ignored: true })
  await page.mouse.wheel(0, -160)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(before)
  await expectNoRefresh(page)
})


test('multi-touch and non-cancelable native scrolling cancel pending refresh', async ({ page }) => {
  const origin = await mainOrigin(page)
  for (const kind of ['multi', 'native']) {
    await startTouch(page, origin)
    await page.evaluate(({ kind, origin }) => {
      const target = window.__pullTouch.target
      const event = new TouchEvent('touchmove', { bubbles: true, cancelable: kind !== 'native' })
      const touch = { identifier: 1, target, clientX: origin.x, clientY: origin.y + 220 }
      Object.defineProperty(event, 'touches', { value: kind === 'multi' ? [touch, { ...touch, identifier: 2 }] : [touch] })
      target.dispatchEvent(event)
    }, { kind, origin })
    await dispatchTouch(page, 'touchend')
    await expectNoRefresh(page)
  }
  await drag(page, origin)
  expect(await refreshCount(page)).toBe(1)
  await finishRefresh(page)
})
