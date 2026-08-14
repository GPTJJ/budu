import { expect, test } from '@playwright/test'

async function beginSwipeRightFromEdge(page, { y = 400, distance = 120 } = {}) {
  await page.evaluate(({ y: clientY, distance: dx }) => {
    const target = document.elementFromPoint(8, clientY) || document.body
    const makeTouch = (clientX) => ({
      identifier: 1,
      target,
      clientX,
      clientY,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
    })
    window.__swipeBackTest = { target, makeTouch, clientY, distance: dx }
    const start = makeTouch(8)
    const move = makeTouch(8 + dx)
    const dispatch = (type, touches, changedTouches) => {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: changedTouches },
      })
      target.dispatchEvent(event)
    }
    dispatch('touchstart', [start], [start])
    dispatch('touchmove', [move], [move])
  }, { y, distance })
}

async function endSwipeRightFromEdge(page) {
  await page.evaluate(() => {
    const state = window.__swipeBackTest
    if (!state) return
    const move = state.makeTouch(8 + state.distance)
    const event = new TouchEvent('touchend', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: [] },
      changedTouches: { value: [move] },
    })
    state.target.dispatchEvent(event)
    delete window.__swipeBackTest
  })
}

async function swipeRightFromEdge(page, options) {
  await beginSwipeRightFromEdge(page, options)
  await endSwipeRightFromEdge(page)
}

async function enterPayment(page, url) {
  await page.goto(url)
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
}

test('iPad 横屏左订单右商品、快速加购、购物车和搜索', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=layout-user')
  await expect(page.getByRole('heading', { name: '当前订单' })).toBeVisible()
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    cart: document.querySelector('[data-testid="pos-cart-panel"]')?.getBoundingClientRect().toJSON(),
    catalog: document.querySelector('[data-testid="pos-catalog-panel"]')?.getBoundingClientRect().toJSON(),
  }))
  expect(layout.width).toBe(1024)
  expect(layout.height).toBe(768)
  expect(layout.scrollWidth).toBe(1024)
  expect(layout.scrollHeight).toBe(768)
  expect(layout.cart.x).toBe(0)
  expect(layout.cart.right).toBeLessThanOrEqual(layout.catalog.x + 1)
  expect(layout.cart.width).toBeGreaterThanOrEqual(390)
  expect(layout.catalog.width).toBeGreaterThan(layout.cart.width)

  const productGrid = await page.locator('[data-testid="pos-product-grid"]').evaluate((grid) => {
    const cards = [...grid.querySelectorAll('[data-testid="pos-product-card"]')].slice(0, 4)
    const cardRects = cards.map((card) => card.getBoundingClientRect().toJSON())
    const longName = grid.querySelector('[data-product-id="p-4"] [data-testid="pos-product-name"]')
    const longNameRect = longName.getBoundingClientRect()
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
      cardRects,
      longNameHeight: longNameRect.height,
      longNameClientHeight: longName.clientHeight,
      longNameScrollHeight: longName.scrollHeight,
    }
  })
  expect(productGrid.columns).toBe(3)
  expect(productGrid.cardRects).toHaveLength(4)
  expect(productGrid.cardRects[0].y).toBeCloseTo(productGrid.cardRects[1].y, 0)
  expect(productGrid.cardRects[1].y).toBeCloseTo(productGrid.cardRects[2].y, 0)
  expect(productGrid.cardRects[3].y).toBeGreaterThan(productGrid.cardRects[0].bottom)
  expect(productGrid.longNameHeight).toBeGreaterThan(30)
  expect(productGrid.longNameScrollHeight).toBeLessThanOrEqual(productGrid.longNameClientHeight + 1)

  const product = page.locator('main').getByRole('button', { name: /卡皮巴拉布丁/ })
  const productBox = await product.boundingBox()
  expect(productBox.height).toBeGreaterThanOrEqual(94)
  expect(productBox.height).toBeLessThanOrEqual(120)
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

  await page.setViewportSize({ width: 768, height: 1024 })
  await expect.poll(() => page.locator('[data-testid="pos-product-grid"]').evaluate((grid) => (
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length
  ))).toBe(3)
  await expect(page.locator('[data-product-id="p-4"] [data-testid="pos-product-name"]')).toBeVisible()
})

test('待支付、模拟支付和成功页刷新恢复', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=refresh-user')
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await expect(page.getByText('¥72.00', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '现金收款', exact: true }).click()
  await page.getByRole('dialog', { name: '现金收款确认' }).getByRole('button', { name: '确认收款', exact: true }).click()
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
  await pageA.locator('main').getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await pageB.locator('main').getByRole('button', { name: /草莓奶油蛋糕/ }).click()
  await pageB.locator('main').getByRole('button', { name: /草莓奶油蛋糕/ }).click()
  await expect(pageA.getByText('合计 · 1 件', { exact: true })).toBeVisible()
  await expect(pageB.getByText('合计 · 2 件', { exact: true })).toBeVisible()
  await contextA.close()
  await contextB.close()
})

test('iPad 横屏扫码窗口、连续识别与同码防重复提交', async ({ page }) => {
  const authCode = '134567890123456789'
  await enterPayment(page, `/tests/pos-harness.html?user=scanner-layout&codes=${authCode}&duplicate=1&scanDelay=250`)
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
  await page.getByRole('button', { name: '现金收款', exact: true }).click()
  await page.getByRole('dialog', { name: '现金收款确认' }).getByRole('button', { name: '确认收款', exact: true }).click()
  await expect(page.getByText('支付成功', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__paymentRequestCount)).toBe(2)
})

test('live 现金模式：微信/支付宝暂未开通，现金确认收款后完成订单', async ({ page }) => {
  await enterPayment(page, '/tests/pos-harness.html?user=cash-live&posmode=live')
  await expect(page.getByText('现金收款 · 当面确认后完成订单', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /微信扫码/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /支付宝扫码/ })).toBeDisabled()
  await page.getByRole('button', { name: '现金收款', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '现金收款确认' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('¥72.00', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认收款', exact: true }).click()
  await expect(page.getByText('现金已收款，订单已完成', { exact: true })).toBeVisible()
  await expect(page.getByText('支付方式', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__paymentRequestCount)).toBe(1)
})

test('手机端 POS：底部结算栏、分类横滑、购物车抽屉与结算', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/pos-harness.html?user=mobile-pos')
  await expect(page.getByRole('button', { name: /卡皮巴拉布丁/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '结算', exact: true })).toBeVisible()
  await expect(page.getByText('当前订单', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '蛋糕', exact: true }).click()
  await expect(page.getByRole('button', { name: /草莓奶油蛋糕/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /卡皮巴拉布丁/ })).toHaveCount(0)
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await expect(page.getByText('合计 · 1 件', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开购物车', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '购物车' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('当前订单', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await expect(page.getByText('¥72.00', { exact: true })).toBeVisible()
})

test('移动端右滑按页面层级返回，并释放扫码摄像头', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/tests/pos-harness.html?user=swipe-back&scanDelay=800')
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()

  await page.getByRole('button', { name: '打开购物车', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '购物车' })).toBeVisible()
  await beginSwipeRightFromEdge(page)
  const tracking = await page.evaluate(() => ({
    active: document.documentElement.classList.contains('swipe-back-active'),
    transform: getComputedStyle(document.getElementById('root')).transform,
    progress: Number(getComputedStyle(document.documentElement).getPropertyValue('--swipe-back-progress')),
  }))
  expect(tracking.active).toBe(true)
  expect(tracking.transform).not.toBe('none')
  expect(tracking.progress).toBeGreaterThan(0.5)
  await endSwipeRightFromEdge(page)
  await expect(page.getByRole('dialog', { name: '购物车' })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('swipe-back-active'))).toBe(false)

  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '微信扫码', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '微信付款码扫码' })).toBeVisible()
  await swipeRightFromEdge(page)
  await expect(page.getByRole('dialog', { name: '微信付款码扫码' })).toHaveCount(0)
  expect(await page.evaluate(() => window.__cameraTrackStops)).toBeGreaterThan(0)

  await swipeRightFromEdge(page)
  await expect(page.getByText('应付金额', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '结算', exact: true })).toBeVisible()
  await swipeRightFromEdge(page)
  await expect.poll(() => page.evaluate(() => window.__posExitCount)).toBe(1)
})

test('未付款返回后再次进入 POS 不直接跳付款页', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=return-bug')
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回点单', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '结算', exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByText('应付金额', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '结算', exact: true })).toBeVisible()
  await expect(page.getByText('合计 · 1 件', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回点单', exact: true }).click()
  await page.getByRole('button', { name: '退出 POS', exact: true }).click()
  await page.reload()
  await expect(page.getByText('应付金额', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '结算', exact: true })).toBeVisible()
})

test('POS 赠送/折扣/备注 对应减免并可结算', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=gift-discount')
  await page.getByRole('button', { name: /卡皮巴拉布丁/ }).click()
  await page.getByRole('button', { name: /草莓奶油蛋糕/ }).click()
  await expect(page.getByText('合计 · 2 件', { exact: true })).toBeVisible()
  await expect(page.getByText('¥110.00', { exact: true }).last()).toBeVisible()

  await page.getByRole('button', { name: '赠送 卡皮巴拉布丁', exact: true }).click()
  await expect(page.getByText('¥0.00 赠送', { exact: true })).toBeVisible()
  await expect(page.getByText('¥38.00', { exact: true }).last()).toBeVisible()

  await page.getByRole('button', { name: '9折', exact: true }).click()
  await expect(page.getByText('¥34.20', { exact: true })).toBeVisible()
  await expect(page.getByText('优惠 -¥75.80', { exact: true })).toBeVisible()

  await page.getByLabel('折扣输入').fill('8.5')
  await expect(page.getByText('¥32.30', { exact: true })).toBeVisible()
  await expect(page.getByText('优惠 -¥77.70', { exact: true })).toBeVisible()
  await page.getByPlaceholder('订单备注').fill('测试备注')

  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await expect(page.getByText('¥32.30', { exact: true })).toBeVisible()
})

test('POS 赠送商品再次单点按正常价加入（不再整行赠送）', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=gift-discount')
  await page.locator('main').getByRole('button', { name: /卡皮巴拉布丁/ }).first().click()
  await page.getByRole('button', { name: '赠送 卡皮巴拉布丁', exact: true }).click()
  await expect(page.getByText('¥0.00 赠送', { exact: true })).toBeVisible()

  await page.locator('main').getByRole('button', { name: /卡皮巴拉布丁/ }).first().click()
  await expect(page.getByText('合计 · 2 件', { exact: true })).toBeVisible()
  await expect(page.getByText('¥0.00 赠送', { exact: true })).toBeVisible()
  await expect(page.getByText('¥72.00', { exact: true }).last()).toBeVisible()

  await page.getByRole('button', { name: '结算', exact: true }).click()
  await expect(page.getByText('应付金额', { exact: true })).toBeVisible()
  await expect(page.getByText('¥72.00', { exact: true }).last()).toBeVisible()
})

test('POS 点单内可打开订单记录并返回', async ({ page }) => {
  await page.goto('/tests/pos-harness.html?user=pos-orders')
  await expect(page.getByPlaceholder('搜索商品名称 / SKU / 条码')).toBeVisible()
  await page.getByRole('button', { name: /订单记录/ }).click()
  await expect(page.getByText('订单记录', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('暂无符合条件的订单', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.getByPlaceholder('搜索商品名称 / SKU / 条码')).toBeVisible()
  await expect(page.getByRole('button', { name: /卡皮巴拉布丁/ })).toBeVisible()
})
